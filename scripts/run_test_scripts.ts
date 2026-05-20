#!/usr/bin/env tsx
/**
 * Cross-runner: every .m script in `test_scripts/` is run through both
 * numbl (the language reference) and mtoc2's own CLI. Stdouts must
 * match byte-for-byte.
 *
 *   npx tsx scripts/run_test_scripts.ts                   # all scripts
 *   npx tsx scripts/run_test_scripts.ts foo.m bar.m       # specific files
 *   MTOC_TEST_CONCURRENCY=4 npx tsx scripts/run_test_scripts.ts
 *   MTOC_TEST_TIMEOUT_MS=60000 npx tsx scripts/run_test_scripts.ts
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { cpus } from "node:os";
import { PLOT_PREFIX } from "../src/utils/plotProtocol.js";

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const cliPath = join(repoRoot, "src", "cli.ts");
const numblCliPath = resolve(repoRoot, "..", "numbl", "src", "cli.ts");
const scriptsDir = join(repoRoot, "test_scripts");

/** Discovery rule:
 *  - `test_scripts/*.m` — each file is an entry (flat layout for
 *    single-file tests).
 *  - `test_scripts/<subdir>/main.m` — each subdir is a multifile
 *    test group with `main.m` as the entry. Sibling `.m` files are
 *    workspace files (picked up automatically by the CLI's
 *    `scanSiblings`); they are NOT entries on their own.
 *  This rule keeps flat tests working while letting multifile
 *  groups isolate their workspace from each other and from the
 *  flat tests. */
function discoverScripts(): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(scriptsDir)) {
    const p = join(scriptsDir, entry);
    const st = statSync(p);
    if (st.isFile() && entry.endsWith(".m")) {
      found.push(p);
    } else if (st.isDirectory()) {
      const main = join(p, "main.m");
      try {
        if (statSync(main).isFile()) found.push(main);
      } catch {
        // Subdir without main.m — silently skip.
      }
    }
  }
  return found.sort();
}

const TIMEOUT_MS = (() => {
  const fromEnv = process.env.MTOC_TEST_TIMEOUT_MS;
  if (fromEnv) {
    const n = Number.parseInt(fromEnv, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 30_000;
})();

const MAX_DIFF_LINES = 30;

/** Drops applied to every script's stdout before the per-script
 *  mask/drop directives. These cover sidecar protocols that mtoc2
 *  emits but numbl does not (the cross-runner's byte-for-byte
 *  invariant is preserved by stripping them on both sides — they
 *  never appear in numbl's output, so the regex is a no-op there).
 *
 *  Currently:
 *  - Plot dispatch records: `\x1emtoc2:plot\t{json}\n` per
 *    plotting builtin call. See `src/builtins/runtime/plot_dispatch.h`.
 */
const GLOBAL_DROPS: ReadonlyArray<RegExp> = [
  // The \x1e (RS) sentinel is deliberate — see plot_dispatch.h.
  // PLOT_PREFIX contains no regex metacharacters, so it's safe inline.
  new RegExp(`^${PLOT_PREFIX}.*\\n?`, "gm"),
];

async function captureStdout(cmd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, {
    maxBuffer: 16 * 1024 * 1024,
    timeout: TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  return stdout;
}

interface Captured {
  stdout: string;
  stderr: string;
}

/** Mtoc2 invocations run with `--check-leaks`, which builds the C with
 *  `-fsanitize=address`. Two stderr signals matter:
 *
 *  - A `LeakSanitizer:` report at exit means an `mtoc2_tensor_t` (or
 *    other owned buffer) was not freed. We pass `LSAN_OPTIONS=exitcode=0`
 *    so LSan still emits its report but does NOT swap the program's
 *    return value for its own — that way the binary exits 0 on a
 *    pure-leak run and stdio cleanup flushes normally (LSan's own
 *    `_exit()` would otherwise drop the program's buffered stdout).
 *    The caller checks stderr after the stdout match.
 *  - Any other ASan trigger (heap overflow, UAF, etc.) still aborts
 *    the binary with non-zero exit; execFile throws and that path is
 *    surfaced as a real error. */
async function captureMtoc2(scriptPath: string): Promise<Captured> {
  const args = ["tsx", cliPath, "run", "--check-leaks", scriptPath];
  const r = await execFileAsync("npx", args, {
    maxBuffer: 16 * 1024 * 1024,
    timeout: TIMEOUT_MS,
    killSignal: "SIGKILL",
    env: { ...process.env, LSAN_OPTIONS: "exitcode=0" },
  });
  return { stdout: r.stdout, stderr: r.stderr ?? "" };
}

function diff(expected: string, actual: string): string {
  const al = expected.split("\n");
  const bl = actual.split("\n");
  const max = Math.max(al.length, bl.length);
  const lines: string[] = [];
  let totalMismatch = 0;
  for (let i = 0; i < max; i++) {
    const av = al[i] ?? "";
    const bv = bl[i] ?? "";
    if (av === bv) continue;
    totalMismatch++;
    if (lines.length < MAX_DIFF_LINES) {
      lines.push(
        `  line ${i + 1}: numbl=${JSON.stringify(av)} mtoc=${JSON.stringify(bv)}`
      );
    }
  }
  if (totalMismatch > MAX_DIFF_LINES) {
    lines.push(
      `  … (${totalMismatch - MAX_DIFF_LINES} more differing line${totalMismatch - MAX_DIFF_LINES === 1 ? "" : "s"} suppressed; ${totalMismatch} total)`
    );
  }
  return lines.join("\n");
}

interface Result {
  name: string;
  status: "PASS" | "FAIL";
  detail: string | null;
  /** One log line per mask that fired (rendered after the PASS/FAIL
   *  status). Empty when no masks are declared by the script. */
  maskNotes: string[];
}

/** Parse `% mtoc2-test-mask: <regex>` and `% mtoc2-test-drop: <regex>`
 *  lines from the first 20 lines of the script.
 *
 *  - `mask` replaces each match with `[MASKED]` (keeps the rest of
 *    the line intact). Used when both runners produce a line but the
 *    contents vary in a known way — e.g. an elapsed time.
 *  - `drop` removes each matched line entirely (regex + trailing
 *    newline). Used when only one runner emits a banner-style line
 *    (e.g. numbl's `[matmul] using bridge: ...` printed on first
 *    matmul activation) that mtoc2 doesn't produce.
 *
 *  Both compile with `gm` flags so they normalize multiple matches.
 *  Invalid regex syntax raises at parse time. */
function parseMasks(scriptPath: string): {
  masks: RegExp[];
  drops: RegExp[];
} {
  let src: string;
  try {
    src = readFileSync(scriptPath, "utf8");
  } catch {
    return { masks: [], drops: [] };
  }
  const masks: RegExp[] = [];
  const drops: RegExp[] = [];
  // Scan only the leading comment block — first code/keyword line ends
  // directive parsing. Avoids the silent-drop failure mode where a
  // long preamble pushes directives below an arbitrary line cap.
  for (const rawLine of src.split("\n")) {
    const line = rawLine.trimEnd();
    if (line === "") continue;
    if (!/^\s*%/.test(line)) break;
    const maskMatch = line.match(/^\s*%\s*mtoc2-test-mask:\s*(.*)$/);
    if (maskMatch) {
      const pattern = maskMatch[1].trim();
      if (pattern !== "") masks.push(new RegExp(pattern, "gm"));
      continue;
    }
    const dropMatch = line.match(/^\s*%\s*mtoc2-test-drop:\s*(.*)$/);
    if (dropMatch) {
      const pattern = dropMatch[1].trim();
      if (pattern !== "") drops.push(new RegExp(pattern + "\\n?", "gm"));
      continue;
    }
  }
  return { masks, drops };
}

/** Apply masks then drops to `stdout` and return the normalized text
 *  plus a list of human-readable log lines describing what fired.
 *  Masks replace each match with `[MASKED]`; drops remove the entire
 *  matched line (including the trailing newline). */
function applyMasks(
  stdout: string,
  masks: ReadonlyArray<RegExp>,
  drops: ReadonlyArray<RegExp>
): { text: string; notes: string[] } {
  let text = stdout;
  const notes: string[] = [];
  // Global drops fire first so per-script directives see a stream
  // already normalized against sidecar protocols (plot dispatch).
  for (const re of GLOBAL_DROPS) {
    text = text.replace(re, "");
  }
  if (masks.length === 0 && drops.length === 0) {
    return { text, notes };
  }
  for (const re of masks) {
    let count = 0;
    text = text.replace(re, () => {
      count++;
      return "[MASKED]";
    });
    if (count > 0) {
      notes.push(
        `  -> masked ${count} match${count === 1 ? "" : "es"} via ${re}`
      );
    }
  }
  for (const re of drops) {
    let count = 0;
    text = text.replace(re, () => {
      count++;
      return "";
    });
    if (count > 0) {
      notes.push(
        `  -> dropped ${count} line${count === 1 ? "" : "s"} via ${re}`
      );
    }
  }
  return { text, notes };
}

async function runOne(scriptPath: string): Promise<Result> {
  const name = scriptPath.startsWith(repoRoot)
    ? scriptPath.slice(repoRoot.length + 1)
    : scriptPath;

  const { masks, drops } = parseMasks(scriptPath);

  let expectedRaw: string;
  try {
    expectedRaw = await captureStdout("npx", [
      "tsx",
      numblCliPath,
      "run",
      scriptPath,
    ]);
  } catch (e) {
    const msg = (e as Error).message.split("\n")[0];
    return {
      name,
      status: "FAIL",
      detail: `numbl errored: ${msg}`,
      maskNotes: [],
    };
  }

  let actual: Captured;
  try {
    actual = await captureMtoc2(scriptPath);
  } catch (e) {
    const err = e as Error & { stderr?: string };
    const tail = (err.stderr ?? "").trim();
    const head = err.message.split("\n")[0];
    const detail = tail
      ? `mtoc2 errored: ${head}\n${tail}`
      : `mtoc2 errored: ${head}`;
    return { name, status: "FAIL", detail, maskNotes: [] };
  }

  const expectedM = applyMasks(expectedRaw, masks, drops);
  const actualM = applyMasks(actual.stdout, masks, drops);
  // Surface combined notes (numbl-side then mtoc2-side) once per
  // script. The two sides should fire the same number of masks for a
  // well-written test — if they don't, the byte-for-byte compare will
  // still flag the divergence on the unmasked lines.
  const maskNotes: string[] = [];
  for (const n of expectedM.notes) maskNotes.push(`  numbl${n}`);
  for (const n of actualM.notes) maskNotes.push(`  mtoc2${n}`);

  if (actualM.text !== expectedM.text) {
    return {
      name,
      status: "FAIL",
      detail: diff(expectedM.text, actualM.text),
      maskNotes,
    };
  }
  if (actual.stderr.includes("LeakSanitizer:")) {
    return {
      name,
      status: "FAIL",
      detail: `LeakSanitizer reported leaks:\n${actual.stderr.trim()}`,
      maskNotes,
    };
  }
  return { name, status: "PASS", detail: null, maskNotes };
}

async function runPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
  onResult: (item: T, result: R, index: number) => void
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runWorker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      const r = await worker(items[i]);
      results[i] = r;
      onResult(items[i], r, i);
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    runWorker()
  );
  await Promise.all(workers);
  return results;
}

function parseConcurrency(): number {
  const fromEnv = process.env.MTOC_TEST_CONCURRENCY;
  if (fromEnv) {
    const n = Number.parseInt(fromEnv, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return Math.max(1, cpus().length);
}

async function main(): Promise<void> {
  if (!existsSync(numblCliPath)) {
    console.error(
      `Cross-runner needs numbl checked out as a sibling directory:\n` +
        `  expected: ${numblCliPath}`
    );
    process.exit(2);
  }

  const argv = process.argv.slice(2);
  const scripts =
    argv.length > 0 ? argv.map(a => resolve(a)) : discoverScripts();

  const concurrency = parseConcurrency();

  let pass = 0;
  let fail = 0;
  const failedNames: string[] = [];

  await runPool(scripts, concurrency, runOne, (_, r) => {
    if (r.status === "PASS") {
      pass++;
      console.log(`PASS ${r.name}`);
    } else {
      fail++;
      failedNames.push(r.name);
      console.log(`FAIL ${r.name}`);
      if (r.detail) console.log(r.detail);
    }
    for (const n of r.maskNotes) console.log(n);
  });

  console.log(
    `\n${pass} passed, ${fail} failed (${scripts.length} total, concurrency=${concurrency})`
  );
  if (failedNames.length > 0) {
    console.log(`failed: ${failedNames.join(" ")}`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main();

#!/usr/bin/env tsx
/**
 * mtoc2-only test runner. Every `.m` script in `test_scripts_mtoc2_only/`
 * compiles through mtoc2's CLI; its stdout is compared byte-for-byte
 * against a sibling `<script>.expected` file. Used for tests that
 * exercise features numbl does not implement (e.g. user-defined
 * `.mtoc2.js` builtins), so the numbl-oracle of `run_test_scripts.ts`
 * does not apply.
 *
 *   npx tsx scripts/run_test_scripts_mtoc2_only.ts                # all
 *   npx tsx scripts/run_test_scripts_mtoc2_only.ts foo.m bar.m    # specific
 *   MTOC_TEST_CONCURRENCY=4  npx tsx scripts/run_test_scripts_mtoc2_only.ts
 *   MTOC_TEST_TIMEOUT_MS=60000 npx tsx scripts/run_test_scripts_mtoc2_only.ts
 *
 * Each `<script>.m` requires a sibling `<script>.expected` text file
 * holding the expected stdout. A missing or empty `.expected` is an
 * error; if the script's correct output is "no stdout", use an
 * explicitly-empty `.expected` (zero-length file).
 *
 * The `% mtoc2-test-mask:` / `% mtoc2-test-drop:` directives are
 * honored on both the expected and actual streams, same as the
 * cross-runner. Global plot-dispatch drops are applied first so
 * scripts that exercise plotting builtins don't have to repeat the
 * drop directive.
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
const scriptsDir = join(repoRoot, "test_scripts_mtoc2_only");

/** Discovery rule — same as the cross-runner:
 *  - `*.m` at the top level is an entry.
 *  - `<subdir>/main.m` is the entry for a multifile group; sibling
 *    `.m` files are picked up by the CLI's `scanSiblings`.
 */
function discoverScripts(): string[] {
  const found: string[] = [];
  if (!existsSync(scriptsDir)) return found;
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

/** Global drops applied before per-script directives. Matches the
 *  cross-runner: plot-dispatch lines are sidecar protocol and never
 *  appear in expected outputs. */
const GLOBAL_DROPS: ReadonlyArray<RegExp> = [
  new RegExp(`^${PLOT_PREFIX}.*\\n?`, "gm"),
];

interface Captured {
  stdout: string;
  stderr: string;
}

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
        `  line ${i + 1}: expected=${JSON.stringify(av)} mtoc=${JSON.stringify(bv)}`
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
  maskNotes: string[];
}

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

function applyMasks(
  stdout: string,
  masks: ReadonlyArray<RegExp>,
  drops: ReadonlyArray<RegExp>
): { text: string; notes: string[] } {
  let text = stdout;
  const notes: string[] = [];
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

/** Locate the `.expected` sibling for a script. For top-level
 *  `foo.m`, that's `foo.expected`. For a multifile group's entry
 *  `<group>/main.m`, that's `<group>/main.expected` (the expected
 *  output lives alongside the entry, not in the parent directory). */
function expectedPathFor(scriptPath: string): string {
  return scriptPath.replace(/\.m$/, ".expected");
}

async function runOne(scriptPath: string): Promise<Result> {
  const name = scriptPath.startsWith(repoRoot)
    ? scriptPath.slice(repoRoot.length + 1)
    : scriptPath;

  const expectedPath = expectedPathFor(scriptPath);
  if (!existsSync(expectedPath)) {
    return {
      name,
      status: "FAIL",
      detail:
        `missing expected-output file: ${expectedPath.slice(repoRoot.length + 1)} ` +
        `(every script in test_scripts_mtoc2_only/ needs a sibling .expected file; ` +
        `use a zero-length file if the script should produce no stdout)`,
      maskNotes: [],
    };
  }

  const { masks, drops } = parseMasks(scriptPath);

  let expectedRaw: string;
  try {
    expectedRaw = readFileSync(expectedPath, "utf8");
  } catch (e) {
    const msg = (e as Error).message.split("\n")[0];
    return {
      name,
      status: "FAIL",
      detail: `failed to read expected: ${msg}`,
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
  const maskNotes: string[] = [];
  for (const n of expectedM.notes) maskNotes.push(`  expected${n}`);
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
  const argv = process.argv.slice(2);
  const scripts =
    argv.length > 0 ? argv.map(a => resolve(a)) : discoverScripts();

  if (scripts.length === 0) {
    console.log(
      `no scripts found in ${scriptsDir.slice(repoRoot.length + 1)}/`
    );
    process.exit(0);
  }

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

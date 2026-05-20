#!/usr/bin/env tsx
/**
 * All-modes cross-runner: every .m script in `test_scripts/` is run
 * through multiple backends (numbl as the language reference, plus
 * mtoc2's `--exec` modes) and every stdout must match byte-for-byte.
 * The active backend set lives in `ALL_MODES`; the tree-walking
 * interpreter is currently disabled there — see the comment on `Mode`
 * for why.
 *
 *   npx tsx scripts/run_test_scripts_all_modes.ts                # all
 *   npx tsx scripts/run_test_scripts_all_modes.ts foo.m bar.m    # specific
 *   MTOC_TEST_CONCURRENCY=4 npx tsx scripts/run_test_scripts_all_modes.ts
 *   MTOC_TEST_TIMEOUT_MS=60000 npx tsx scripts/run_test_scripts_all_modes.ts
 *
 * This is a commit-time gate alongside the c-aot-only cross-runner
 * (`scripts/run_test_scripts.ts`). Both must pass before a change
 * lands — the c-aot runner is the byte-for-byte oracle against
 * numbl; this all-modes runner ensures the interpreter and js-aot
 * backends don't quietly drift away from c-aot.
 *
 * Scripts that hit a backend gap (e.g. a builtin's `call` hook
 * isn't wired yet) declare it expected-to-fail via
 * `% mtoc2-test-xfail-<backend>: <reason>` so a clean run stays
 * clean and real regressions stand out.
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

interface Captured {
  stdout: string;
  stderr: string;
}

/** The backends each script is run through. `numbl` is the language
 *  reference; the `mtoc2_*` modes correspond to the `--exec MODE` flag
 *  on mtoc2's CLI (interpreter / js-aot / c-aot).
 *
 *  All three mtoc2 backends are active in `ALL_MODES`. Tests covering
 *  features still pending in a backend (e.g. complex tensor codegen
 *  in js-aot, LogicalMask slot reads in either non-C backend) will
 *  fail and surface in the runner output. The cross-runner script
 *  `run_test_scripts.ts` continues to gate the c-aot path against
 *  numbl byte-for-byte; the all-modes runner exists to track the
 *  other two against the same reference. */
type Mode = "numbl" | "mtoc2-interpreter" | "mtoc2-js-aot" | "mtoc2-c-aot";

const ALL_MODES: ReadonlyArray<Mode> = [
  "numbl",
  "mtoc2-interpreter",
  "mtoc2-js-aot",
  "mtoc2-c-aot",
];

/** Capture stdout (and stderr) for one (script, mode) pair.
 *
 *  Only the `mtoc2-c-aot` mode passes `--check-leaks`, which builds the
 *  C with `-fsanitize=address`. Two stderr signals matter on that
 *  path:
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
 *    surfaced as a real error.
 *
 *  The other backends have no equivalent leak instrumentation —
 *  interpreter and js-aot run inside Node where GC handles cleanup. */
async function captureForMode(
  scriptPath: string,
  mode: Mode
): Promise<Captured> {
  const baseOpts = {
    maxBuffer: 16 * 1024 * 1024,
    timeout: TIMEOUT_MS,
    killSignal: "SIGKILL" as const,
  };
  if (mode === "numbl") {
    const r = await execFileAsync(
      "npx",
      ["tsx", numblCliPath, "run", scriptPath],
      baseOpts
    );
    return { stdout: r.stdout, stderr: r.stderr ?? "" };
  }
  const execFlag =
    mode === "mtoc2-interpreter"
      ? "interpreter"
      : mode === "mtoc2-js-aot"
        ? "js-aot"
        : "c-aot";
  const args = ["tsx", cliPath, "run", "--exec", execFlag];
  if (mode === "mtoc2-c-aot") args.push("--check-leaks");
  args.push(scriptPath);
  const r = await execFileAsync("npx", args, {
    ...baseOpts,
    env: { ...process.env, LSAN_OPTIONS: "exitcode=0" },
  });
  return { stdout: r.stdout, stderr: r.stderr ?? "" };
}

function diff(
  expected: string,
  actual: string,
  expectedLabel: string,
  actualLabel: string
): string {
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
        `  line ${i + 1}: ${expectedLabel}=${JSON.stringify(av)} ${actualLabel}=${JSON.stringify(bv)}`
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
  /** One log line per xfail backend: either "xfail <mode>: <reason>"
   *  (the backend diverged as expected) or "STALE-XFAIL <mode>: ..."
   *  (the xfail directive can be removed). */
  xfailNotes: string[];
}

/** Map of mode → reason. An entry means the script declares that mode
 *  as expected-to-fail (compare against numbl is skipped). Built from
 *  `% mtoc2-test-xfail-<mode>: <reason>` directives. */
type XfailMap = Partial<Record<Exclude<Mode, "numbl">, string>>;

const XFAIL_SHORT_TO_FULL: Record<string, Exclude<Mode, "numbl">> = {
  interpreter: "mtoc2-interpreter",
  "js-aot": "mtoc2-js-aot",
  "c-aot": "mtoc2-c-aot",
};

/** Parse `% mtoc2-test-mask: <regex>`, `% mtoc2-test-drop: <regex>`,
 *  and `% mtoc2-test-xfail-<backend>: <reason>` lines from the top
 *  comment block of the script (scans until the first non-comment,
 *  non-blank line — no hard line-count cap).
 *
 *  - `mask` replaces each match with `[MASKED]` (keeps the rest of
 *    the line intact). Used when both runners produce a line but the
 *    contents vary in a known way — e.g. an elapsed time.
 *  - `drop` removes each matched line entirely (regex + trailing
 *    newline). Used when only one runner emits a banner-style line
 *    (e.g. numbl's `[matmul] using bridge: ...` printed on first
 *    matmul activation) that mtoc2 doesn't produce.
 *  - `xfail-<backend>` marks the named backend (`interpreter`,
 *    `js-aot`, `c-aot`) as expected-to-fail against numbl on this
 *    script. The compare for that backend is dropped; if it
 *    unexpectedly matches anyway, the runner emits a `STALE-XFAIL`
 *    note so the directive can be removed.
 *
 *  `mask`/`drop` regexes compile with `gm` flags so they normalize
 *  multiple matches. Invalid regex syntax raises at parse time. */
function parseDirectives(scriptPath: string): {
  masks: RegExp[];
  drops: RegExp[];
  xfails: XfailMap;
} {
  let src: string;
  try {
    src = readFileSync(scriptPath, "utf8");
  } catch {
    return { masks: [], drops: [], xfails: {} };
  }
  const masks: RegExp[] = [];
  const drops: RegExp[] = [];
  const xfails: XfailMap = {};
  for (const rawLine of src.split("\n")) {
    const line = rawLine.trimEnd();
    if (line === "") continue;
    // Scan only the leading comment block — first code/keyword line
    // ends directive parsing. (Otherwise every `%` mid-script would be
    // ambiguous with embedded prose, and a long preamble would silently
    // drop directives.)
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
    const xfailMatch = line.match(
      /^\s*%\s*mtoc2-test-xfail-([a-zA-Z0-9-]+):\s*(.*)$/
    );
    if (xfailMatch) {
      const short = xfailMatch[1];
      const full = XFAIL_SHORT_TO_FULL[short];
      if (!full) {
        throw new Error(
          `${scriptPath}: unknown xfail backend '${short}' (expected one of: ${Object.keys(
            XFAIL_SHORT_TO_FULL
          ).join(", ")})`
        );
      }
      const reason = xfailMatch[2].trim();
      if (reason === "") {
        throw new Error(
          `${scriptPath}: xfail-${short} requires a non-empty reason`
        );
      }
      xfails[full] = reason;
      continue;
    }
  }
  return { masks, drops, xfails };
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

  const { masks, drops, xfails } = parseDirectives(scriptPath);

  // Capture each backend serially within a script. Each backend spawns
  // one or more child processes (numbl: tsx; c-aot: tsx + cc + binary),
  // and the outer pool already runs `concurrency` scripts at once, so
  // parallelising the four modes inside one script would multiply
  // process counts beyond cpus().length and trigger spurious timeouts
  // / EAGAIN on a busy machine.
  const captures = new Map<Mode, Captured>();
  const errored: string[] = [];
  for (const mode of ALL_MODES) {
    try {
      captures.set(mode, await captureForMode(scriptPath, mode));
    } catch (e) {
      const err = e as Error & { stderr?: string };
      const tail = (err.stderr ?? "").trim();
      const head = err.message.split("\n")[0];
      // A spawn-level error on an xfail backend is an expected outcome.
      // Record an xfail-credited stderr-only capture so the downstream
      // compare loop treats this mode as xfail-skipped, and continue.
      if (mode !== "numbl" && xfails[mode]) {
        captures.set(mode, { stdout: "", stderr: tail });
        continue;
      }
      errored.push(
        tail ? `${mode} errored: ${head}\n${tail}` : `${mode} errored: ${head}`
      );
    }
  }
  if (errored.length > 0) {
    return {
      name,
      status: "FAIL",
      detail: errored.join("\n"),
      maskNotes: [],
      xfailNotes: [],
    };
  }

  // Apply masks/drops to each backend independently. A well-written
  // script's mask directives apply identically to every backend, so the
  // per-mode notes should match — if they don't, the byte-for-byte
  // compare below will still surface the divergence on unmasked lines.
  const normalized = new Map<Mode, { text: string; notes: string[] }>();
  for (const mode of ALL_MODES) {
    normalized.set(mode, applyMasks(captures.get(mode)!.stdout, masks, drops));
  }
  const maskNotes: string[] = [];
  for (const mode of ALL_MODES) {
    for (const n of normalized.get(mode)!.notes) {
      maskNotes.push(`  ${mode}${n}`);
    }
  }

  // numbl is the language reference: every mtoc2 backend's stdout
  // must match it byte-for-byte. We diff each diverging mode against
  // numbl rather than against each other so a single mtoc2-side bug
  // is reported once per affected backend. Backends marked xfail are
  // not allowed to fail the script but are flagged STALE-XFAIL if
  // they unexpectedly match.
  const reference = normalized.get("numbl")!.text;
  const divergent: string[] = [];
  const xfailNotes: string[] = [];
  for (const mode of ALL_MODES) {
    if (mode === "numbl") continue;
    const xfailReason = xfails[mode];
    const t = normalized.get(mode)!.text;
    const matches = t === reference;
    if (xfailReason !== undefined) {
      if (matches) {
        xfailNotes.push(
          `  STALE-XFAIL ${mode}: ${xfailReason} (matches numbl — remove the xfail directive)`
        );
      } else {
        xfailNotes.push(`  xfail ${mode}: ${xfailReason}`);
      }
      continue;
    }
    if (!matches) {
      divergent.push(`vs ${mode}:\n${diff(reference, t, "numbl", mode)}`);
    }
  }
  if (divergent.length > 0) {
    return {
      name,
      status: "FAIL",
      detail: divergent.join("\n"),
      maskNotes,
      xfailNotes,
    };
  }

  // LeakSanitizer instrumentation only fires on the c-aot backend
  // (the interpreter and js-aot paths run inside Node, where GC
  // handles cleanup of mtoc2's owned values). Skipped when c-aot is
  // xfail'd (we no longer trust its output).
  if (xfails["mtoc2-c-aot"] === undefined) {
    const cAotStderr = captures.get("mtoc2-c-aot")!.stderr;
    if (cAotStderr.includes("LeakSanitizer:")) {
      return {
        name,
        status: "FAIL",
        detail: `LeakSanitizer reported leaks (c-aot):\n${cAotStderr.trim()}`,
        maskNotes,
        xfailNotes,
      };
    }
  }
  return { name, status: "PASS", detail: null, maskNotes, xfailNotes };
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
    for (const n of r.xfailNotes) console.log(n);
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

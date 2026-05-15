#!/usr/bin/env tsx
/**
 * mtoc2 CLI entry. Three subcommands:
 *   run <script.m>                   translate + compile + execute
 *   eval "<code>"                    same but from an inline code string
 *   translate <script.m> [-o out.c]  emit C only
 *
 * For `run`, the script's directory is the workspace search path: every
 * sibling `.m` file is registered as a workspace file, so cross-file
 * calls (`helper(x)` → `helper.m`) resolve through numbl's vendored
 * resolver. For `eval`, the workspace is empty by default; pass
 * `--path <dir>` to add a search directory (mirrors numbl's
 * `numbl eval --path`).
 *
 * Mirrors numbl's CLI shape so the cross-runner sees the same
 * workspace and run-mode options from both runners.
 */

import {
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdtempSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

import { translateProject, type SourceFile } from "./translate.js";
import { translateCToJs } from "./cjs/index.js";
import { applyPlotRecord, newPlotDispatchState } from "./utils/plotAdapter.js";
import { PLOT_PREFIX } from "./utils/plotProtocol.js";
import type { PlotRecord } from "./utils/wasmRunner.worker.js";
import { createPlotHandler } from "../../numbl/src/cli-plot-handler.js";
import type { PlotInstruction } from "../../numbl/src/graphics/types.js";
import { buildCcArgs } from "./build.js";
import {
  isOptProfile,
  OPT_PROFILES,
  resolveOptSettings,
  type OptProfile,
  type OptSettings,
} from "./optProfile.js";

function usage(): never {
  console.error(
    [
      "usage:",
      "  mtoc2 run [--js] [--plot] [--check-leaks] [--dump-c <path>] [--dump-js <path>]",
      "    [--opt PROFILE] [--fast-math|--no-fast-math] [--threads N|auto]",
      "    [--path <dir>...] <script.m>",
      "  mtoc2 eval [--js] [--plot] [--check-leaks] [--dump-c <path>] [--dump-js <path>]",
      '    [--opt PROFILE] [--fast-math|--no-fast-math] [--threads N|auto]',
      '    [--path <dir>...] "<code>"',
      "  mtoc2 translate <script.m> [-o out.c]",
      "",
      `--opt PROFILE: one of ${OPT_PROFILES.join(", ")}.`,
      "    none       — fast-math off, threads 1 (single-threaded baseline)",
      "    safe       — fast-math off, threads auto (the default)",
      "    default    — same as safe",
      "    aggressive — fast-math on, threads auto (numerics may drift in the last few ulps)",
      "    `-O3 -march=native` is unconditional. `--fast-math`/`--no-fast-math` and",
      "    `--threads` override individual profile settings.",
    ].join("\n")
  );
  process.exit(2);
}

/** Recursively scan `dir` for sibling `.m` files. Descends into
 *  `+pkg/` namespace dirs (so `+pkg/foo.m` is picked up as `pkg.foo`)
 *  and `@Class/` class dirs. Mirrors numbl's `scanMFiles`
 *  ([../numbl/src/cli-scan.ts]) so the cross-runner sees the same
 *  workspace shape from both runners. `private/` directories aren't
 *  supported by mtoc2 yet, but we still descend so an `.m` inside one
 *  surfaces an `UnsupportedConstruct` at the call site rather than
 *  silently going missing. */
function scanSiblings(dir: string, excludeAbs: string): SourceFile[] {
  const out: SourceFile[] = [];
  function walk(current: string): void {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (
          entry.startsWith("+") ||
          entry.startsWith("@") ||
          entry === "private"
        ) {
          walk(full);
        }
        continue;
      }
      if (!st.isFile() || !entry.endsWith(".m")) continue;
      if (resolve(full) === excludeAbs) continue;
      out.push({ name: full, source: readFileSync(full, "utf8") });
    }
  }
  walk(dir);
  return out;
}

/** Lower-level translator. The caller assembles the workspace file
 *  list and search paths; both `translateFile` and `cmdEval` route
 *  through here so the in-memory-source path doesn't accidentally
 *  diverge from the on-disk one. */
function translateFiles(
  files: SourceFile[],
  mainName: string,
  searchPaths: string[],
  threads?: number | "auto"
): string {
  const result = translateProject(files, mainName, { searchPaths, threads });
  if (result.error) {
    const e = result.error;
    const file = e.fileName ?? mainName;
    const where =
      e.startOffset !== undefined ? ` (offset ${e.startOffset})` : "";
    console.error(`${file}: ${e.kind}: ${e.message}${where}`);
    process.exit(1);
  }
  return result.c ?? "";
}

function translateFile(
  scriptPath: string,
  extraPaths: string[] = [],
  threads?: number | "auto"
): string {
  const absScript = resolve(scriptPath);
  const source = readFileSync(absScript, "utf8");
  const dir = dirname(absScript);
  const files: SourceFile[] = [
    { name: absScript, source },
    ...scanSiblings(dir, absScript),
  ];
  const searchPaths = [dir];
  for (const p of extraPaths) {
    const abs = resolve(p);
    if (searchPaths.indexOf(abs) === -1) {
      searchPaths.push(abs);
      files.push(...scanSiblings(abs, absScript));
    }
  }
  return translateFiles(files, absScript, searchPaths, threads);
}

function translateInline(
  code: string,
  extraPaths: string[] = [],
  threads?: number | "auto"
): string {
  // "eval.m" is the same synthetic name numbl uses (`cmdEval` in
  // numbl/src/cli.ts) so diagnostics from the cross-runner reference
  // the same file in both runners.
  const evalName = "eval.m";
  const files: SourceFile[] = [{ name: evalName, source: code }];
  const searchPaths: string[] = [];
  for (const p of extraPaths) {
    const abs = resolve(p);
    if (searchPaths.indexOf(abs) === -1) {
      searchPaths.push(abs);
      files.push(...scanSiblings(abs, evalName));
    }
  }
  return translateFiles(files, evalName, searchPaths, threads);
}

interface RunOptions {
  /** Build the C output with `-fsanitize=address -g`. AddressSanitizer
   *  pulls in LeakSanitizer at exit on Linux, so any unfreed
   *  `mtoc2_tensor_t` (or other owned buffer) is reported on stderr
   *  and the process exits non-zero. ~2x slowdown; off by default,
   *  but the cross-runner enables it for every script. Ignored on the
   *  `--js` path (the JS runtime relies on GC; there are no manual
   *  frees to leak). */
  checkLeaks?: boolean;
  /** Start numbl's plot server on the first plotting call. The server
   *  serves numbl's `dist-plot-viewer` SPA and opens a browser tab;
   *  records arriving on the C binary's stdout get translated into
   *  numbl `PlotInstruction`s and pushed over SSE. Off by default —
   *  scripts that emit plot records still have those records stripped
   *  from stdout (so the user's console stays clean), they just aren't
   *  rendered anywhere. */
  plot?: boolean;
  /** Skip the `cc` step entirely: translate the emitted C to
   *  JavaScript via the vendored c2js (see `src/cjs/`) and run the
   *  resulting JS in a child `node` process. Plot records and stdout
   *  are intercepted the same way as the native path — the JS runtime
   *  writes the same `\x1emtoc2:plot\t...` lines via `process.stdout`. */
  js?: boolean;
  /** If set, write the translated C source to this path before
   *  compiling / translating to JS. Useful for inspecting what mtoc2
   *  produced without re-running `translate`. */
  dumpC?: string;
  /** If set, write the c2js-translated JavaScript source to this path
   *  before running it. Only meaningful with `--js`. */
  dumpJs?: string;
  /** Resolved optimization settings — profile defaults composed with
   *  any explicit `--fast-math` / `--threads` overrides. Drives both
   *  the build flags and (for `--threads`) the codegen. Ignored on
   *  the `--js` path: the JS runtime is single-threaded and has no
   *  `-ffast-math` equivalent. */
  opt: OptSettings;
}

/** Compile and execute a translated C source. Shared by `run` and
 *  `eval` so both subcommands take the identical post-translate
 *  pipeline (compile via `cc`, spawn the binary, intercept plot
 *  records, wait for exit + plot server close). */
async function runCSource(cSrc: string, opts: RunOptions): Promise<void> {
  if (opts.dumpC) writeFileSync(opts.dumpC, cSrc);
  const dir = mkdtempSync(join(tmpdir(), "mtoc2-"));
  const cFile = join(dir, "out.c");
  const exeFile = join(dir, "out");
  writeFileSync(cFile, cSrc);

  const ccArgs = buildCcArgs(cFile, exeFile, {
    checkLeaks: opts.checkLeaks,
    fastMath: opts.opt.fastMath,
    threads: opts.opt.threads,
  });
  // mtoc2's elementwise loops live in macro-defined helpers; the
  // generated user code occasionally produces unused labels / static
  // helpers that the C compiler warns about at -O3. Silence those so
  // a `run` build doesn't spam stderr.
  ccArgs.push("-Wno-unused-label", "-Wno-unused-function");
  const cc = spawnSync("cc", ccArgs, {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (cc.status !== 0) {
    console.error(`cc failed (status ${cc.status}); generated C at ${cFile}`);
    process.exit(cc.status ?? 1);
  }

  // Pipe the binary's stdout through a line-splitter so we can
  // intercept plot-dispatch records before they reach the user's
  // terminal. Without --plot, the records are still stripped — they're
  // wire-protocol bytes, not user-facing output. With --plot, each
  // record is translated through numbl's `dispatchPlotBuiltin` and
  // pushed to numbl's plot server (which lazy-starts on the first
  // batch and opens the standard plot-viewer in a browser tab).
  const { onDrawnow, flushAndWait } = createPlotHandler(!opts.plot);
  const plotState = newPlotDispatchState();

  const child = spawn(exeFile, [], {
    stdio: ["ignore", "pipe", "inherit"],
  });

  const rl = createInterface({ input: child.stdout });
  rl.on("line", line => {
    if (line.startsWith(PLOT_PREFIX)) {
      if (!onDrawnow) return; // --plot disabled: silently drop
      const body = line.slice(PLOT_PREFIX.length);
      let record: PlotRecord;
      try {
        record = JSON.parse(body) as PlotRecord;
      } catch {
        process.stderr.write(`[mtoc2] malformed plot record: ${body}\n`);
        return;
      }
      const batch: PlotInstruction[] = [];
      applyPlotRecord(record, batch, plotState);
      if (batch.length > 0) onDrawnow(batch);
      return;
    }
    process.stdout.write(line + "\n");
  });

  const exitCode: number = await new Promise(res => {
    child.on("exit", code => res(code ?? 0));
  });
  // Wait for the readline buffer to drain before flushing the plot
  // server — last-line records would otherwise lose the race against
  // server-close.
  await new Promise<void>(res => rl.on("close", res));
  await flushAndWait();
  process.exit(exitCode);
}

/** Translate the emitted C to JS via c2js, write it to a temp file,
 *  and run it under a child `node`. Plot records and stdout are
 *  intercepted with the same line-splitter as `runCSource` — the JS
 *  runtime writes `printf` output to `process.stdout`, so the plot
 *  prefix is byte-for-byte identical to the C path. */
async function runJsSource(cSrc: string, opts: RunOptions): Promise<void> {
  if (opts.dumpC) writeFileSync(opts.dumpC, cSrc);
  const jsSrc = translateCToJs(cSrc);
  if (opts.dumpJs) writeFileSync(opts.dumpJs, jsSrc);
  const dir = mkdtempSync(join(tmpdir(), "mtoc2-"));
  const jsFile = join(dir, "out.js");
  writeFileSync(jsFile, jsSrc);

  const { onDrawnow, flushAndWait } = createPlotHandler(!opts.plot);
  const plotState = newPlotDispatchState();

  const child = spawn(process.execPath, [jsFile], {
    stdio: ["ignore", "pipe", "inherit"],
  });

  const rl = createInterface({ input: child.stdout });
  rl.on("line", line => {
    if (line.startsWith(PLOT_PREFIX)) {
      if (!onDrawnow) return;
      const body = line.slice(PLOT_PREFIX.length);
      let record: PlotRecord;
      try {
        record = JSON.parse(body) as PlotRecord;
      } catch {
        process.stderr.write(`[mtoc2] malformed plot record: ${body}\n`);
        return;
      }
      const batch: PlotInstruction[] = [];
      applyPlotRecord(record, batch, plotState);
      if (batch.length > 0) onDrawnow(batch);
      return;
    }
    process.stdout.write(line + "\n");
  });

  const exitCode: number = await new Promise(res => {
    child.on("exit", code => res(code ?? 0));
  });
  await new Promise<void>(res => rl.on("close", res));
  await flushAndWait();
  process.exit(exitCode);
}

/** Parse the shared flag set for `run` and `eval`. Two-token flags
 *  consume their next arg; unknown options or a missing positional
 *  abort to `usage()`. The optimization flags (`--opt`, `--fast-math`/
 *  `--no-fast-math`, `--threads N|auto`) mirror mtoc's CLI surface;
 *  see [optProfile.ts](./optProfile.ts) for the profile semantics. */
function parseRunEvalArgs(argv: string[]): {
  positional: string;
  extraPaths: string[];
  opts: RunOptions;
} {
  let checkLeaks = false;
  let plot = false;
  let js = false;
  let dumpC: string | undefined;
  let dumpJs: string | undefined;
  let profile: OptProfile | undefined;
  const overrides: Partial<OptSettings> = {};
  const extraPaths: string[] = [];
  let positional: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check-leaks") checkLeaks = true;
    else if (a === "--plot") plot = true;
    else if (a === "--js") js = true;
    else if (a === "--path") {
      if (i + 1 >= argv.length) {
        console.error("Error: --path requires a directory argument");
        process.exit(2);
      }
      extraPaths.push(argv[++i]);
    } else if (a === "--dump-c") {
      if (i + 1 >= argv.length) {
        console.error("Error: --dump-c requires a path argument");
        process.exit(2);
      }
      dumpC = argv[++i];
    } else if (a === "--dump-js") {
      if (i + 1 >= argv.length) {
        console.error("Error: --dump-js requires a path argument");
        process.exit(2);
      }
      dumpJs = argv[++i];
    } else if (a === "--opt") {
      const v = argv[++i];
      if (!isOptProfile(v)) {
        console.error(
          `Error: --opt requires one of ${OPT_PROFILES.join(", ")} (got '${v ?? ""}')`
        );
        process.exit(2);
      }
      profile = v;
    } else if (a === "--fast-math") {
      overrides.fastMath = true;
    } else if (a === "--no-fast-math") {
      overrides.fastMath = false;
    } else if (a === "--threads") {
      const v = argv[++i];
      if (v === undefined) {
        console.error("Error: --threads requires a value (N or 'auto')");
        process.exit(2);
      }
      if (v === "auto") {
        overrides.threads = "auto";
      } else {
        const n = parseInt(v, 10);
        if (!Number.isFinite(n) || n < 1 || String(n) !== v) {
          console.error(
            `Error: --threads value must be a positive integer or 'auto' (got '${v}')`
          );
          process.exit(2);
        }
        overrides.threads = n;
      }
    } else if (a === "--inline-temps" || a === "--no-inline-temps") {
      console.error(
        `Error: ${a} is not supported by mtoc2 (no temp-inlining pass yet)`
      );
      process.exit(2);
    } else if (a.startsWith("--")) {
      console.error(`Error: unknown option '${a}'`);
      usage();
    } else if (positional === null) {
      positional = a;
    } else {
      usage();
    }
  }
  if (positional === null) usage();
  const opt = resolveOptSettings(profile, overrides);
  return {
    positional,
    extraPaths,
    opts: { checkLeaks, plot, js, dumpC, dumpJs, opt },
  };
}

/** Default-init a `RunOptions` for callers that don't go through
 *  `parseRunEvalArgs` (the bare-script fallback). */
function defaultRunOptions(): RunOptions {
  return { opt: resolveOptSettings() };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) usage();
  const cmd = argv[0];
  if (cmd === "run") {
    const { positional, extraPaths, opts } = parseRunEvalArgs(argv.slice(1));
    const cSrc = translateFile(positional, extraPaths, opts.opt.threads);
    await (opts.js ? runJsSource(cSrc, opts) : runCSource(cSrc, opts));
    return;
  }
  if (cmd === "eval") {
    const { positional, extraPaths, opts } = parseRunEvalArgs(argv.slice(1));
    const cSrc = translateInline(positional, extraPaths, opts.opt.threads);
    await (opts.js ? runJsSource(cSrc, opts) : runCSource(cSrc, opts));
    return;
  }
  if (cmd === "translate") {
    if (argv.length < 2) usage();
    const script = argv[1];
    const c = translateFile(script);
    let outPath: string | null = null;
    for (let i = 2; i < argv.length; i++) {
      if (argv[i] === "-o" && i + 1 < argv.length) {
        outPath = argv[i + 1];
        i++;
      }
    }
    if (outPath) {
      writeFileSync(outPath, c);
    } else {
      process.stdout.write(c);
    }
    return;
  }
  // Bare script path: default to `run`.
  if (cmd.endsWith(".m")) {
    await runCSource(translateFile(cmd), defaultRunOptions());
    return;
  }
  usage();
}

main().catch(err => {
  console.error(
    err instanceof Error ? (err.stack ?? err.message) : String(err)
  );
  process.exit(1);
});

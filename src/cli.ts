#!/usr/bin/env tsx
/**
 * mtoc2 CLI entry. Two subcommands:
 *   run <script.m>          translate, compile, execute; forward stdout
 *   translate <script.m> [-o out.c]  emit C only
 *
 * The script's directory is the workspace search path: every sibling
 * `.m` file is registered as a workspace file, so cross-file calls
 * (e.g. `helper(x)` referring to `helper.m`) resolve through numbl's
 * vendored resolver. Mirrors numbl's CLI exactly so the cross-runner
 * sees the same workspace shape from both runners.
 */

import {
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdtempSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, basename } from "node:path";
import { spawnSync } from "node:child_process";

import { translateProject, type SourceFile } from "./translate.js";

function usage(): never {
  console.error("usage: mtoc2 run <script.m>");
  console.error("       mtoc2 translate <script.m> [-o out.c]");
  process.exit(2);
}

/** Scan `dir` for sibling `.m` files and read each one. Skips
 *  subdirectories — mtoc2 v1 doesn't support `+pkg/`, `@Class/`, or
 *  `private/` layouts; an `.m` inside one would surface as
 *  unsupported at the resolver anyway. */
function scanSiblings(dir: string, excludeAbs: string): SourceFile[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: SourceFile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".m")) continue;
    const full = join(dir, entry);
    if (resolve(full) === excludeAbs) continue;
    try {
      if (!statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    out.push({ name: full, source: readFileSync(full, "utf8") });
  }
  return out;
}

function translate(scriptPath: string): string {
  const absScript = resolve(scriptPath);
  const source = readFileSync(absScript, "utf8");
  const dir = dirname(absScript);
  const files: SourceFile[] = [
    { name: absScript, source },
    ...scanSiblings(dir, absScript),
  ];
  const result = translateProject(files, absScript, { searchPaths: [dir] });
  if (result.error) {
    const e = result.error;
    const file = e.fileName ?? absScript;
    const where =
      e.startOffset !== undefined ? ` (offset ${e.startOffset})` : "";
    console.error(`${file}: ${e.kind}: ${e.message}${where}`);
    process.exit(1);
  }
  return result.c ?? "";
}

interface RunOptions {
  /** Build the C output with `-fsanitize=address -g`. AddressSanitizer
   *  pulls in LeakSanitizer at exit on Linux, so any unfreed
   *  `mtoc2_tensor_t` (or other owned buffer) is reported on stderr
   *  and the process exits non-zero. ~2x slowdown; off by default,
   *  but the cross-runner enables it for every script. */
  checkLeaks?: boolean;
}

function runScript(scriptPath: string, opts: RunOptions = {}): void {
  const cSrc = translate(scriptPath);
  const dir = mkdtempSync(join(tmpdir(), "mtoc2-"));
  const cFile = join(dir, "out.c");
  const exeFile = join(dir, "out");
  writeFileSync(cFile, cSrc);

  const ccArgs = [
    "-O0",
    "-Wno-unused-label",
    "-Wno-unused-function",
    "-o",
    exeFile,
    cFile,
    "-lm",
  ];
  if (opts.checkLeaks) ccArgs.unshift("-fsanitize=address", "-g");
  const cc = spawnSync("cc", ccArgs, {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (cc.status !== 0) {
    console.error(`cc failed (status ${cc.status}); generated C at ${cFile}`);
    process.exit(cc.status ?? 1);
  }

  const run = spawnSync(exeFile, [], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  process.exit(run.status ?? 0);
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.length === 0) usage();
  const cmd = argv[0];
  if (cmd === "run") {
    let checkLeaks = false;
    let script: string | null = null;
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--check-leaks") checkLeaks = true;
      else if (script === null) script = a;
      else usage();
    }
    if (script === null) usage();
    runScript(script, { checkLeaks });
    return;
  }
  if (cmd === "translate") {
    if (argv.length < 2) usage();
    const script = argv[1];
    const c = translate(script);
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
    runScript(cmd);
    return;
  }
  usage();
  void basename;
}

main();

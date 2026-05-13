#!/usr/bin/env tsx
/**
 * mtoc2 CLI entry. Two subcommands:
 *   run <script.m>          translate, compile, execute; forward stdout
 *   translate <script.m> [-o out.c]  emit C only
 */

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";

import { parseMFile } from "../parser.js";
import { Lowerer } from "../lowering/lower.js";
import { emitProgram } from "../codegen/emit.js";
import {
  UnsupportedConstruct,
  TypeError,
  formatError,
} from "../lowering/errors.js";

function usage(): never {
  console.error("usage: mtoc2 run <script.m>");
  console.error("       mtoc2 translate <script.m> [-o out.c]");
  process.exit(2);
}

function translate(scriptPath: string): string {
  const source = readFileSync(scriptPath, "utf8");
  const ast = parseMFile(source, scriptPath);
  const lowerer = new Lowerer();
  try {
    const prog = lowerer.lowerProgram(ast);
    return emitProgram(prog);
  } catch (e) {
    if (e instanceof UnsupportedConstruct || e instanceof TypeError) {
      console.error(formatError(e, source));
      process.exit(1);
    }
    throw e;
  }
}

function runScript(scriptPath: string): void {
  const cSrc = translate(scriptPath);
  const dir = mkdtempSync(join(tmpdir(), "mtoc2-"));
  const cFile = join(dir, "out.c");
  const exeFile = join(dir, "out");
  writeFileSync(cFile, cSrc);

  const cc = spawnSync(
    "cc",
    [
      "-O0",
      "-Wno-unused-label",
      "-Wno-unused-function",
      "-o",
      exeFile,
      cFile,
      "-lm",
    ],
    { stdio: ["ignore", "inherit", "inherit"] }
  );
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
    if (argv.length < 2) usage();
    runScript(argv[1]);
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

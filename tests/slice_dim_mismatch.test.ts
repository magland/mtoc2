/**
 * Slice-store dimension-mismatch ABORT used `abort()`, which raises
 * SIGABRT — `spawnSync` surfaces that as `signal`, not `status`, so
 * the CLI's `process.exit(run.status ?? 0)` reported a clean run
 * despite the diagnostic. Switched to `exit(1)` so the cross-runner
 * (and any caller) sees a non-zero status. The cross-runner can't
 * test this directly (numbl errors → "FAIL: numbl errored"), so
 * coverage lives here.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { parseMFile } from "../src/parser/index.js";
import { Lowerer } from "../src/lowering/lower.js";
import { emitProgram } from "../src/codegen/emit.js";
import { Workspace } from "../src/workspace/workspace.js";

interface RunOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function compileAndRun(source: string, fileName = "test.m"): RunOutcome {
  const ast = parseMFile(source, fileName);
  const ws = new Workspace(fileName);
  ws.addFile({ name: fileName, source, ast });
  const prog = new Lowerer(ws).lowerProgram(ast);
  const cSrc = emitProgram(prog);

  const dir = mkdtempSync(join(tmpdir(), "mtoc2-dim-"));
  const cFile = join(dir, "out.c");
  const exe = join(dir, "out");
  writeFileSync(cFile, cSrc);
  const cc = spawnSync("cc", [
    "-O0",
    "-Wno-unused-label",
    "-Wno-unused-function",
    "-o",
    exe,
    cFile,
    "-lm",
  ]);
  if (cc.status !== 0) {
    throw new Error(`cc failed: ${cc.stderr.toString()}`);
  }
  const run = spawnSync(exe, [], { encoding: "utf8" });
  return {
    exitCode: run.status,
    signal: run.signal,
    stdout: run.stdout,
    stderr: run.stderr,
  };
}

describe("slice-store dimension mismatch", () => {
  it("exits non-zero with a numbl-style error message on multi-slot mismatch", () => {
    // M is 2x3 (numel=6); slice M(:, 1:2) is 2x2 (numel=4); rhs is
    // 6x1 (numel=6). Should error.
    const r = compileAndRun(`
      M = zeros(2, 3);
      w = zeros(6, 1);
      M(:, 1:2) = w;
      disp(M);
    `);
    expect(r.exitCode).toBe(1);
    expect(r.signal).toBeNull();
    expect(r.stderr).toMatch(/Subscripted assignment dimension mismatch/);
    expect(r.stderr).toMatch(/lhs slice has 4 elements, rhs has 6/);
  });

  it("exits non-zero on single-slot range write count mismatch", () => {
    // v(2:5) is 4 elements; rhs is 6 elements.
    const r = compileAndRun(`
      v = zeros(1, 6);
      w = zeros(1, 6);
      v(2:5) = w;
      disp(v);
    `);
    expect(r.exitCode).toBe(1);
    expect(r.signal).toBeNull();
    expect(r.stderr).toMatch(/Subscripted assignment dimension mismatch/);
  });

  it("succeeds when shapes match", () => {
    const r = compileAndRun(`
      M = zeros(2, 3);
      w = zeros(2, 2);
      w(1,1) = 10; w(2,1) = 20; w(1,2) = 30; w(2,2) = 40;
      M(:, 1:2) = w;
      disp(M);
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("10");
    expect(r.stdout).toContain("40");
  });
});

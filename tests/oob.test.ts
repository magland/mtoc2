/**
 * Bounds-check tests for tensor scalar / slice indexing. The cross-
 * runner can't validate the error path — when both numbl and mtoc2
 * raise an error, the runner reports a single "errored" line rather
 * than diffing stdouts — so OOB regression coverage lives here as
 * vitest unit tests.
 *
 * Each test compiles a known-OOB script, runs the binary, and asserts
 * on the exit code + stderr message format. The translator's emitted
 * C is also spot-checked for the bounds-check call so a future
 * refactor can't silently drop it.
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
  cSource: string;
}

function compileAndRun(source: string, fileName = "test.m"): RunOutcome {
  const ast = parseMFile(source, fileName);
  const ws = new Workspace(fileName);
  ws.addFile({ name: fileName, source, ast });
  const prog = new Lowerer(ws).lowerProgram(ast);
  const cSrc = emitProgram(prog);

  const dir = mkdtempSync(join(tmpdir(), "mtoc2-oob-"));
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
    cSource: cSrc,
  };
}

describe("scalar index bounds checks", () => {
  it("aborts on a 1-arg linear index above numel", () => {
    const r = compileAndRun(`
      v = [1 2 3];
      disp(v(7));
    `);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Index exceeds array bounds.*got 7.*valid 1\.\.3/);
    expect(r.stdout).toBe("");
  });

  it("aborts on a 1-arg linear index of zero (1-based language)", () => {
    const r = compileAndRun(`
      v = [10 20 30];
      disp(v(0));
    `);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Index exceeds array bounds.*got 0/);
  });

  it("aborts per-axis on a 2-arg index whose linear-equivalent would pass", () => {
    // M is 2x3 (numel=6). M(4, 1) computes linear offset 3, which is
    // < 6 — a linear-only check would silently read M(2, 2). Per-axis
    // check catches it.
    const r = compileAndRun(`
      M = [1 2 3; 4 5 6];
      disp(M(4, 1));
    `);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(
      /Index in position 1 exceeds array bounds.*got 4.*valid 1\.\.2/
    );
  });

  it("aborts per-axis on the second axis of a 2-arg index", () => {
    const r = compileAndRun(`
      M = [1 2 3; 4 5 6];
      disp(M(1, 7));
    `);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(
      /Index in position 2 exceeds array bounds.*got 7.*valid 1\.\.3/
    );
  });

  it("aborts on indexed write past the end", () => {
    const r = compileAndRun(`
      v = zeros(1, 4);
      v(10) = 99;
      disp(v);
    `);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(
      /Index exceeds array bounds.*got 10.*valid 1\.\.4/
    );
  });

  it("emits a bounds-check call in the generated C", () => {
    const r = compileAndRun(`
      v = [1 2 3];
      disp(v(2));
    `);
    expect(r.exitCode).toBe(0);
    expect(r.cSource).toMatch(/mtoc2_idx_(lin|axis)\(/);
  });

  it("allows valid in-range access without aborting", () => {
    const r = compileAndRun(`
      v = [10 20 30];
      disp(v(2));
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("20");
  });
});

describe("slice bounds checks", () => {
  it("aborts on a single-slot range slice whose end exceeds numel", () => {
    // Single-slot range slice indexes linearly over numel(base), so
    // the error has no "position N" qualifier.
    const r = compileAndRun(`
      v = [1 2 3 4];
      x = v(2:10);
      disp(x);
    `);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(
      /Index exceeds array bounds.*got 10.*valid 1\.\.4/
    );
  });

  it("aborts on a single-slot range slice whose start is < 1", () => {
    const r = compileAndRun(`
      v = [1 2 3];
      x = v(0:2);
      disp(x);
    `);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Index exceeds array bounds.*got 0/);
  });

  it("aborts per-axis on a multi-slot range slice whose end exceeds the axis dim", () => {
    const r = compileAndRun(`
      M = zeros(2, 3);
      x = M(:, 2:9);
      disp(x);
    `);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(
      /Index in position 2 exceeds array bounds.*got 9.*valid 1\.\.3/
    );
  });

  it("aborts on a scalar slot in a multi-slot slice that's out of range", () => {
    const r = compileAndRun(`
      M = zeros(2, 3);
      x = M(:, 9);
      disp(x);
    `);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(
      /Index in position 2 exceeds array bounds.*got 9.*valid 1\.\.3/
    );
  });

  it("does NOT abort on an empty range slice (MATLAB semantics)", () => {
    // `v(5:4)` in MATLAB yields an empty 1x0 vector — not an error.
    // The bounds-check should skip when the slice's iter count is 0.
    const r = compileAndRun(`
      v = [10 20 30];
      x = v(5:4);
      disp(numel(x));
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("0");
  });

  it("allows valid in-range slice access without aborting", () => {
    const r = compileAndRun(`
      v = [10 20 30 40 50];
      disp(v(2:4));
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("20");
    expect(r.stdout).toContain("40");
  });
});

/**
 * Domain-rejection tests for `sqrt`, `log`, `log2`, `log10`.
 *
 * mtoc2 has no complex type yet; the cross-runner can't compare a
 * mtoc2 TypeError against numbl's complex result, so these
 * "translation must error" cases live in vitest.
 */

import { describe, it, expect } from "vitest";
import { parseMFile } from "../src/parser/index.js";
import { Lowerer } from "../src/lowering/lower.js";
import { Workspace } from "../src/workspace/workspace.js";
import { TypeError } from "../src/lowering/errors.js";

function lower(source: string, fileName = "test.m"): void {
  const ast = parseMFile(source, fileName);
  const ws = new Workspace(fileName);
  ws.addFile({ name: fileName, source, ast });
  new Lowerer(ws).lowerProgram(ast);
}

function expectTypeError(source: string, msg: RegExp): void {
  let caught: unknown = null;
  try {
    lower(source);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(TypeError);
  expect((caught as Error).message).toMatch(msg);
}

describe("sqrt rejects non-statically-nonneg input", () => {
  it("rejects a negative literal", () => {
    expectTypeError("x = sqrt(-1);", /sqrt.*may be negative/);
  });

  it("accepts sqrt of an exact nonneg literal", () => {
    expect(() => lower("disp(sqrt(4));")).not.toThrow();
  });

  it("accepts sqrt of a tensor literal with nonneg elements", () => {
    expect(() => lower("disp(sqrt([0 1 4 9]));")).not.toThrow();
  });

  it("rejects sqrt of a tensor literal with a negative element", () => {
    // The tensor's sign is derived from exact data; `[-1 4]` has sign
    // `nonzero` (mixed positive/negative, no zero), which is NOT nonneg.
    expectTypeError("disp(sqrt([-1 4]));", /sqrt.*may be negative/);
  });

  it("accepts sqrt(zeros(n,n)) — fill value is statically nonneg", () => {
    expect(() => lower("disp(sqrt(zeros(3, 3)));")).not.toThrow();
  });

  it("rejects sqrt of an opaque'd negative scalar", () => {
    // The opaque directive strips `exact` but preserves `sign`. The
    // literal -1 starts with `sign:"negative"`, so the post-opaque
    // value is still statically not nonneg.
    expectTypeError(
      ["x = -1;", "%!numbl:opaque x", "disp(sqrt(x));"].join("\n"),
      /sqrt.*may be negative/
    );
  });
});

describe("log/log2/log10 reject non-statically-positive input", () => {
  it("rejects log(0)", () => {
    expectTypeError("disp(log(0));", /log.*not statically positive/);
  });

  it("rejects log(-1)", () => {
    expectTypeError("disp(log(-1));", /log.*not statically positive/);
  });

  it("accepts log of an exact positive literal", () => {
    expect(() => lower("disp(log(1));")).not.toThrow();
  });

  it("rejects log2 of an opaque'd nonneg scalar (could be zero)", () => {
    expectTypeError(
      ["x = 0;", "%!numbl:opaque x", "disp(log2(x));"].join("\n"),
      /log2.*not statically positive/
    );
  });

  it("accepts log10 of a positive tensor literal", () => {
    expect(() => lower("disp(log10([1 10 100]));")).not.toThrow();
  });
});

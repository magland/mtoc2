/**
 * Span attribution: arity / unassigned-output errors raised by
 * `specializeUserFunction` should point at the CALL SITE, not at the
 * function definition. The previous implementation reported
 * `decl.span` for both errors, which highlighted the wrong place in
 * the user's source.
 */

import { describe, it, expect } from "vitest";
import { parseMFile } from "../src/parser/index.js";
import { Lowerer } from "../src/lowering/lower.js";
import { Workspace } from "../src/workspace/workspace.js";
import { TypeError } from "../src/lowering/errors.js";

function lowerAndCatch(source: string): { source: string; error: TypeError } {
  const fileName = "test.m";
  const ast = parseMFile(source, fileName);
  const ws = new Workspace(fileName);
  ws.addFile({ name: fileName, source, ast });
  let caught: unknown = null;
  try {
    new Lowerer(ws).lowerProgram(ast);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(TypeError);
  return { source, error: caught as TypeError };
}

function lineOfOffset(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

describe("arity error span points at the call site, not the definition", () => {
  it("too few args", () => {
    const source = [
      "foo(1);",
      "function y = foo(a, b)",
      "  y = a + b;",
      "end",
    ].join("\n");
    const { error } = lowerAndCatch(source);
    expect(error.message).toMatch(/foo.*expects 2 arg\(s\), got 1/);
    expect(error.span).toBeDefined();
    expect(lineOfOffset(source, error.span!.start)).toBe(1);
  });

  it("too many args", () => {
    const source = [
      "foo(1, 2, 3);",
      "function y = foo(a, b)",
      "  y = a + b;",
      "end",
    ].join("\n");
    const { error } = lowerAndCatch(source);
    expect(lineOfOffset(source, error.span!.start)).toBe(1);
  });
});

describe("unassigned-output error span points at the call site", () => {
  it("function declares an output but body never assigns it", () => {
    const source = [
      "x = lazy(1);",
      "function y = lazy(a)",
      "  %!numbl:opaque a",
      "  if a > 0",
      "    a = a + 1;",
      "  end",
      "end",
    ].join("\n");
    const { error } = lowerAndCatch(source);
    expect(error.message).toMatch(/output 'y' was never assigned/);
    expect(lineOfOffset(source, error.span!.start)).toBe(1);
  });
});

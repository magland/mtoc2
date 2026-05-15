/**
 * Unmapped binary / unary operators must surface as
 * `UnsupportedConstruct` with the operator's span — not a bare `Error`
 * that bypasses translate.ts's catch path and reaches the user as
 * "internal error". The cross-runner can't validate this (numbl
 * accepts the same source), so the assertion lives here.
 */

import { describe, it, expect } from "vitest";
import { parseMFile } from "../src/parser/index.js";
import { Lowerer } from "../src/lowering/lower.js";
import { Workspace } from "../src/workspace/workspace.js";
import { UnsupportedConstruct } from "../src/lowering/errors.js";

function lower(source: string, fileName = "test.m"): void {
  const ast = parseMFile(source, fileName);
  const ws = new Workspace(fileName);
  ws.addFile({ name: fileName, source, ast });
  new Lowerer(ws).lowerProgram(ast);
}

describe("unmapped binary operators raise UnsupportedConstruct", () => {
  it("rejects `\\` (LeftDiv)", () => {
    expect(() => lower("y = 2 \\ 4;")).toThrow(UnsupportedConstruct);
  });

  it("rejects `.\\` (ElemLeftDiv)", () => {
    expect(() => lower("y = [2 4] .\\ [4 8];")).toThrow(UnsupportedConstruct);
  });

  it("rejects `|` (BitOr)", () => {
    expect(() => lower("y = 1 | 0;")).toThrow(UnsupportedConstruct);
  });

  it("rejects `&` (BitAnd)", () => {
    expect(() => lower("y = 1 & 0;")).toThrow(UnsupportedConstruct);
  });
});

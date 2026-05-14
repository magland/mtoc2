/**
 * `rdivide`'s sign-transfer must use the quotient rule, not the
 * product rule. `x / 0` is ±Inf (or NaN), never zero, so a zero
 * divisor degrades the sign to `unknown` regardless of the numerator.
 */

import { describe, it, expect } from "vitest";
import { Lowerer } from "../src/lowering/lower.js";
import { Workspace } from "../src/workspace/workspace.js";
import { parseMFile } from "../src/parser/index.js";
import { isNumeric } from "../src/lowering/types.js";

function typeOfFinalIdent(source: string, name: string): string {
  const fileName = "test.m";
  const ast = parseMFile(source, fileName);
  const workspace = new Workspace(fileName);
  workspace.addFile({ name: fileName, source, ast });
  const lowerer = new Lowerer(workspace);
  lowerer.lowerProgram(ast);
  const env = (lowerer as unknown as { env: Map<string, { ty: unknown }> }).env;
  const e = env.get(name);
  if (e === undefined) throw new Error(`'${name}' not bound`);
  const ty = e.ty;
  if (!isNumeric(ty as never)) throw new Error("not numeric");
  return (ty as { sign: string }).sign;
}

describe("rdivide sign-transfer (Bug 9)", () => {
  it("zero / nonzero is zero", () => {
    expect(typeOfFinalIdent("a = 0; b = 5; c = a / b;", "c")).toBe("zero");
  });

  it("positive / zero is unknown (it's ±Inf, not zero)", () => {
    expect(typeOfFinalIdent("a = 5; b = 0; c = a / b;", "c")).toBe("unknown");
  });

  it("zero / zero is unknown", () => {
    expect(typeOfFinalIdent("a = 0; b = 0; c = a / b;", "c")).toBe("unknown");
  });

  it("positive / positive is positive", () => {
    expect(typeOfFinalIdent("a = 2; b = 3; c = a / b;", "c")).toBe("positive");
  });

  it("negative / negative is positive", () => {
    expect(typeOfFinalIdent("a = -2; b = -3; c = a / b;", "c")).toBe(
      "positive"
    );
  });

  it("positive / negative is negative", () => {
    expect(typeOfFinalIdent("a = 2; b = -3; c = a / b;", "c")).toBe("negative");
  });
});

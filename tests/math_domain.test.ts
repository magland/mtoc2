/**
 * Real-domain handling for `sqrt`, `log`, `log2`, `log10`.
 *
 * Each of these builtins stays on the real path when the input is
 * provably in the real domain, and lifts to the complex path
 * (real input → complex output via `mtoc2_csqrt` / `mtoc2_clog` / …)
 * when it isn't. The cross-runner already covers byte-for-byte
 * agreement with numbl; these tests pin the lattice contract so a
 * regression that re-introduces a translate-time throw (or that
 * silently keeps a real-domain miss on the real path) is caught
 * before the slower runners.
 */

import { describe, expect, it } from "vitest";
import "../src/builtins/index.js";
import { getBuiltin } from "../src/builtins/registry.js";
import {
  type NumericType,
  type Type,
  scalarDouble,
  tensorDouble,
  isNumeric,
} from "../src/lowering/types.js";

function transfer(name: string, argTypes: Type[]): Type {
  const b = getBuiltin(name);
  if (!b) throw new Error(`builtin '${name}' not registered`);
  const out = b.transfer(argTypes, 1);
  return out[0];
}

function expectReal(name: string, argTypes: Type[]): NumericType {
  const ty = transfer(name, argTypes);
  if (!isNumeric(ty) || ty.isComplex) {
    throw new Error(
      `expected real result from '${name}', got ${JSON.stringify(ty)}`
    );
  }
  return ty;
}

function expectComplex(name: string, argTypes: Type[]): NumericType {
  const ty = transfer(name, argTypes);
  if (!isNumeric(ty) || !ty.isComplex) {
    throw new Error(
      `expected complex result from '${name}', got ${JSON.stringify(ty)}`
    );
  }
  return ty;
}

describe("sqrt", () => {
  it("stays real for nonneg scalar", () => {
    expectReal("sqrt", [scalarDouble("positive", 4)]);
    expectReal("sqrt", [scalarDouble("nonneg")]);
    expectReal("sqrt", [scalarDouble("zero", 0)]);
  });

  it("stays real for a nonneg tensor literal", () => {
    expectReal("sqrt", [tensorDouble([4], new Float64Array([0, 1, 4, 9]))]);
  });

  it("stays real for zeros(n, n) (fill sign is statically nonneg)", () => {
    // zeros' transfer produces a real tensor with sign:"zero"; the
    // result of sqrt is the same shape, real, sign:"nonneg".
    const z = transfer("zeros", [scalarDouble("positive", 3)]);
    expectReal("sqrt", [z]);
  });

  it("lifts a negative literal to complex", () => {
    expectComplex("sqrt", [scalarDouble("negative", -1)]);
  });

  it("lifts a tensor with mixed-sign elements to complex", () => {
    // `[-1 4]` has sign "nonzero" (positive + negative, no zero),
    // which is not in the nonneg subset → lift.
    expectComplex("sqrt", [tensorDouble([2], new Float64Array([-1, 4]))]);
  });

  it("lifts an opaque scalar (sign:unknown) to complex", () => {
    expectComplex("sqrt", [scalarDouble("unknown")]);
  });

  it("folds an exact negative scalar to an exact complex result", () => {
    const ty = expectComplex("sqrt", [scalarDouble("negative", -1)]);
    expect(ty.exact).toEqual({ re: 0, im: 1 });
  });
});

describe("log / log2 / log10", () => {
  it("stay real for positive scalar input", () => {
    expectReal("log", [scalarDouble("positive", 1)]);
    expectReal("log2", [scalarDouble("positive", 4)]);
    expectReal("log10", [scalarDouble("positive", 100)]);
  });

  it("stay real for a nonneg input including zero (log(0) = -Inf is real)", () => {
    // sign:"zero" stays on the real path; the exact-fold rejects
    // `Math.log(0) = -Inf` (non-finite), so we just confirm the
    // output type is real (the runtime will emit -Inf at exec).
    expectReal("log", [scalarDouble("zero", 0)]);
    expectReal("log2", [scalarDouble("nonneg")]);
  });

  it("stay real for a provably-positive tensor literal", () => {
    expectReal("log10", [tensorDouble([3], new Float64Array([1, 10, 100]))]);
  });

  it("lift a negative scalar literal to complex", () => {
    expectComplex("log", [scalarDouble("negative", -1)]);
    expectComplex("log2", [scalarDouble("negative", -4)]);
    expectComplex("log10", [scalarDouble("negative", -100)]);
  });

  it("lift an opaque scalar (sign:unknown) to complex", () => {
    expectComplex("log", [scalarDouble("unknown")]);
  });

  it("folds an exact negative log to an exact complex result", () => {
    const ty = expectComplex("log", [scalarDouble("negative", -1)]);
    // log(-1) = 0 + i*pi.
    expect(ty.exact).toBeDefined();
    const cx = ty.exact as { re: number; im: number };
    expect(cx.re).toBeCloseTo(0, 12);
    expect(cx.im).toBeCloseTo(Math.PI, 12);
  });
});

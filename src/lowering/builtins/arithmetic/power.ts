/**
 * `power` builtin — backs the `.^` (elementwise power) binary
 * operator.
 *
 * Mirrors `mElemPow` in `../numbl/src/numbl-core/helpers/arithmetic.ts`
 * (line 1075) modulo the complex-result paths. Numbl produces a
 * complex result for `(neg)^(non-integer)`; mtoc2 has no complex
 * type and rejects that combination at lowering time (same precedent
 * as `sqrt` / `log` rejecting out-of-domain real inputs).
 *
 * Shape rules follow the rest of the elementwise binary family:
 *   - scalar OP scalar → scalar; tensor OP scalar / scalar OP tensor /
 *     same-shape tensor OP tensor.
 *   - exact-fold within EXACT_ARRAY_MAX_ELEMENTS when every input
 *     element is exact AND every output element is finite.
 *
 * Sign refinement:
 *   - exponent exact zero → `positive` (x^0 == 1 for every x, even 0
 *     and Inf per IEEE-754 / MATLAB).
 *   - base statically `positive` → `positive`.
 *   - base statically `nonneg` AND exponent statically `nonneg` → `nonneg`.
 *   - otherwise → `unknown`.
 *
 * Domain rejection: when the base could be negative (i.e. its sign
 * isn't statically nonneg) AND the exponent isn't an exact integer
 * (or any exact value at all), reject with a clear span — that's the
 * "complex-result" case numbl handles but mtoc2 v1 doesn't.
 */

import { UnsupportedConstruct } from "../../errors.js";
import {
  type NumericType,
  type Sign,
  EXACT_ARRAY_MAX_ELEMENTS,
  isMultiElement,
  scalarDouble,
  signFromNumber,
  signIsNonneg,
  tensorDouble,
} from "../../types.js";
import type { Span } from "../../../parser/index.js";
import type { Builtin } from "../registry.js";
import { exactDouble, exactRealArray, requireRealDouble } from "../_shared.js";

function isExactInteger(t: NumericType): boolean {
  const v = exactDouble(t);
  return v !== undefined && Number.isFinite(v) && Number.isInteger(v);
}

function exactArrayAllInteger(arr: Float64Array): boolean {
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (!Number.isFinite(v) || !Number.isInteger(v)) return false;
  }
  return true;
}

function exactArrayAllNonneg(arr: Float64Array): boolean {
  for (let i = 0; i < arr.length; i++) {
    if (!(arr[i] >= 0)) return false;
  }
  return true;
}

/** Sign rule for power. See header comment. */
function powerSign(a: NumericType, b: NumericType): Sign {
  // exponent exact zero → result is exactly 1 (positive).
  const bx = exactDouble(b);
  if (bx === 0) return "positive";
  // Even-integer exponent → result is x^(2k), always ≥ 0 regardless
  // of base sign. `nonneg` (becomes `positive` only if the base is
  // provably nonzero, which we don't track).
  if (
    bx !== undefined &&
    Number.isFinite(bx) &&
    Number.isInteger(bx) &&
    bx % 2 === 0
  ) {
    return "nonneg";
  }
  if (signIsNonneg(a.sign) && signIsNonneg(b.sign)) {
    // base positive → positive; base nonneg → nonneg.
    if (a.sign === "positive") return "positive";
    return "nonneg";
  }
  return "unknown";
}

/** Check the base/exponent pair for a possible complex-result case
 *  that mtoc2 v1 doesn't support. Returns null when accepted; an
 *  error message when rejected. Span attribution is the caller's
 *  responsibility. */
function checkDomain(a: NumericType, b: NumericType): string | null {
  // Easy accept: base is statically nonneg.
  if (signIsNonneg(a.sign)) return null;

  // Base may be negative — then exponent must be a statically-known
  // integer for the result to stay real.
  if (isExactInteger(b)) return null;

  // Exponent is an exact tensor with all-integer values: also OK.
  const bArr = exactRealArray(b);
  if (bArr !== undefined && exactArrayAllInteger(bArr)) return null;

  // If the base is an exact tensor that happens to be all-nonneg,
  // accept (we can prove no negative-base × fractional-exponent slot).
  const aArr = exactRealArray(a);
  if (aArr !== undefined && exactArrayAllNonneg(aArr)) return null;

  return (
    `'.^' with possibly-negative base and non-integer exponent is not yet ` +
    `supported (would produce a complex result; mtoc2 has no complex type). ` +
    `Use 'abs(base)' or ensure the base is statically nonneg, or pass an ` +
    `integer exponent.`
  );
}

/** Shape-compat check (same shape, or scalar on one side). Mirrors
 *  `elemwiseResultShape` in `_elemwise.ts`. */
function powerShape(
  a: NumericType,
  b: NumericType,
  span: Span
): number[] | null {
  const aMulti = isMultiElement(a);
  const bMulti = isMultiElement(b);
  if (!aMulti && !bMulti) return null;
  if (!aMulti) return b.shape ? b.shape.slice() : null;
  if (!bMulti) return a.shape ? a.shape.slice() : null;
  if (!a.shape || !b.shape) {
    throw new UnsupportedConstruct(
      `'.^' on tensors of unknown shape not yet supported`,
      span
    );
  }
  if (
    a.shape.length !== b.shape.length ||
    !a.shape.every((s, i) => s === b.shape![i])
  ) {
    throw new UnsupportedConstruct(
      `'.^' shape mismatch (${a.shape.join("×")} vs ${b.shape.join("×")}); broadcast beyond scalar-on-one-side is not yet supported`,
      span
    );
  }
  return a.shape.slice();
}

export const power: Builtin = {
  name: "power",
  arity: 2,
  transfer(argTypes, span) {
    requireRealDouble(argTypes[0], `'.^' arg 1`, span);
    requireRealDouble(argTypes[1], `'.^' arg 2`, span);
    const a = argTypes[0] as NumericType;
    const b = argTypes[1] as NumericType;

    const reject = checkDomain(a, b);
    if (reject !== null) throw new UnsupportedConstruct(reject, span);

    const outShape = powerShape(a, b, span);

    if (outShape === null) {
      // Pure scalar OP scalar.
      const ax = exactDouble(a);
      const bx = exactDouble(b);
      if (ax !== undefined && bx !== undefined) {
        const v = Math.pow(ax, bx);
        if (Number.isFinite(v)) return scalarDouble(signFromNumber(v), v);
      }
      return scalarDouble(powerSign(a, b));
    }

    // Tensor result — try exact-fold within the element cap.
    const aArr = exactRealArray(a);
    const bArr = exactRealArray(b);
    const ax = exactDouble(a);
    const bx = exactDouble(b);
    const aIsExact = aArr !== undefined || ax !== undefined;
    const bIsExact = bArr !== undefined || bx !== undefined;
    const total = outShape.reduce((p, q) => p * q, 1);
    if (aIsExact && bIsExact && total <= EXACT_ARRAY_MAX_ELEMENTS) {
      const data = new Float64Array(total);
      let allFinite = true;
      for (let i = 0; i < total; i++) {
        const av = aArr ? aArr[i] : (ax as number);
        const bv = bArr ? bArr[i] : (bx as number);
        const v = Math.pow(av, bv);
        if (!Number.isFinite(v)) {
          allFinite = false;
          break;
        }
        data[i] = v;
      }
      if (allFinite) return tensorDouble(outShape, data);
    }
    const out = tensorDouble(outShape);
    out.sign = powerSign(a, b);
    return out;
  },
  codegenC(argsC, argTypes) {
    const aMulti = isMultiElement(argTypes[0]);
    const bMulti = isMultiElement(argTypes[1]);
    if (!aMulti && !bMulti) {
      return `pow(${argsC[0]}, ${argsC[1]})`;
    }
    if (aMulti && bMulti) {
      return `mtoc2_tensor_power_tt(${argsC[0]}, ${argsC[1]})`;
    }
    if (aMulti) {
      return `mtoc2_tensor_power_ts(${argsC[0]}, ${argsC[1]})`;
    }
    // scalar .^ tensor — not commutative.
    return `mtoc2_tensor_power_st(${argsC[0]}, ${argsC[1]})`;
  },
  runtimeDeps: ["mtoc2_tensor_elemwise_real_fn"],
};

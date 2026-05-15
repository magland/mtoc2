/**
 * `norm(v)` — vector 2-norm (Euclidean).
 *
 * Scope today:
 *  - Scalar (real or complex): `abs(v)`.
 *  - 1-D vector (row or column, real or complex): `sqrt(sum(|x_i|^2))`.
 *  - Anything else (matrix, N-D tensor, struct, char, etc.) is rejected
 *    with a span. Matrix-norm forms (`norm(M)`, `norm(M, 'fro')`,
 *    `norm(M, 1)`, `norm(M, Inf)`) are deferred until a test script
 *    needs them.
 *
 * Result type is always real scalar `nonneg`.
 *
 * Codegen routes scalar inputs to `fabs` / `mtoc2_cabs` (already in
 * the runtime via `abs`); tensor inputs to `mtoc2_norm2_real` /
 * `mtoc2_norm2_complex` in `tensor_norm.h`.
 */
import {
  type NumericType,
  isMultiElement,
  isNumeric,
  isRowVecTy,
  isColVecTy,
  isScalar,
  scalarDouble,
  signFromNumber,
  typeToString,
} from "../../types.js";
import { TypeError } from "../../errors.js";
import type { Builtin } from "../registry.js";
import { exactDouble, exactComplex, exactRealArray } from "../_shared.js";

export const norm: Builtin = {
  name: "norm",
  arity: 1,
  transfer(argTypes, span) {
    const a = argTypes[0];
    if (!isNumeric(a)) {
      throw new TypeError(
        `'norm' arg must be a real or complex numeric (got ${typeToString(a)})`,
        span
      );
    }
    if (a.elem !== "double") {
      throw new TypeError(
        `'norm' arg must be double (got ${a.elem})`,
        span
      );
    }
    if (isScalar(a)) {
      if (!a.isComplex) {
        const x = exactDouble(a);
        if (x !== undefined) {
          const v = Math.abs(x);
          if (Number.isFinite(v)) return scalarDouble(signFromNumber(v), v);
        }
        return scalarDouble("nonneg");
      }
      const cx = exactComplex(a);
      if (cx !== undefined) {
        const v = Math.hypot(cx.re, cx.im);
        if (Number.isFinite(v)) return scalarDouble(signFromNumber(v), v);
      }
      return scalarDouble("nonneg");
    }
    if (!isRowVecTy(a) && !isColVecTy(a)) {
      throw new TypeError(
        `'norm' input must be a vector (got ${typeToString(a)}); ` +
          `matrix-norm forms are not yet supported`,
        span
      );
    }
    // Vector path. Fold when the input is fully exact.
    if (!a.isComplex) {
      const arr = exactRealArray(a);
      if (arr !== undefined) {
        let acc = 0;
        for (let i = 0; i < arr.length; i++) acc += arr[i] * arr[i];
        const v = Math.sqrt(acc);
        if (Number.isFinite(v)) return scalarDouble(signFromNumber(v), v);
      }
      return scalarDouble("nonneg");
    }
    // Complex vector path. Fold when the split-buffer exact is set.
    if (
      a.exact !== undefined &&
      typeof a.exact === "object" &&
      !(a.exact instanceof Float64Array) &&
      (a.exact as { re?: unknown }).re instanceof Float64Array
    ) {
      const cx = a.exact as { re: Float64Array; im: Float64Array };
      let acc = 0;
      for (let i = 0; i < cx.re.length; i++) {
        acc += cx.re[i] * cx.re[i] + cx.im[i] * cx.im[i];
      }
      const v = Math.sqrt(acc);
      if (Number.isFinite(v)) return scalarDouble(signFromNumber(v), v);
    }
    return scalarDouble("nonneg");
  },
  codegenC(argsC, argTypes) {
    const a = argTypes[0] as NumericType;
    if (isMultiElement(a)) {
      return a.isComplex
        ? `mtoc2_norm2_complex(${argsC[0]})`
        : `mtoc2_norm2_real(${argsC[0]})`;
    }
    return a.isComplex ? `mtoc2_cabs(${argsC[0]})` : `fabs(${argsC[0]})`;
  },
  runtimeDeps: ["mtoc2_tensor_norm", "mtoc2_cscalar"],
};

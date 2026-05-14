/**
 * `transpose` builtin — backs the `.'` and `'` unary operators.
 *
 * For real-typed inputs (the only kind mtoc2 has today) the two
 * operators are identical; both route here. When complex support
 * lands, `'` (conjugate transpose) gets its own builtin and `.'`
 * keeps this one.
 *
 * Shape rules (mtoc2 v1, MATLAB-style):
 *   - Scalar  → scalar (identity).
 *   - 1×N row → N×1 col.   `exact: Float64Array` carries unchanged.
 *   - N×1 col → 1×N row.   `exact: Float64Array` carries unchanged.
 *   - M×N matrix → N×M.    `exact` carries with elements shuffled.
 *   - Empty   → swap dims (0×N → N×0, M×0 → 0×M).
 *   - Rank ≥ 3 rejected with an UnsupportedConstruct.
 *
 * Numbl's `mTranspose` (helpers/arithmetic.ts ~line 1221) collapses
 * trailing dims of an ND tensor into "cols" via `tensorSize2D` and
 * runs the same 2-D shuffle. mtoc2 v1 follows MATLAB and rejects ND
 * — the type-system carries every axis precisely, so silent
 * trailing-dim flattening would be more surprising than helpful.
 *
 * Sign passes through. The result is owned (a fresh tensor); the
 * existing ANF / scope-exit-free pipeline handles it via the
 * `Call`-returning-multi-element classification — no IR changes
 * needed.
 */

import { TypeError, UnsupportedConstruct } from "../../errors.js";
import {
  isNumeric,
  isScalar,
  isMultiElement,
  tensorDouble,
  scalarDouble,
  signFromNumber,
  typeToString,
} from "../../types.js";
import type { NumericType } from "../../types.js";
import type { Builtin } from "../registry.js";
import { exactDouble } from "../_shared.js";

/** Shuffle an exact buffer for a 2-D transpose. Column-major source
 *  (m × n) → column-major destination (n × m): source element at
 *  (sr, sc) maps to destination element at (sc, sr), i.e.
 *  `out[sc + sr*n] = src[sr + sc*m]`. Vector cases (row or col)
 *  collapse to no-op shuffles since the column-major layout for
 *  `1×n` and `n×1` is the same flat buffer, but the formula handles
 *  them correctly. */
function transposeExact(src: Float64Array, m: number, n: number): Float64Array {
  const out = new Float64Array(m * n);
  for (let sc = 0; sc < n; sc++) {
    for (let sr = 0; sr < m; sr++) {
      out[sc + sr * n] = src[sr + sc * m];
    }
  }
  return out;
}

export const transpose: Builtin = {
  name: "transpose",
  arity: 1,
  transfer(argTypes, span) {
    const a = argTypes[0];
    if (!isNumeric(a)) {
      throw new TypeError(
        `transpose argument must be numeric (got ${typeToString(a)})`,
        span
      );
    }
    if (a.isComplex) {
      throw new TypeError(
        `transpose on complex tensors is not yet supported (no complex type in mtoc2)`,
        span
      );
    }
    if (a.elem !== "double" && a.elem !== "logical") {
      throw new TypeError(
        `transpose argument must be a real double or logical (got ${a.elem})`,
        span
      );
    }

    // Scalar identity. Folds through with sign / exact intact.
    if (isScalar(a)) {
      const v = exactDouble(a);
      if (v !== undefined) {
        return scalarDouble(signFromNumber(v), v);
      }
      return scalarDouble(a.sign);
    }

    // ND rejection. mtoc2's `dims` length is the source of truth (the
    // type-system carries every axis precisely; we don't collapse like
    // numbl's `tensorSize2D`).
    if (a.dims.length !== 2) {
      throw new UnsupportedConstruct(
        `transpose requires a 2-D operand (got ${a.dims.length}-D); ` +
          `use 'permute' for higher-rank reorderings ` +
          `(numbl flattens trailing dims into cols; mtoc2 follows MATLAB and rejects)`,
        span
      );
    }

    // Need both dims to be exact to know the result shape statically.
    // Slice reads of an unknown-length range produce `unknown` dims;
    // a slice taken of a known-shape base typically still has a
    // statically-known shape, but we defer the unknown-shape case to
    // a followup slope (the ND helper would need a runtime
    // shape-aware transpose; not needed by chunkie_simple).
    if (a.shape === undefined) {
      throw new UnsupportedConstruct(
        `transpose of a tensor with unknown shape is not yet supported`,
        span
      );
    }

    const m = a.shape[0];
    const n = a.shape[1];
    const newShape = [n, m];

    // Exact-fold path: shuffle the data buffer and attach to the
    // result type. tensorDouble will reconcile sign from the array.
    if (a.exact instanceof Float64Array) {
      const out = transposeExact(a.exact, m, n);
      return tensorDouble(newShape, out);
    }
    return tensorDouble(newShape);
  },
  codegenC(argsC, argTypes) {
    const a = argTypes[0] as NumericType;
    // Scalar identity at the C level too. The lowerer's scalar branch
    // already folds away the call when the input is exact, but a
    // dynamic-scalar transpose can still reach codegen — passthrough.
    if (!isMultiElement(a)) {
      return argsC[0];
    }
    return `mtoc2_tensor_transpose(${argsC[0]})`;
  },
  runtimeDeps: ["mtoc2_tensor_transpose"],
};

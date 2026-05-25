/**
 * `dot(a, b)` — real-double dot product.
 *
 * Numbl semantics
 * (`numbl-core/interpreter/builtins/linear-algebra.ts`):
 *   - Two same-length 1-D vectors (any combination of row / column /
 *     scalar) → scalar `sum_i a_i * b_i`.
 *   - Two matrices of the **same** shape M×N → column-wise dot,
 *     returned as a 1×N row vector.
 *   - Length / shape mismatch → runtime error.
 *   - Complex inputs use `sum(conj(a) .* b)` — out of scope for
 *     this PR (real chunkie call sites only). Reject with a clear
 *     `UnsupportedConstruct` so the path is well-documented.
 *
 * Real folding: when both inputs are exact and small enough, the
 * result is computed at type-check time and lands as `exact` on the
 * output type, so call sites used in `if`-conds get the static fold.
 */

import { TypeError, UnsupportedConstruct } from "../../../lowering/errors.js";
import {
  EXACT_ARRAY_MAX_ELEMENTS,
  isMultiElement,
  isNumeric,
  isScalar,
  scalarDouble,
  shapeNumel,
  signFromNumber,
  tensorDouble,
  type NumericType,
  type Type,
  typeToString,
} from "../../../lowering/types.js";
import type { Builtin } from "../../registry.js";
import { exactDouble, exactRealArray } from "../_shared.js";
import type { RuntimeTensor } from "../../../runtime/value.js";
import {
  mtoc2_dot_real as jsDotReal,
  mtoc2_dot_real_matrix as jsDotRealMatrix,
} from "../../runtime/snippets.gen.js";

function requireRealNumeric(t: Type, what: string): NumericType {
  if (!isNumeric(t)) {
    throw new TypeError(
      `${what} must be a real numeric (got ${typeToString(t)})`
    );
  }
  if (t.isComplex) {
    throw new UnsupportedConstruct(
      `${what} complex 'dot' is not yet supported (numbl uses sum(conj(a).*b))`
    );
  }
  if (t.elem !== "double" && t.elem !== "logical") {
    throw new TypeError(`${what} must be double or logical (got ${t.elem})`);
  }
  return t;
}

function isVectorLike(t: NumericType): boolean {
  if (isScalar(t)) return true;
  // 1-D vector means: 2-D with one axis exactly 1.
  if (t.dims.length !== 2) return false;
  const aOne = t.dims[0].kind === "exact" && t.dims[0].value === 1;
  const bOne = t.dims[1].kind === "exact" && t.dims[1].value === 1;
  return aOne || bOne;
}

function knownNumel(t: NumericType): number | undefined {
  return t.shape !== undefined ? shapeNumel(t.shape) : undefined;
}

function matrixCols(t: NumericType): number | undefined {
  if (t.shape === undefined || t.shape.length !== 2) return undefined;
  return t.shape[1];
}

function realScalar(re: number): NumericType {
  return Number.isFinite(re)
    ? scalarDouble(signFromNumber(re), re)
    : scalarDouble();
}

export const dot: Builtin = {
  name: "dot",
  transfer(argTypes, nargout) {
    if (argTypes.length !== 2) {
      throw new TypeError(`'dot' expects 2 arg(s), got ${argTypes.length}`);
    }
    if (nargout !== 1) {
      throw new UnsupportedConstruct(
        `'dot' does not support multi-output (nargout=${nargout})`
      );
    }
    const a = requireRealNumeric(argTypes[0], `'dot' arg 1`);
    const b = requireRealNumeric(argTypes[1], `'dot' arg 2`);

    // Both scalar: just a multiplication. Numbl treats scalars as
    // length-1 vectors.
    if (isScalar(a) && isScalar(b)) {
      const xa = exactDouble(a);
      const xb = exactDouble(b);
      if (xa !== undefined && xb !== undefined) {
        return [realScalar(xa * xb)];
      }
      return [scalarDouble()];
    }

    const aVec = isVectorLike(a);
    const bVec = isVectorLike(b);
    if (aVec && bVec) {
      const na = knownNumel(a);
      const nb = knownNumel(b);
      if (na !== undefined && nb !== undefined && na !== nb) {
        throw new TypeError(
          `'dot' vectors must be same length (got ${na} and ${nb})`
        );
      }
      const arrA = exactRealArray(a);
      const arrB = exactRealArray(b);
      if (
        arrA !== undefined &&
        arrB !== undefined &&
        arrA.length === arrB.length &&
        arrA.length <= EXACT_ARRAY_MAX_ELEMENTS
      ) {
        let acc = 0;
        for (let i = 0; i < arrA.length; i++) acc += arrA[i] * arrB[i];
        return [realScalar(acc)];
      }
      return [scalarDouble()];
    }

    // Matrix form: both args are full matrices of the same shape.
    if (
      !aVec &&
      !bVec &&
      a.shape !== undefined &&
      b.shape !== undefined &&
      a.shape.length === 2 &&
      b.shape.length === 2 &&
      a.shape[0] === b.shape[0] &&
      a.shape[1] === b.shape[1]
    ) {
      const cols = matrixCols(a) ?? 0;
      const arrA = exactRealArray(a);
      const arrB = exactRealArray(b);
      if (
        arrA !== undefined &&
        arrB !== undefined &&
        arrA.length === arrB.length &&
        arrA.length <= EXACT_ARRAY_MAX_ELEMENTS
      ) {
        const rows = a.shape[0];
        const out = new Float64Array(cols);
        for (let j = 0; j < cols; j++) {
          let acc = 0;
          for (let i = 0; i < rows; i++) {
            const off = j * rows + i;
            acc += arrA[off] * arrB[off];
          }
          out[j] = acc;
        }
        return [tensorDouble([1, cols], out)];
      }
      return [tensorDouble([1, cols])];
    }

    throw new UnsupportedConstruct(
      `'dot' supports two vectors of the same length, or two matrices of the same shape ` +
        `(got ${typeToString(a)} and ${typeToString(b)})`
    );
  },
  emitC({ argsC, argTypes, useRuntime }) {
    const a = argTypes[0] as NumericType;
    const b = argTypes[1] as NumericType;
    if (isMultiElement(a) && isMultiElement(b)) {
      if (isVectorLike(a) || isVectorLike(b)) {
        useRuntime("mtoc2_dot_real");
        return `mtoc2_dot_real(${argsC[0]}, ${argsC[1]})`;
      }
      useRuntime("mtoc2_dot_real");
      return `mtoc2_dot_real_matrix(${argsC[0]}, ${argsC[1]})`;
    }
    // Scalar/scalar or scalar-vs-length-1-tensor → scalar product.
    // ANF guarantees vector args are bare Var lvalues, but mixing
    // scalar + tensor here would have been rejected by transfer (no
    // size match), so this is just scalar × scalar.
    return `((${argsC[0]}) * (${argsC[1]}))`;
  },
  emitJs({ argsJs, argTypes, useRuntime }) {
    const a = argTypes[0] as NumericType;
    const b = argTypes[1] as NumericType;
    if (isMultiElement(a) && isMultiElement(b)) {
      if (isVectorLike(a) || isVectorLike(b)) {
        useRuntime("mtoc2_dot_real");
        return `mtoc2_dot_real(${argsJs[0]}, ${argsJs[1]})`;
      }
      useRuntime("mtoc2_dot_real");
      return `mtoc2_dot_real_matrix(${argsJs[0]}, ${argsJs[1]})`;
    }
    return `((${argsJs[0]}) * (${argsJs[1]}))`;
  },
  call({ args, argTypes }) {
    const a = argTypes[0] as NumericType;
    const b = argTypes[1] as NumericType;
    if (isMultiElement(a) && isMultiElement(b)) {
      if (isVectorLike(a) || isVectorLike(b)) {
        return [
          jsDotReal(
            args[0] as RuntimeTensor,
            args[1] as RuntimeTensor
          ) as number,
        ];
      }
      return [
        jsDotRealMatrix(
          args[0] as RuntimeTensor,
          args[1] as RuntimeTensor
        ) as unknown as RuntimeTensor,
      ];
    }
    const va = typeof args[0] === "number" ? args[0] : Number(args[0]);
    const vb = typeof args[1] === "number" ? args[1] : Number(args[1]);
    return [va * vb];
  },
};

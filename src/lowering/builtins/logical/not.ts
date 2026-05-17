/**
 * `not` builtin — backs the `~` unary operator.
 *
 * Elementwise logical NOT. Numbl's `not(v)` in
 * `runtime/runtimeOperators.ts` line 100:
 *   - scalar 0          → logical true
 *   - scalar nonzero    → logical false
 *   - tensor            → logical tensor of same shape; element-wise
 *                         `(x == 0) ? 1 : 0`
 *
 * Type result is always logical (mtoc2's `NumericType.elem = "logical"`).
 * Sign is `nonneg` since outputs are in {0, 1}.
 */

import { TypeError, UnsupportedConstruct } from "../../errors.js";
import {
  type NumericType,
  type DimInfo,
  EXACT_ARRAY_MAX_ELEMENTS,
  isMultiElement,
  isNumeric,
  isScalar,
  scalarLogical,
  shapeNumel,
  typeToString,
} from "../../types.js";
import type { Builtin } from "../registry.js";
import { exactDouble, exactRealArray, exactComplex } from "../_shared.js";

function logicalTensor(
  dims: DimInfo[],
  shape: number[] | undefined,
  exact?: Float64Array
): NumericType {
  const t: NumericType = {
    kind: "Numeric",
    elem: "logical",
    isComplex: false,
    dims,
    sign: "nonneg",
  };
  if (shape !== undefined) t.shape = shape.slice();
  if (exact !== undefined) t.exact = exact;
  return t;
}

export const notBuiltin: Builtin = {
  name: "not",
  arity: 1,
  transfer(argTypes, span) {
    const a = argTypes[0];
    if (!isNumeric(a)) {
      throw new TypeError(
        `'~' / 'not' arg must be numeric (got ${typeToString(a)})`,
        span
      );
    }
    if (a.elem !== "double" && a.elem !== "logical") {
      throw new TypeError(
        `'~' / 'not' arg must be a real double or logical (got ${a.elem})`,
        span
      );
    }
    if (a.isComplex && isMultiElement(a)) {
      throw new UnsupportedConstruct(
        `'~' on a complex tensor is not yet supported`,
        span
      );
    }

    // Scalar input → scalar logical, sign nonneg.
    if (isScalar(a)) {
      if (a.isComplex) {
        const cx = exactComplex(a);
        if (cx !== undefined) {
          return scalarLogical(cx.re === 0 && cx.im === 0);
        }
        return scalarLogical();
      }
      const v = exactDouble(a);
      if (v !== undefined) {
        return scalarLogical(v === 0);
      }
      return scalarLogical();
    }

    // Tensor input → logical tensor of same shape. Exact-fold within
    // the element-count cap.
    const arr = exactRealArray(a);
    if (a.shape !== undefined && arr !== undefined) {
      const total = shapeNumel(a.shape);
      if (total <= EXACT_ARRAY_MAX_ELEMENTS) {
        const out = new Float64Array(arr.length);
        for (let i = 0; i < arr.length; i++) {
          out[i] = arr[i] === 0 ? 1.0 : 0.0;
        }
        return logicalTensor(a.dims, a.shape, out);
      }
    }
    return logicalTensor(a.dims, a.shape);
  },
  codegenC(argsC, argTypes) {
    if (isMultiElement(argTypes[0])) {
      return `mtoc2_tensor_not(${argsC[0]})`;
    }
    const a = argTypes[0] as NumericType;
    if (a.isComplex) {
      // Complex scalar is "false" iff both parts are exactly 0.
      return `(mtoc2_cnonzero(${argsC[0]}) ? 0.0 : 1.0)`;
    }
    // Scalar: emit `(x == 0.0 ? 1.0 : 0.0)`. Using `!` on a double is
    // technically valid C, but the explicit comparison is clearer and
    // is what numbl's logical layer reads as.
    return `((${argsC[0]}) == 0.0 ? 1.0 : 0.0)`;
  },
  runtimeDeps: ["mtoc2_tensor_logical_real", "mtoc2_cscalar"],
};

/**
 * `conj(z)` — complex conjugate. Accepts real or complex, scalar or
 * tensor. For real input it's the identity; for complex input it
 * flips the sign of the imaginary part.
 *
 * The tensor codegen activates `mtoc2_tensor_unary_complex_math`
 * (defines `mtoc2_tensor_conj_complex`); real-tensor inputs return
 * the operand directly (identity).
 */

import {
  type NumericType,
  scalarDouble,
  scalarComplex,
  tensorComplex,
  tensorComplexFromDims,
  tensorDouble,
  tensorDoubleFromDims,
  isMultiElement,
  signFromNumber,
  EXACT_ARRAY_MAX_ELEMENTS,
} from "../../types.js";
import type { Builtin } from "../registry.js";
import {
  requireRealOrComplex,
  exactDouble,
  exactComplex,
  exactRealArray,
} from "../_shared.js";

export const conj: Builtin = {
  name: "conj",
  arity: 1,
  transfer(argTypes, span) {
    requireRealOrComplex(argTypes[0], `'conj' arg`, span);
    const a = argTypes[0] as NumericType;
    if (!isMultiElement(a)) {
      if (a.isComplex) {
        const cx = exactComplex(a);
        if (cx !== undefined) return scalarComplex({ re: cx.re, im: -cx.im });
        return scalarComplex();
      }
      const v = exactDouble(a);
      if (v !== undefined) return scalarDouble(signFromNumber(v), v);
      return scalarDouble(a.sign);
    }
    // Tensor input.
    if (a.isComplex) {
      if (
        a.shape !== undefined &&
        a.exact !== undefined &&
        typeof a.exact === "object" &&
        !(a.exact instanceof Float64Array) &&
        (a.exact as { re?: unknown }).re instanceof Float64Array
      ) {
        const cx = a.exact as { re: Float64Array; im: Float64Array };
        const total = a.shape.reduce((p, q) => p * q, 1);
        if (total <= EXACT_ARRAY_MAX_ELEMENTS) {
          const re = new Float64Array(cx.re.length);
          const im = new Float64Array(cx.im.length);
          for (let i = 0; i < cx.re.length; i++) {
            re[i] = cx.re[i];
            im[i] = -cx.im[i];
          }
          return tensorComplex(a.shape, { re, im });
        }
      }
      return tensorComplexFromDims(a.dims.slice());
    }
    // Real tensor — identity (preserves exact data and sign).
    const arr = exactRealArray(a);
    if (arr !== undefined && a.shape !== undefined) {
      return tensorDouble(a.shape, arr);
    }
    const out = tensorDoubleFromDims(a.dims.slice());
    out.sign = a.sign;
    return out;
  },
  codegenC(argsC, argTypes) {
    const a = argTypes[0] as NumericType;
    if (isMultiElement(a)) {
      if (a.isComplex) return `mtoc2_tensor_conj_complex(${argsC[0]})`;
      // Real tensor — emit a copy so the caller still gets a freshly-
      // owned result (the ANF discipline relies on `Call`-returning-
      // tensor being an owned producer).
      return `mtoc2_tensor_copy(${argsC[0]})`;
    }
    if (a.isComplex) return `mtoc2_cconj(${argsC[0]})`;
    return `(${argsC[0]})`;
  },
  runtimeDeps: [
    "mtoc2_cscalar",
    "mtoc2_tensor_unary_complex_math",
    "mtoc2_tensor_copy",
  ],
};

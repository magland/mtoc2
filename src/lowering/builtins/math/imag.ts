/**
 * `imag(z)` — imaginary part. Accepts scalar real or complex; returns
 * a real double. For real input the result is always 0; for complex
 * input the result is `cimag(z)`.
 */

import {
  type NumericType,
  scalarDouble,
  tensorDoubleFromDims,
  isMultiElement,
  signFromNumber,
} from "../../types.js";
import type { Builtin } from "../registry.js";
import { requireRealOrComplex, exactComplex } from "../_shared.js";

export const imag: Builtin = {
  name: "imag",
  arity: 1,
  transfer(argTypes, span) {
    requireRealOrComplex(argTypes[0], `'imag' arg`, span);
    const a = argTypes[0] as NumericType;
    if (isMultiElement(a)) {
      // Real or complex tensor → real tensor of the same shape.
      const out = tensorDoubleFromDims(a.dims.slice());
      if (!a.isComplex) out.sign = "zero";
      return out;
    }
    if (a.isComplex) {
      const cx = exactComplex(a);
      if (cx !== undefined) {
        return scalarDouble(signFromNumber(cx.im), cx.im);
      }
      return scalarDouble();
    }
    return scalarDouble("zero", 0);
  },
  codegenC(argsC, argTypes) {
    const a = argTypes[0] as NumericType;
    if (isMultiElement(a)) {
      if (a.isComplex) return `mtoc2_tensor_imag_complex(${argsC[0]})`;
      // Real tensor — imag is all zeros. Build via 0 * the input so
      // the codegen produces an owned freshly-allocated tensor.
      return `mtoc2_tensor_times_ts(${argsC[0]}, 0.0)`;
    }
    if (a.isComplex) return `mtoc2_cimag(${argsC[0]})`;
    return `0.0`;
  },
  runtimeDeps: [
    "mtoc2_cscalar",
    "mtoc2_tensor_unary_complex_math",
    "mtoc2_tensor_elemwise_real",
  ],
};

/**
 * `real(z)` — real part. Accepts scalar real or complex; returns a
 * real double. For real input it's the identity; for complex input
 * the result is `creal(z)`.
 */

import {
  type NumericType,
  scalarDouble,
  tensorDoubleFromDims,
  isMultiElement,
  signFromNumber,
} from "../../types.js";
import type { Builtin } from "../registry.js";
import { requireRealOrComplex, exactDouble, exactComplex } from "../_shared.js";

export const real: Builtin = {
  name: "real",
  arity: 1,
  transfer(argTypes, span) {
    requireRealOrComplex(argTypes[0], `'real' arg`, span);
    const a = argTypes[0] as NumericType;
    if (isMultiElement(a)) {
      const out = tensorDoubleFromDims(a.dims.slice());
      if (!a.isComplex) out.sign = a.sign;
      return out;
    }
    if (a.isComplex) {
      const cx = exactComplex(a);
      if (cx !== undefined) {
        return scalarDouble(signFromNumber(cx.re), cx.re);
      }
      return scalarDouble();
    }
    // Real scalar input — identity.
    const v = exactDouble(a);
    if (v !== undefined) return scalarDouble(signFromNumber(v), v);
    return scalarDouble(a.sign);
  },
  codegenC(argsC, argTypes) {
    const a = argTypes[0] as NumericType;
    if (isMultiElement(a)) {
      if (a.isComplex) return `mtoc2_tensor_real_complex(${argsC[0]})`;
      // Real tensor — identity (copy, since this returns a fresh owned value).
      return `mtoc2_tensor_copy(${argsC[0]})`;
    }
    if (a.isComplex) return `mtoc2_creal(${argsC[0]})`;
    return `(${argsC[0]})`;
  },
  runtimeDeps: [
    "mtoc2_cscalar",
    "mtoc2_tensor_unary_complex_math",
    "mtoc2_tensor_copy",
  ],
};

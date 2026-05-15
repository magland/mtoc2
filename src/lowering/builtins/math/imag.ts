/**
 * `imag(z)` — imaginary part. Accepts scalar real or complex; returns
 * a real double. For real input the result is always 0; for complex
 * input the result is `cimag(z)`.
 */

import { UnsupportedConstruct } from "../../errors.js";
import {
  type NumericType,
  scalarDouble,
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
      throw new UnsupportedConstruct(
        `'imag' on a tensor is not yet supported`,
        span
      );
    }
    if (a.isComplex) {
      const cx = exactComplex(a);
      if (cx !== undefined) {
        return scalarDouble(signFromNumber(cx.im), cx.im);
      }
      return scalarDouble();
    }
    // Real input — always 0.
    return scalarDouble("zero", 0);
  },
  codegenC(argsC, argTypes) {
    const a = argTypes[0] as NumericType;
    if (a.isComplex) return `mtoc2_cimag(${argsC[0]})`;
    return `0.0`;
  },
  runtimeDeps: ["mtoc2_cscalar"],
};

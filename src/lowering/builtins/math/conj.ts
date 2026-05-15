/**
 * `conj(z)` — complex conjugate. Accepts scalar real or complex.
 * For real input it's the identity; for complex input the result is
 * `conj(z)` (a complex with the same `re` and negated `im`).
 */

import { UnsupportedConstruct } from "../../errors.js";
import {
  type NumericType,
  scalarDouble,
  scalarComplex,
  isMultiElement,
  signFromNumber,
} from "../../types.js";
import type { Builtin } from "../registry.js";
import { requireRealOrComplex, exactDouble, exactComplex } from "../_shared.js";

export const conj: Builtin = {
  name: "conj",
  arity: 1,
  transfer(argTypes, span) {
    requireRealOrComplex(argTypes[0], `'conj' arg`, span);
    const a = argTypes[0] as NumericType;
    if (isMultiElement(a)) {
      throw new UnsupportedConstruct(
        `'conj' on a tensor is not yet supported`,
        span
      );
    }
    if (a.isComplex) {
      const cx = exactComplex(a);
      if (cx !== undefined) {
        return scalarComplex({ re: cx.re, im: -cx.im });
      }
      return scalarComplex();
    }
    // Real input — identity.
    const v = exactDouble(a);
    if (v !== undefined) return scalarDouble(signFromNumber(v), v);
    return scalarDouble(a.sign);
  },
  codegenC(argsC, argTypes) {
    const a = argTypes[0] as NumericType;
    if (a.isComplex) return `conj(${argsC[0]})`;
    return `(${argsC[0]})`;
  },
};

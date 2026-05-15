/**
 * `real(z)` — real part. Accepts scalar real or complex; returns a
 * real double. For real input it's the identity; for complex input
 * the result is `creal(z)`.
 */

import { UnsupportedConstruct } from "../../errors.js";
import {
  type NumericType,
  scalarDouble,
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
      throw new UnsupportedConstruct(
        `'real' on a tensor is not yet supported`,
        span
      );
    }
    if (a.isComplex) {
      const cx = exactComplex(a);
      if (cx !== undefined) {
        return scalarDouble(signFromNumber(cx.re), cx.re);
      }
      return scalarDouble();
    }
    // Real input — identity.
    const v = exactDouble(a);
    if (v !== undefined) return scalarDouble(signFromNumber(v), v);
    return scalarDouble(a.sign);
  },
  codegenC(argsC, argTypes) {
    const a = argTypes[0] as NumericType;
    if (a.isComplex) return `mtoc2_creal(${argsC[0]})`;
    return `(${argsC[0]})`;
  },
  runtimeDeps: ["mtoc2_cscalar"],
};

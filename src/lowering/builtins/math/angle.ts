/**
 * `angle(z)` — phase angle in radians. Returns `atan2(im, re)`. For
 * real input the result is 0 when the value is non-negative, π when
 * negative; complex input yields `carg(z)`.
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

export const angle: Builtin = {
  name: "angle",
  arity: 1,
  transfer(argTypes, span) {
    requireRealOrComplex(argTypes[0], `'angle' arg`, span);
    const a = argTypes[0] as NumericType;
    if (isMultiElement(a)) {
      throw new UnsupportedConstruct(
        `'angle' on a tensor is not yet supported`,
        span
      );
    }
    if (a.isComplex) {
      const cx = exactComplex(a);
      if (cx !== undefined) {
        const v = Math.atan2(cx.im, cx.re);
        if (Number.isFinite(v)) return scalarDouble(signFromNumber(v), v);
      }
      return scalarDouble();
    }
    const v = exactDouble(a);
    if (v !== undefined) {
      const r = Math.atan2(0, v);
      if (Number.isFinite(r)) return scalarDouble(signFromNumber(r), r);
    }
    return scalarDouble();
  },
  codegenC(argsC, argTypes) {
    const a = argTypes[0] as NumericType;
    if (a.isComplex) return `carg(${argsC[0]})`;
    return `atan2(0.0, ${argsC[0]})`;
  },
};

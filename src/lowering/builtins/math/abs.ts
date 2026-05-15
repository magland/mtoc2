import { UnsupportedConstruct } from "../../errors.js";
import {
  type NumericType,
  scalarDouble,
  isMultiElement,
  isScalar,
  signFromNumber,
} from "../../types.js";
import type { Builtin } from "../registry.js";
import { requireRealOrComplex, exactComplex } from "../_shared.js";
import { defineUnaryRealMath } from "./_unary_real.js";

/** Real-input `abs`. Result is `nonneg` in general; `positive` when
 *  input is known to be nonzero (`positive`, `negative`, or `nonzero`). */
const absReal = defineUnaryRealMath({
  name: "abs",
  cFnReal: "fabs",
  jsFn: Math.abs,
  signRule: t => {
    if (t.sign === "positive" || t.sign === "negative" || t.sign === "nonzero")
      return "positive";
    return "nonneg";
  },
});

/** Complex-aware `abs`. Real inputs route through the existing real
 *  builtin (preserving its sign refinement and tensor path); scalar
 *  complex inputs return `hypot(creal, cimag)` as a real double. */
export const abs: Builtin = {
  name: "abs",
  arity: 1,
  transfer(argTypes, span) {
    requireRealOrComplex(argTypes[0], `'abs' arg`, span);
    const a = argTypes[0] as NumericType;
    if (a.isComplex) {
      if (isMultiElement(a)) {
        throw new UnsupportedConstruct(
          `'abs' on a complex tensor is not yet supported`,
          span
        );
      }
      if (!isScalar(a)) {
        throw new UnsupportedConstruct(
          `'abs' on a complex tensor is not yet supported`,
          span
        );
      }
      const cx = exactComplex(a);
      if (cx !== undefined) {
        const v = Math.hypot(cx.re, cx.im);
        if (Number.isFinite(v)) return scalarDouble(signFromNumber(v), v);
      }
      return scalarDouble("nonneg");
    }
    return absReal.transfer(argTypes, span);
  },
  codegenC(argsC, argTypes) {
    const a = argTypes[0] as NumericType;
    if (a.isComplex) {
      return `hypot(creal(${argsC[0]}), cimag(${argsC[0]}))`;
    }
    return absReal.codegenC(argsC, argTypes);
  },
  runtimeDeps: absReal.runtimeDeps,
};

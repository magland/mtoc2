import {
  type NumericType,
  scalarDouble,
  shapeNumel,
  tensorDouble,
  tensorDoubleFromDims,
  isMultiElement,
  isScalar,
  signFromNumber,
  EXACT_ARRAY_MAX_ELEMENTS,
} from "../../types.js";
import { TypeError, UnsupportedConstruct } from "../../errors.js";
import { type Builtin, requireEmitC, requireEmitJs, requireCall } from "../registry.js";
import {
  requireRealOrComplex,
  exactComplex,
  exactComplexArray,
} from "../_shared.js";
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
 *  builtin (preserving its sign refinement and tensor path); complex
 *  inputs return `hypot(creal, cimag)` per-element, with a REAL result
 *  type (different shape contract from the rest of the unary-math
 *  family). */
export const abs: Builtin = {
  name: "abs",
  transfer(argTypes, nargout) {
    if (argTypes.length !== 1) {
      throw new TypeError(`'abs' expects 1 arg(s), got ${argTypes.length}`);
    }
    if (nargout !== 1) {
      throw new UnsupportedConstruct(
        `'abs' does not support multi-output (nargout=${nargout})`
      );
    }
    requireRealOrComplex(argTypes[0], `'abs' arg`);
    const a = argTypes[0] as NumericType;
    if (a.isComplex) {
      if (isScalar(a)) {
        const cx = exactComplex(a);
        if (cx !== undefined) {
          const v = Math.hypot(cx.re, cx.im);
          if (Number.isFinite(v)) return [scalarDouble(signFromNumber(v), v)];
        }
        return [scalarDouble("nonneg")];
      }
      // Complex tensor → real tensor (magnitude per element). Fold
      // via the split-buffer `{re, im}` exact carrier when present
      // and small enough.
      const cx = exactComplexArray(a);
      if (cx !== undefined && a.shape !== undefined) {
        const total = shapeNumel(a.shape);
        if (total <= EXACT_ARRAY_MAX_ELEMENTS) {
          const out = new Float64Array(total);
          for (let i = 0; i < total; i++) {
            out[i] = Math.hypot(cx.re[i], cx.im[i]);
          }
          return [tensorDouble(a.shape, out)];
        }
      }
      const out = tensorDoubleFromDims(a.dims.slice());
      out.sign = "nonneg";
      return [out];
    }
    return absReal.transfer(argTypes, nargout);
  },
  emitC(args) {
    const { argsC, argTypes, useRuntime } = args;
    const a = argTypes[0] as NumericType;
    if (a.isComplex) {
      useRuntime("mtoc2_cscalar");
      if (isMultiElement(a)) {
        useRuntime("mtoc2_tensor_unary_complex_math");
        return `mtoc2_tensor_abs_complex(${argsC[0]})`;
      }
      return `mtoc2_cabs(${argsC[0]})`;
    }
    return requireEmitC(absReal)(args);
  },
  // Complex paths land alongside the JS complex runtime later. Real
  // paths delegate to `absReal`'s factory-supplied emitJs/call.
  emitJs(args) {
    const a = args.argTypes[0] as NumericType;
    if (a.isComplex) {
      throw new UnsupportedConstruct(
        `'abs' complex emitJs not yet wired (needs JS complex runtime)`
      );
    }
    return requireEmitJs(absReal)(args);
  },
  call(args) {
    const a = args.argTypes[0] as NumericType;
    if (a.isComplex) {
      throw new UnsupportedConstruct(
        `'abs' complex 'call' not yet wired`
      );
    }
    return requireCall(absReal)(args);
  },
  elementwise: true,
};

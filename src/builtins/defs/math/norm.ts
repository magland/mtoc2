/**
 * `norm(v)` — vector 2-norm (Euclidean).
 *
 * Scope today:
 *  - Scalar (real or complex): `abs(v)`.
 *  - 1-D vector (row or column, real or complex): `sqrt(sum(|x_i|^2))`.
 *  - Anything else (matrix, N-D tensor, struct, char, etc.) is rejected.
 *
 * Result type is always real scalar `nonneg`.
 */
import {
  type NumericType,
  isMultiElement,
  isNumeric,
  isScalar,
  scalarDouble,
  signFromNumber,
  typeToString,
} from "../../../lowering/types.js";
import { TypeError, UnsupportedConstruct } from "../../../lowering/errors.js";
import type { Builtin } from "../../registry.js";
import { isComplexValue, type RuntimeTensor } from "../../../runtime/value.js";
import {
  mtoc2_cabs,
  mtoc2_norm2_real as jsNorm2Real,
  mtoc2_norm2_complex as jsNorm2Complex,
} from "../../runtime/snippets.gen.js";
import {
  exactDouble,
  exactComplex,
  exactComplexArray,
  exactRealArray,
} from "../_shared.js";

export const norm: Builtin = {
  name: "norm",
  transfer(argTypes, nargout) {
    if (argTypes.length !== 1) {
      throw new TypeError(`'norm' expects 1 arg(s), got ${argTypes.length}`);
    }
    if (nargout !== 1) {
      throw new UnsupportedConstruct(
        `'norm' does not support multi-output (nargout=${nargout})`
      );
    }
    const a = argTypes[0];
    if (!isNumeric(a)) {
      throw new TypeError(
        `'norm' arg must be a real or complex numeric (got ${typeToString(a)})`
      );
    }
    if (a.elem !== "double") {
      throw new TypeError(`'norm' arg must be double (got ${a.elem})`);
    }
    if (isScalar(a)) {
      if (!a.isComplex) {
        const x = exactDouble(a);
        if (x !== undefined) {
          const v = Math.abs(x);
          if (Number.isFinite(v)) return [scalarDouble(signFromNumber(v), v)];
        }
        return [scalarDouble("nonneg")];
      }
      const cx = exactComplex(a);
      if (cx !== undefined) {
        const v = Math.hypot(cx.re, cx.im);
        if (Number.isFinite(v)) return [scalarDouble(signFromNumber(v), v)];
      }
      return [scalarDouble("nonneg")];
    }
    const isVecShape =
      (a.dims.length === 2 &&
        a.dims[0].kind === "exact" &&
        a.dims[0].value === 1) ||
      (a.dims.length === 2 &&
        a.dims[1].kind === "exact" &&
        a.dims[1].value === 1);
    if (!isVecShape) {
      throw new TypeError(
        `'norm' input must be a vector (got ${typeToString(a)}); ` +
          `matrix-norm forms are not yet supported`
      );
    }
    if (!a.isComplex) {
      const arr = exactRealArray(a);
      if (arr !== undefined) {
        let acc = 0;
        for (let i = 0; i < arr.length; i++) acc += arr[i] * arr[i];
        const v = Math.sqrt(acc);
        if (Number.isFinite(v)) return [scalarDouble(signFromNumber(v), v)];
      }
      return [scalarDouble("nonneg")];
    }
    const cx = exactComplexArray(a);
    if (cx !== undefined) {
      let acc = 0;
      for (let i = 0; i < cx.re.length; i++) {
        acc += cx.re[i] * cx.re[i] + cx.im[i] * cx.im[i];
      }
      const v = Math.sqrt(acc);
      if (Number.isFinite(v)) return [scalarDouble(signFromNumber(v), v)];
    }
    return [scalarDouble("nonneg")];
  },
  emitC({ argsC, argTypes, useRuntime }) {
    const a = argTypes[0] as NumericType;
    useRuntime("mtoc2_cscalar");
    if (isMultiElement(a)) {
      useRuntime("mtoc2_tensor_norm");
      return a.isComplex
        ? `mtoc2_norm2_complex(${argsC[0]})`
        : `mtoc2_norm2_real(${argsC[0]})`;
    }
    return a.isComplex ? `mtoc2_cabs(${argsC[0]})` : `fabs(${argsC[0]})`;
  },
  emitJs({ argsJs, argTypes, useRuntime }) {
    const a = argTypes[0] as NumericType;
    if (isMultiElement(a)) {
      useRuntime("mtoc2_tensor_norm");
      return a.isComplex
        ? `mtoc2_norm2_complex(${argsJs[0]})`
        : `mtoc2_norm2_real(${argsJs[0]})`;
    }
    if (a.isComplex) {
      useRuntime("mtoc2_cscalar");
      return `mtoc2_cabs(${argsJs[0]})`;
    }
    return `Math.abs(${argsJs[0]})`;
  },
  call({ args, argTypes }) {
    const a = argTypes[0] as NumericType;
    if (isMultiElement(a)) {
      const fn = a.isComplex ? jsNorm2Complex : jsNorm2Real;
      return [fn(args[0] as RuntimeTensor)];
    }
    if (a.isComplex) {
      const v = args[0];
      const cx = isComplexValue(v) ? v : { re: Number(v), im: 0 };
      return [mtoc2_cabs(cx)];
    }
    const v = typeof args[0] === "number" ? args[0] : Number(args[0]);
    return [Math.abs(v)];
  },
};

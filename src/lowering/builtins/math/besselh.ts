/**
 * `besselh(nu, kind, x)` — Hankel function of the first kind.
 *
 * Scope today:
 *  - `nu` must be an exact integer in {0, 1}.
 *  - `kind` must be an exact integer equal to 1.
 *  - `x` must be a real-double scalar or tensor with statically
 *    non-negative argument (matches what chunkie's helm2d uses —
 *    `besselh(0, 1, zk*r)` and `besselh(1, 1, zk*r)` with zk*r > 0).
 *
 * Routes to POSIX `j0`/`j1`/`y0`/`y1` via `<math.h>`. The result is
 * always complex: scalar → `double _Complex`; tensor → complex
 * `mtoc2_tensor_t`.
 */
import {
  type NumericType,
  scalarComplex,
  tensorComplexFromDims,
  isMultiElement,
  isNumeric,
  typeToString,
} from "../../types.js";
import { TypeError, UnsupportedConstruct } from "../../errors.js";
import type { Builtin } from "../registry.js";
import { exactDouble } from "../_shared.js";

function requireExactInt(t: NumericType, what: string, span: any): number {
  const v = exactDouble(t);
  if (v === undefined || !Number.isInteger(v)) {
    throw new UnsupportedConstruct(
      `'besselh' ${what} must be a compile-time integer (got non-exact or non-integer)`,
      span
    );
  }
  return v;
}

export const besselh: Builtin = {
  name: "besselh",
  arity: 3,
  transfer(argTypes, span) {
    for (let i = 0; i < 3; i++) {
      if (!isNumeric(argTypes[i])) {
        throw new TypeError(
          `'besselh' arg ${i + 1} must be a real numeric (got ${typeToString(argTypes[i])})`,
          span
        );
      }
      if ((argTypes[i] as NumericType).isComplex) {
        throw new UnsupportedConstruct(
          `'besselh' with complex args is not yet supported`,
          span
        );
      }
    }
    const nuT = argTypes[0] as NumericType;
    const kindT = argTypes[1] as NumericType;
    const xT = argTypes[2] as NumericType;
    const nu = requireExactInt(nuT, "arg 1 (nu)", span);
    const kind = requireExactInt(kindT, "arg 2 (kind)", span);
    if (nu !== 0 && nu !== 1) {
      throw new UnsupportedConstruct(
        `'besselh' supports only nu in {0, 1} today (got ${nu})`,
        span
      );
    }
    if (kind !== 1) {
      throw new UnsupportedConstruct(
        `'besselh' supports only kind == 1 today (got ${kind})`,
        span
      );
    }
    if (xT.elem !== "double") {
      throw new TypeError(
        `'besselh' arg 3 (x) must be double (got ${xT.elem})`,
        span
      );
    }
    if (!isMultiElement(xT)) {
      return scalarComplex();
    }
    return tensorComplexFromDims(xT.dims.slice());
  },
  codegenC(argsC, argTypes) {
    // nu / kind have been validated as exact at transfer time, but
    // their C args are still evaluated. The lowerer has already
    // computed them into args; we just ignore the C values and
    // dispatch on the type's exact.
    const nu = (argTypes[0] as NumericType).exact as number;
    const xT = argTypes[2] as NumericType;
    if (isMultiElement(xT)) {
      return nu === 0
        ? `mtoc2_tensor_besselh0(${argsC[2]})`
        : `mtoc2_tensor_besselh1(${argsC[2]})`;
    }
    return nu === 0
      ? `mtoc2_besselh0_scalar(${argsC[2]})`
      : `mtoc2_besselh1_scalar(${argsC[2]})`;
  },
  runtimeDeps: ["mtoc2_tensor_besselh", "mtoc2_cscalar"],
};

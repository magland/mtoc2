/**
 * Shared scaffold for elementwise unary real-valued math builtins
 * (`cos`, `sin`, `sqrt`, `abs`, …).
 *
 * Mirrors `arithmetic/_elemwise.ts`'s binary factory: one transfer +
 * codegen pair, parametrized over the (`cFnReal`, `jsFn`, `signRule`,
 * `requireDomain`) quadruple. Scalar path emits a bare C `<math.h>`
 * call; tensor path emits a per-name runtime helper that lives in
 * `runtime/tensor_unary_real_math.h`.
 *
 * Exact-fold rule: when every input element is exact AND every output
 * element is finite, attach the result as `exact` on the returned
 * type. Anything else drops the exact and the C side does the work.
 */
import { TypeError, UnsupportedConstruct } from "../../../lowering/errors.js";
import {
  type NumericType,
  type Sign,
  scalarDouble,
  scalarComplex,
  tensorDouble,
  tensorComplex,
  tensorDoubleFromDims,
  tensorComplexFromDims,
  shapeNumel,
  signFromNumber,
  isScalar,
  isMultiElement,
  isNumeric,
  EXACT_ARRAY_MAX_ELEMENTS,
} from "../../../lowering/types.js";
import type { Builtin } from "../../registry.js";
import {
  requireRealDouble,
  requireRealOrComplex,
  exactDouble,
  exactRealArray,
  exactComplex,
  exactComplexArray,
} from "../_shared.js";
import {
  mtoc2_tensor_cos,
  mtoc2_tensor_sin,
  mtoc2_tensor_tan,
  mtoc2_tensor_atan,
  mtoc2_tensor_exp,
  mtoc2_tensor_log,
  mtoc2_tensor_log2,
  mtoc2_tensor_log10,
  mtoc2_tensor_sqrt,
  mtoc2_tensor_abs,
  mtoc2_tensor_floor,
  mtoc2_tensor_ceil,
  mtoc2_tensor_fix,
  mtoc2_tensor_round,
  mtoc2_tensor_sign,
} from "../../runtime/snippets.gen.js";
import type { RuntimeTensor } from "../../../runtime/value.js";

/** JS-side tensor kernels keyed by builtin name. Matches the C
 *  side's `mtoc2_tensor_<name>` pattern; activations land via the
 *  `mtoc2_tensor_unary_real_math` snippet. */
type TensorUnary = (t: RuntimeTensor) => RuntimeTensor;
const JS_TENSOR_UNARY: Record<string, TensorUnary> = {
  cos: mtoc2_tensor_cos as unknown as TensorUnary,
  sin: mtoc2_tensor_sin as unknown as TensorUnary,
  tan: mtoc2_tensor_tan as unknown as TensorUnary,
  atan: mtoc2_tensor_atan as unknown as TensorUnary,
  exp: mtoc2_tensor_exp as unknown as TensorUnary,
  log: mtoc2_tensor_log as unknown as TensorUnary,
  log2: mtoc2_tensor_log2 as unknown as TensorUnary,
  log10: mtoc2_tensor_log10 as unknown as TensorUnary,
  sqrt: mtoc2_tensor_sqrt as unknown as TensorUnary,
  abs: mtoc2_tensor_abs as unknown as TensorUnary,
  floor: mtoc2_tensor_floor as unknown as TensorUnary,
  ceil: mtoc2_tensor_ceil as unknown as TensorUnary,
  fix: mtoc2_tensor_fix as unknown as TensorUnary,
  round: mtoc2_tensor_round as unknown as TensorUnary,
  sign: mtoc2_tensor_sign as unknown as TensorUnary,
};

export interface UnaryRealMathOpts {
  /** Source-level builtin name (also the runtime helper suffix). */
  name: string;
  /** C `<math.h>` function name for the scalar path (e.g. `"cos"`). */
  cFnReal: string;
  /** JS-side scalar fn for compile-time fold (and for the interpreter's
   *  `call` hook). */
  jsFn: (x: number) => number;
  /** Optional JS expression form (textual) for `emitJs`'s scalar real
   *  path. Defaults to `Math.${name}(arg)` which works for most names
   *  (sin/cos/tan/sqrt/exp/log/log2/log10/abs/atan/floor/ceil/sign).
   *  Override for `fix` (`Math.trunc`) and `round`
   *  (custom half-away-from-zero form). */
  jsExpr?: (arg: string) => string;
  /** Sign refinement on the result type. Called with the (validated)
   *  real-numeric input type. */
  signRule: (t: NumericType) => Sign;
  /** Optional input-domain validator (used by `sqrt`, `log`, `log2`,
   *  `log10`). Called with the input `NumericType`; throws on
   *  out-of-domain input. `undefined` means "any real input is fine". */
  requireDomain?: (t: NumericType) => void;
  /** Optional complex-input support. When set, complex scalars route
   *  through `cFnComplex` (a `mtoc2_c*` helper); complex tensors
   *  route through `mtoc2_tensor_<name>_complex`. `jsFnComplex`
   *  folds at the type-system layer when the input has an exact
   *  `{re, im}` carrier. */
  complex?: {
    cFnComplex: string;
    jsFnComplex: (z: { re: number; im: number }) => { re: number; im: number };
  };
}

/** Sign rule for rounding-toward-zero builtins (`fix`, `round`, `ceil`,
 *  `floor`). Captures the "may collapse to zero" pattern: if a side of
 *  the number line can land on 0, its strict-sign input weakens to the
 *  corresponding non-strict sign. The flags say whether the operation's
 *  rounding direction can reach 0 from that side. */
export function roundingSignRule(
  positiveCanLand: boolean,
  negativeCanLand: boolean
): (t: NumericType) => Sign {
  return t => {
    if (t.sign === "positive" && positiveCanLand) return "nonneg";
    if (t.sign === "negative" && negativeCanLand) return "nonpositive";
    if (t.sign === "nonzero" && (positiveCanLand || negativeCanLand)) {
      return "unknown";
    }
    return t.sign;
  };
}

export function defineUnaryRealMath(opts: UnaryRealMathOpts): Builtin {
  const { name, cFnReal, jsFn, signRule, requireDomain, complex } = opts;
  const jsExpr = opts.jsExpr ?? ((a: string) => `Math.${name}(${a})`);
  return {
    name,
    transfer(argTypes, nargout) {
      if (argTypes.length !== 1) {
        throw new TypeError(
          `'${name}' expects 1 arg(s), got ${argTypes.length}`
        );
      }
      if (nargout !== 1) {
        throw new UnsupportedConstruct(
          `'${name}' does not support multi-output (nargout=${nargout})`
        );
      }
      if (complex !== undefined) {
        requireRealOrComplex(argTypes[0], `'${name}' arg`);
      } else {
        requireRealDouble(argTypes[0], `'${name}' arg`);
      }
      const a = argTypes[0] as NumericType;
      if (a.isComplex) {
        if (isScalar(a)) {
          const cx = exactComplex(a);
          if (cx !== undefined) {
            const v = complex!.jsFnComplex(cx);
            if (Number.isFinite(v.re) && Number.isFinite(v.im)) {
              return [scalarComplex(v)];
            }
          }
          return [scalarComplex()];
        }
        const cx = exactComplexArray(a);
        if (cx !== undefined && a.shape !== undefined) {
          const total = shapeNumel(a.shape);
          if (total <= EXACT_ARRAY_MAX_ELEMENTS) {
            const re = new Float64Array(total);
            const im = new Float64Array(total);
            let allFinite = true;
            for (let i = 0; i < total; i++) {
              const v = complex!.jsFnComplex({ re: cx.re[i], im: cx.im[i] });
              if (!Number.isFinite(v.re) || !Number.isFinite(v.im)) {
                allFinite = false;
                break;
              }
              re[i] = v.re;
              im[i] = v.im;
            }
            if (allFinite) return [tensorComplex(a.shape, { re, im })];
          }
        }
        return [tensorComplexFromDims(a.dims.slice())];
      }
      if (requireDomain !== undefined) requireDomain(a);

      if (isScalar(a)) {
        const ax = exactDouble(a);
        if (ax !== undefined) {
          const v = jsFn(ax);
          if (Number.isFinite(v)) return [scalarDouble(signFromNumber(v), v)];
        }
        return [scalarDouble(signRule(a))];
      }

      if (a.shape !== undefined) {
        const arr = exactRealArray(a);
        const total = shapeNumel(a.shape);
        if (arr !== undefined && total <= EXACT_ARRAY_MAX_ELEMENTS) {
          const out = new Float64Array(arr.length);
          let allFinite = true;
          for (let i = 0; i < arr.length; i++) {
            const v = jsFn(arr[i]);
            if (!Number.isFinite(v)) {
              allFinite = false;
              break;
            }
            out[i] = v;
          }
          if (allFinite) return [tensorDouble(a.shape, out)];
        }
      }
      const out = tensorDoubleFromDims(a.dims.slice());
      out.sign = signRule(a);
      return [out];
    },
    emitC({ argsC, argTypes, useRuntime }) {
      const ty = argTypes[0] as NumericType;
      if (isNumeric(ty) && ty.isComplex) {
        useRuntime("mtoc2_cscalar");
        if (isMultiElement(ty)) {
          useRuntime("mtoc2_tensor_unary_complex_math");
          return `mtoc2_tensor_${name}_complex(${argsC[0]})`;
        }
        return `${complex!.cFnComplex}(${argsC[0]})`;
      }
      if (isMultiElement(ty)) {
        useRuntime("mtoc2_tensor_unary_real_math");
        return `mtoc2_tensor_${name}(${argsC[0]})`;
      }
      return `${cFnReal}(${argsC[0]})`;
    },
    emitJs({ argsJs, argTypes, useRuntime }) {
      const ty = argTypes[0] as NumericType;
      if (isNumeric(ty) && ty.isComplex) {
        throw new UnsupportedConstruct(
          `'${name}' complex emitJs not yet wired (needs JS complex runtime)`
        );
      }
      if (isMultiElement(ty)) {
        if (JS_TENSOR_UNARY[name] === undefined) {
          throw new UnsupportedConstruct(
            `'${name}' tensor emitJs has no JS kernel registered`
          );
        }
        useRuntime("mtoc2_tensor_unary_real_math");
        return `mtoc2_tensor_${name}(${argsJs[0]})`;
      }
      return jsExpr(argsJs[0]);
    },
    call({ args, argTypes }) {
      const ty = argTypes[0] as NumericType;
      if (isNumeric(ty) && ty.isComplex) {
        throw new UnsupportedConstruct(
          `'${name}' complex 'call' not yet wired`
        );
      }
      if (isMultiElement(ty)) {
        const kernel = JS_TENSOR_UNARY[name];
        if (kernel === undefined) {
          throw new UnsupportedConstruct(
            `'${name}' tensor 'call' has no JS kernel registered`
          );
        }
        return [kernel(args[0] as RuntimeTensor)];
      }
      const v = typeof args[0] === "number" ? args[0] : Number(args[0]);
      return [jsFn(v)];
    },
    elementwise: true,
  };
}

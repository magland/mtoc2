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
import type { Span } from "../../../parser/index.js";
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
} from "../../types.js";
import type { Builtin } from "../registry.js";
import {
  requireRealDouble,
  requireRealOrComplex,
  exactDouble,
  exactRealArray,
  exactComplex,
  exactComplexArray,
} from "../_shared.js";

export interface UnaryRealMathOpts {
  /** Source-level builtin name (also the runtime helper suffix). */
  name: string;
  /** C `<math.h>` function name for the scalar path (e.g. `"cos"`). */
  cFnReal: string;
  /** JS-side scalar fn for compile-time fold. */
  jsFn: (x: number) => number;
  /** Sign refinement on the result type. Called with the (validated)
   *  real-numeric input type. */
  signRule: (t: NumericType) => Sign;
  /** Optional input-domain validator (used by `sqrt`, `log`, `log2`,
   *  `log10`). Called with the input `NumericType`; throws on
   *  out-of-domain input. `undefined` means "any real input is fine". */
  requireDomain?: (t: NumericType, span: Span) => void;
  /** Optional complex-input support. When set, complex scalars route
   *  through `cFnComplex` (a `mtoc2_c*` helper); complex tensors
   *  route through `mtoc2_tensor_<name>_complex`. `jsFnComplex`
   *  folds at the type-system layer when the input has an exact
   *  `{re, im}` carrier. The result is a complex value of the same
   *  shape as the input (except `abs`, which overrides via its own
   *  builtin). */
  complex?: {
    cFnComplex: string;
    jsFnComplex: (z: { re: number; im: number }) => { re: number; im: number };
  };
}

/** Sign rule for rounding-toward-zero builtins (`fix`, `round`, `ceil`,
 *  `floor`). Captures the "may collapse to zero" pattern: if a side of
 *  the number line can land on 0, its strict-sign input weakens to the
 *  corresponding non-strict sign. The flags say whether the operation's
 *  rounding direction can reach 0 from that side.
 *
 *  - `positive` weakens to `nonneg` when `positiveCanLand` is true.
 *  - `negative` weakens to `nonpositive` when `negativeCanLand` is true.
 *  - `nonzero` weakens to `unknown` whenever EITHER flag is true (a
 *    nonzero input could now be a zero output).
 *  - every other sign passes through.
 *
 *  `fix` / `round` set both flags; `floor` sets only positive; `ceil`
 *  sets only negative.
 */
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
  return {
    name,
    arity: 1,
    transfer(argTypes, span) {
      if (complex !== undefined) {
        requireRealOrComplex(argTypes[0], `'${name}' arg`, span);
      } else {
        requireRealDouble(argTypes[0], `'${name}' arg`, span);
      }
      const a = argTypes[0] as NumericType;
      if (a.isComplex) {
        // Complex input: result is complex (same shape). Fold scalar
        // exact `{re, im}`; fold complex-tensor exact via the
        // split-buffer carrier when present and small enough.
        if (isScalar(a)) {
          const cx = exactComplex(a);
          if (cx !== undefined) {
            const v = complex!.jsFnComplex(cx);
            if (Number.isFinite(v.re) && Number.isFinite(v.im)) {
              return scalarComplex(v);
            }
          }
          return scalarComplex();
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
            if (allFinite) return tensorComplex(a.shape, { re, im });
          }
        }
        return tensorComplexFromDims(a.dims.slice());
      }
      if (requireDomain !== undefined) requireDomain(a, span);

      if (isScalar(a)) {
        const ax = exactDouble(a);
        if (ax !== undefined) {
          const v = jsFn(ax);
          if (Number.isFinite(v)) return scalarDouble(signFromNumber(v), v);
        }
        return scalarDouble(signRule(a));
      }

      // Tensor input. The C helper walks `prod(dims)` regardless of
      // static shape knowledge, so unknown-dim tensors are fine — we
      // just can't fold their values.
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
          if (allFinite) return tensorDouble(a.shape, out);
        }
      }
      const out = tensorDoubleFromDims(a.dims.slice());
      out.sign = signRule(a);
      return out;
    },
    codegenC(argsC, argTypes) {
      const ty = argTypes[0] as NumericType;
      if (isNumeric(ty) && ty.isComplex) {
        if (isMultiElement(ty)) {
          return `mtoc2_tensor_${name}_complex(${argsC[0]})`;
        }
        return `${complex!.cFnComplex}(${argsC[0]})`;
      }
      if (isMultiElement(ty)) {
        return `mtoc2_tensor_${name}(${argsC[0]})`;
      }
      return `${cFnReal}(${argsC[0]})`;
    },
    perSlotC(argsC, argTypes) {
      const ty = argTypes[0] as NumericType;
      if (isNumeric(ty) && ty.isComplex) {
        return `${complex!.cFnComplex}(${argsC[0]})`;
      }
      return `${cFnReal}(${argsC[0]})`;
    },
    runtimeDeps: complex
      ? [
          "mtoc2_tensor_unary_real_math",
          "mtoc2_tensor_unary_complex_math",
          "mtoc2_cscalar",
        ]
      : ["mtoc2_tensor_unary_real_math"],
  };
}

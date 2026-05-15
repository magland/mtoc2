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
  tensorDouble,
  tensorDoubleFromDims,
  signFromNumber,
  isScalar,
  isMultiElement,
  EXACT_ARRAY_MAX_ELEMENTS,
} from "../../types.js";
import type { Builtin } from "../registry.js";
import { requireRealDouble, exactDouble, exactRealArray } from "../_shared.js";

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
  const { name, cFnReal, jsFn, signRule, requireDomain } = opts;
  return {
    name,
    arity: 1,
    transfer(argTypes, span) {
      requireRealDouble(argTypes[0], `'${name}' arg`, span);
      const a = argTypes[0] as NumericType;
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
        const total = a.shape.reduce((p, q) => p * q, 1);
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
      if (isMultiElement(argTypes[0])) {
        return `mtoc2_tensor_${name}(${argsC[0]})`;
      }
      return `${cFnReal}(${argsC[0]})`;
    },
    runtimeDeps: ["mtoc2_tensor_unary_real_math"],
  };
}

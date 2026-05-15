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

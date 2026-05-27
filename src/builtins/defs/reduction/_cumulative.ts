/**
 * Shared scaffold for the `cumsum` / `cumprod` family — prefix-scan
 * builtins that return a tensor of the SAME shape as the input.
 *
 * Mirrors numbl's `cumOp` (helpers/reduction/cumulative.ts) for both
 * default-axis pick (first dim > 1, else dim 1) and per-fiber column-
 * major scan. Real input only; complex is rejected with a clear
 * `UnsupportedConstruct`.
 *
 * Exact-fold rule: when input has an exact data carrier AND the result
 * fits `EXACT_ARRAY_MAX_ELEMENTS`, scan at translate time and attach
 * the result as `exact` on the returned type.
 *
 * Out of scope: complex inputs, runtime (non-exact) `dim`, the
 * lattice-only shape form when no dim is given (`cumsum(A)` on a
 * tensor whose static shape is unknown raises — pass an explicit dim).
 */

import { TypeError, UnsupportedConstruct } from "../../../lowering/errors.js";
import {
  type NumericType,
  type Sign,
  type Type,
  EXACT_ARRAY_MAX_ELEMENTS,
  isNumeric,
  isScalar,
  scalarDouble,
  signFromNumber,
  tensorDouble,
  tensorDoubleFromDims,
} from "../../../lowering/types.js";
import type { Builtin } from "../../registry.js";
import { exactDouble, exactRealArray } from "../_shared.js";
import * as TENSOR_CUMULATIVE from "../../runtime/tensor_ops/tensor_cumulative.js";
import type { RuntimeTensor, RuntimeValue } from "../../../runtime/value.js";

type CumDimFn = (t: RuntimeTensor, dim: number) => RuntimeTensor;

const JS_CUM_DIM: Record<string, CumDimFn> = {
  cumsum: TENSOR_CUMULATIVE.mtoc2_tensor_cumsum_dim as unknown as CumDimFn,
  cumprod: TENSOR_CUMULATIVE.mtoc2_tensor_cumprod_dim as unknown as CumDimFn,
};

export interface CumulativeSpec {
  /** Source-level builtin name (also the runtime helper suffix:
   *  `mtoc2_tensor_<name>_dim`). */
  name: string;
  /** Identity seed (`0` for cumsum, `1` for cumprod). */
  init: number;
  /** Per-element accumulator step. */
  step(acc: number, x: number): number;
  /** Sign rule on the result given the input's sign. */
  signRule(s: Sign): Sign;
}

/** Default axis pick on a concrete shape: first dim > 1, else 1.
 *  Matches numbl `cumOp`: `shape.findIndex(d => d > 1) + 1` with
 *  fallback to 1 when every dim is ≤ 1. */
function pickDefaultAxis(shape: number[]): number {
  const idx = shape.findIndex(d => d > 1);
  return idx >= 0 ? idx + 1 : 1;
}

function parseDimArg(
  name: string,
  dimType: Type | undefined
): number | undefined {
  if (dimType === undefined) return undefined;
  if (!isNumeric(dimType) || dimType.isComplex || !isScalar(dimType)) {
    throw new TypeError(`'${name}' dim arg must be a scalar real integer`);
  }
  const v = exactDouble(dimType);
  if (v === undefined) {
    throw new UnsupportedConstruct(
      `'${name}' dim arg must be a statically-known integer in v1`
    );
  }
  if (!Number.isFinite(v) || !Number.isInteger(v) || v < 1) {
    throw new TypeError(
      `'${name}' dim arg must be a finite positive integer (got ${v})`
    );
  }
  return v;
}

/** Compile-time scan when every input element is exact. Always
 *  produces a result of the same length as `data` (no axis squeeze). */
function scanExact(
  spec: CumulativeSpec,
  data: Float64Array,
  shape: number[],
  dim: number
): Float64Array {
  const out = new Float64Array(data.length);
  if (dim > shape.length) {
    out.set(data);
    return out;
  }
  const dimIdx = dim - 1;
  const axis = shape[dimIdx];
  let before = 1;
  for (let i = 0; i < dimIdx; i++) before *= shape[i];
  let after = 1;
  for (let i = dimIdx + 1; i < shape.length; i++) after *= shape[i];
  for (let outer = 0; outer < after; outer++) {
    const slabBase = outer * before * axis;
    for (let inner = 0; inner < before; inner++) {
      let acc = spec.init;
      for (let k = 0; k < axis; k++) {
        const idx = slabBase + inner + k * before;
        acc = spec.step(acc, data[idx]);
        out[idx] = acc;
      }
    }
  }
  return out;
}

/** Resolve the dim used in emitted code. Requires either an explicit
 *  exact dim arg or a statically-known input shape. */
function resolveCodegenDim(
  name: string,
  argTypes: Type[],
  inputT: NumericType
): number {
  const dimType = argTypes[1];
  if (dimType !== undefined) {
    if (!isNumeric(dimType)) {
      throw new Error(`internal: ${name} codegen unexpected dim type`);
    }
    const v = exactDouble(dimType);
    if (v === undefined) {
      throw new Error(`internal: ${name} codegen reached with non-exact dim`);
    }
    return v;
  }
  if (inputT.shape !== undefined) {
    return pickDefaultAxis(inputT.shape);
  }
  // Transfer already rejected this case; defensive guard.
  throw new Error(
    `internal: ${name} codegen on lattice-only shape with no dim arg`
  );
}

/** Resolve the dim used in the interpreter `call` hook. Reads the
 *  runtime value directly so non-AOT scripts can pass a computed dim
 *  (mtoc2 keeps the AOT path's static-exact requirement; the
 *  interpreter is more permissive, matching numbl). */
function resolveCallDim(args: RuntimeValue[], t: RuntimeTensor): number {
  if (args.length >= 2 && args[1] !== undefined) {
    const v = args[1];
    return Math.round(typeof v === "number" ? v : Number(v));
  }
  return pickDefaultAxis(t.shape);
}

export function defineCumulative(spec: CumulativeSpec): Builtin {
  return {
    name: spec.name,
    transfer(argTypes, nargout) {
      if (argTypes.length < 1 || argTypes.length > 2) {
        throw new TypeError(
          `'${spec.name}' expects 1..2 arg(s), got ${argTypes.length}`
        );
      }
      if (nargout !== 1) {
        throw new UnsupportedConstruct(
          `'${spec.name}' does not support multi-output (nargout=${nargout})`
        );
      }
      const inputType = argTypes[0];
      if (!isNumeric(inputType)) {
        throw new TypeError(
          `'${spec.name}' arg must be numeric (got ${inputType.kind})`
        );
      }
      if (inputType.isComplex) {
        throw new UnsupportedConstruct(
          `'${spec.name}' complex input is not yet supported`
        );
      }
      if (inputType.elem !== "double" && inputType.elem !== "logical") {
        throw new TypeError(
          `'${spec.name}' arg must be double or logical (got ${inputType.elem})`
        );
      }
      // Validate dim arg shape; the value is used by codegen/call.
      const dim = parseDimArg(spec.name, argTypes[1]);

      // Scalar input: identity (numbl's `isRuntimeNumber(v) → return v`).
      // Result is double-typed (logical → double promotion mirrors
      // `cumulativeOutputType`).
      if (isScalar(inputType)) {
        const xv = exactDouble(inputType);
        if (xv !== undefined) {
          return [scalarDouble(signFromNumber(xv), xv)];
        }
        return [scalarDouble(spec.signRule(inputType.sign))];
      }

      // Tensor input: same shape as input. Resolve the axis at
      // transfer time so the fold path knows which fibers to scan.
      let chosenAxis: number;
      if (dim !== undefined) {
        chosenAxis = dim;
      } else if (inputType.shape !== undefined) {
        chosenAxis = pickDefaultAxis(inputType.shape);
      } else {
        throw new UnsupportedConstruct(
          `'${spec.name}' on a tensor with non-concrete shape requires an ` +
            `explicit dim arg (lattice-only shape can't pick a default axis)`
        );
      }

      // Fold path: scan at translate time when every element is exact.
      const exactArr = exactRealArray(inputType);
      if (
        exactArr !== undefined &&
        inputType.shape !== undefined &&
        exactArr.length <= EXACT_ARRAY_MAX_ELEMENTS
      ) {
        const data = scanExact(spec, exactArr, inputType.shape, chosenAxis);
        return [tensorDouble(inputType.shape, data)];
      }

      // Runtime path: emit a same-shape tensor type with the sign
      // refined from the input's sign.
      if (inputType.shape !== undefined) {
        const out = tensorDouble(inputType.shape);
        out.sign = spec.signRule(inputType.sign);
        return [out];
      }
      const out = tensorDoubleFromDims(inputType.dims.slice());
      out.sign = spec.signRule(inputType.sign);
      return [out];
    },

    emitC({ argsC, argTypes, useRuntime }) {
      const ty = argTypes[0] as NumericType;
      if (isScalar(ty)) {
        // Scalar identity. Cast preserves the C type even when the
        // input was logical-typed (stored as double anyway).
        return `(${argsC[0]})`;
      }
      useRuntime("mtoc2_tensor_cumulative");
      const dim = resolveCodegenDim(spec.name, argTypes, ty);
      return `mtoc2_tensor_${spec.name}_dim(${argsC[0]}, ${dim})`;
    },

    emitJs({ argsJs, argTypes, useRuntime }) {
      const ty = argTypes[0] as NumericType;
      if (isScalar(ty)) return argsJs[0];
      useRuntime("mtoc2_tensor_cumulative");
      const dim = resolveCodegenDim(spec.name, argTypes, ty);
      return `mtoc2_tensor_${spec.name}_dim(${argsJs[0]}, ${dim})`;
    },

    call({ args, argTypes }) {
      const ty = argTypes[0] as NumericType;
      if (isScalar(ty)) {
        const v = args[0];
        return [typeof v === "number" ? v : Number(v)];
      }
      const kernel = JS_CUM_DIM[spec.name];
      if (kernel === undefined) {
        throw new UnsupportedConstruct(
          `'${spec.name}' tensor 'call' has no JS kernel registered`
        );
      }
      const t = args[0] as RuntimeTensor;
      const dim = resolveCallDim(args, t);
      return [kernel(t, dim)];
    },
  };
}

// ── Per-op sign rules ────────────────────────────────────────────────

/** cumsum: a prefix sum of like-signed values stays in the same sign
 *  class. (Mixed signs collapse to `unknown` because partial sums can
 *  cross zero.) */
export function cumsumSign(s: Sign): Sign {
  switch (s) {
    case "positive":
      return "positive";
    case "nonneg":
      return "nonneg";
    case "zero":
      return "zero";
    case "negative":
      return "negative";
    case "nonpositive":
      return "nonpositive";
    default:
      return "unknown";
  }
}

/** cumprod: products of nonneg stay nonneg; products of positives stay
 *  positive; everything else (including alternating-sign negative
 *  inputs) is `unknown`. */
export function cumprodSign(s: Sign): Sign {
  switch (s) {
    case "positive":
      return "positive";
    case "nonneg":
      return "nonneg";
    case "zero":
      return "zero";
    default:
      return "unknown";
  }
}

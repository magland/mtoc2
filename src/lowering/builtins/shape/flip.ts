/**
 * `flipud`, `fliplr`, `flip` — axis-flip builtins.
 *
 * Numbl reference: `flipAlongDim` (array-manipulation.ts:41) +
 * `fliplr` (591), `flipud` (613), `flip` (634). All three lower to
 * the same runtime helper `mtoc2_tensor_flip(t, axisIdx)` (0-based)
 * — the source-level surface form just picks the axis.
 *
 * Surface forms supported in mtoc2 v1:
 *   - `flipud(A)`            → flip along axis 1 (rows)        → 0-based index 0
 *   - `fliplr(A)`            → flip along axis 2 (cols)        → 0-based index 1
 *   - `flip(A)`              → flip along the first non-singleton axis (numbl default)
 *   - `flip(A, k)`           → flip along axis k (1-based)
 *
 * Scalar inputs return the scalar unchanged (numbl: `if (isRuntimeNumber(v)) return v`).
 * Tensor inputs return a freshly-owned tensor of the same shape with
 * the chosen axis's elements mirrored. Exact-fold is supported for
 * inputs within `EXACT_ARRAY_MAX_ELEMENTS`.
 *
 * Char / complex inputs rejected (no support yet).
 */

import { TypeError, UnsupportedConstruct } from "../../errors.js";
import {
  EXACT_ARRAY_MAX_ELEMENTS,
  isMultiElement,
  isNumeric,
  isScalar,
  scalarDouble,
  signFromNumber,
  tensorDouble,
  typeToString,
} from "../../types.js";
import type { NumericType } from "../../types.js";
import type { Builtin } from "../registry.js";
import { exactDouble, exactRealArray } from "../_shared.js";

/** Compute the flipped-along-`axisIdx` exact data for a tensor with
 *  shape `shape` and source data `src` (column-major). Reused at the
 *  type-system fold step. */
function flipExact(
  src: Float64Array,
  shape: number[],
  axisIdx: number
): Float64Array {
  const total = shape.reduce((p, q) => p * q, 1);
  const out = new Float64Array(total);
  const axisSize = axisIdx >= 0 && axisIdx < shape.length ? shape[axisIdx] : 1;
  if (axisSize <= 1) {
    out.set(src);
    return out;
  }
  let strideDim = 1;
  for (let d = 0; d < axisIdx; d++) strideDim *= shape[d];
  const slabSize = strideDim * axisSize;
  const numOuter = total / slabSize;
  for (let outer = 0; outer < numOuter; outer++) {
    const base = outer * slabSize;
    for (let k = 0; k < axisSize; k++) {
      const srcOff = base + k * strideDim;
      const dstOff = base + (axisSize - 1 - k) * strideDim;
      for (let s = 0; s < strideDim; s++) {
        out[dstOff + s] = src[srcOff + s];
      }
    }
  }
  return out;
}

/** Resolve the (0-based) axis index for a flip-family call.
 *
 *  - `fixedAxis` is `0` for `flipud`, `1` for `fliplr`, or `null` for
 *    the general `flip` builtin.
 *  - For `flip` with no axis arg, return the first non-singleton axis
 *    (0 if all axes are singletons).
 *  - For `flip(A, k)`, validate `k` is a positive integer scalar and
 *    return `k - 1`. Reject dynamic `k` for now (numbl supports it,
 *    but the codegen would need a runtime conversion; defer).
 */
function resolveFlipAxis(
  name: string,
  argTypes: NumericType[],
  fixedAxis: number | null
): { axisIdx: number; staticAxis: boolean } {
  if (fixedAxis !== null) {
    return { axisIdx: fixedAxis, staticAxis: true };
  }
  if (argTypes.length === 1) {
    // Default to first non-singleton axis. `shape` may be undefined;
    // fall back to axis 0 in that case (matches numbl's behavior when
    // every axis is unknown — first non-singleton can't be picked).
    const a = argTypes[0];
    if (a.shape !== undefined) {
      const idx = a.shape.findIndex(d => d > 1);
      return { axisIdx: idx === -1 ? 0 : idx, staticAxis: true };
    }
    return { axisIdx: 0, staticAxis: true };
  }
  // flip(A, k) form.
  const k = argTypes[1];
  if (!isScalar(k) || k.isComplex) {
    throw new TypeError(
      `'${name}' second arg must be a real scalar (got ${typeToString(k)})`,
      synthSpan()
    );
  }
  const kv = exactDouble(k);
  if (kv === undefined) {
    throw new UnsupportedConstruct(
      `'${name}' with a dynamic dim argument is not yet supported (require statically-known axis)`,
      synthSpan()
    );
  }
  if (!Number.isFinite(kv) || !Number.isInteger(kv) || kv < 1) {
    throw new TypeError(
      `'${name}' dim argument must be a positive integer (got ${kv})`,
      synthSpan()
    );
  }
  return { axisIdx: kv - 1, staticAxis: true };
}

function synthSpan(): { file: string; start: number; end: number } {
  return { file: "<flip>", start: 0, end: 0 };
}

function defineFlip(opts: {
  name: string;
  fixedAxis: number | null;
  arity: number | { min: number; max: number };
}): Builtin {
  return {
    name: opts.name,
    arity: opts.arity,
    transfer(argTypes, span) {
      const a = argTypes[0];
      if (!isNumeric(a)) {
        throw new TypeError(
          `'${opts.name}' arg must be numeric (got ${typeToString(a)})`,
          span
        );
      }
      if (a.isComplex) {
        throw new TypeError(
          `'${opts.name}' on complex tensors is not yet supported`,
          span
        );
      }
      if (a.elem !== "double" && a.elem !== "logical") {
        throw new TypeError(
          `'${opts.name}' arg must be a real double or logical (got ${a.elem})`,
          span
        );
      }

      // Scalar identity.
      if (isScalar(a)) {
        const v = exactDouble(a);
        if (v !== undefined) return scalarDouble(signFromNumber(v), v);
        return scalarDouble(a.sign);
      }

      // Validate the axis argument(s) and resolve to a 0-based index.
      // Re-throw with the caller's span.
      let axisIdx: number;
      try {
        axisIdx = resolveFlipAxis(
          opts.name,
          argTypes as NumericType[],
          opts.fixedAxis
        ).axisIdx;
      } catch (err) {
        if (err instanceof TypeError || err instanceof UnsupportedConstruct) {
          throw new (err.constructor as typeof TypeError)(err.message, span);
        }
        throw err;
      }

      // Exact-fold when input is exact and fits the cap.
      const arr = exactRealArray(a);
      if (a.shape !== undefined && arr !== undefined) {
        const total = a.shape.reduce((p, q) => p * q, 1);
        if (total <= EXACT_ARRAY_MAX_ELEMENTS) {
          const out = flipExact(arr, a.shape, axisIdx);
          return tensorDouble(a.shape, out);
        }
      }
      if (a.shape !== undefined) {
        return tensorDouble(a.shape);
      }
      // Shape unknown — keep dims lattice, but we don't have a
      // factory that builds NumericType from dims with a known sign.
      // Default to the input type, sans exact.
      return { ...a, exact: undefined };
    },
    codegenC(argsC, argTypes) {
      const a = argTypes[0] as NumericType;
      if (!isMultiElement(a)) {
        // Scalar passthrough.
        return argsC[0];
      }
      const resolved = resolveFlipAxis(
        opts.name,
        argTypes as NumericType[],
        opts.fixedAxis
      );
      return `mtoc2_tensor_flip(${argsC[0]}, ${resolved.axisIdx}L)`;
    },
    runtimeDeps: ["mtoc2_tensor_flip"],
  };
}

export const flipud = defineFlip({
  name: "flipud",
  fixedAxis: 0,
  arity: 1,
});

export const fliplr = defineFlip({
  name: "fliplr",
  fixedAxis: 1,
  arity: 1,
});

export const flip = defineFlip({
  name: "flip",
  fixedAxis: null,
  arity: { min: 1, max: 2 },
});

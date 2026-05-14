/**
 * `reshape` builtin. Two surface forms, both lowered identically:
 *
 *   Form A — variadic scalar dims:  reshape(A, d1, d2, …, dN)
 *   Form B — vector of dims:        reshape(A, [d1, d2, …, dN])
 *
 * Discipline (mirrors numbl's array-manipulation `reshape`, less
 * the `[]` auto-infer slot):
 *   - Each `di` must be a statically-known finite non-negative integer
 *     (scalar `exact: number` for Form A, vector `exact: Float64Array`
 *     for Form B). Same as `zeros`/`ones`.
 *   - 1 ≤ N ≤ MTOC2_MAX_NDIM (8). Trailing-singletons are stripped down
 *     to a 2-axis minimum (numbl: `while (s.length>2 && s.last===1) s.pop()`),
 *     then padded back up to 2 axes if N=1 was given (mtoc2 represents
 *     every tensor as min-2D).
 *   - Input `A` must be a real numeric (scalar or tensor); complex /
 *     handle / struct / class / void / string rejected with TypeError.
 *   - Element-count check at transfer time when the input shape is
 *     statically known; deferred to the runtime helper otherwise.
 *
 * The `[]` auto-infer slot (`reshape(A, [], 3)` etc.) is rejected with
 * a span-attributed UnsupportedConstruct in v1.
 *
 * Codegen routes through the per-op runtime helper `mtoc2_reshape_nd`
 * (declared in `src/codegen/runtime/tensor_reshape_nd.h`). The result
 * is freshly owned, so the standard ANF / scope-exit-free pipeline
 * carries it without changes.
 */

import type { Span } from "../../../parser/index.js";
import { TypeError, UnsupportedConstruct } from "../../errors.js";
import {
  EXACT_ARRAY_MAX_ELEMENTS,
  tensorDouble,
  scalarDouble,
  signFromNumber,
  isNumeric,
  isScalar,
} from "../../types.js";
import type { Type } from "../../types.js";
import type { Builtin } from "../registry.js";
import { exactDouble, exactRealArray } from "../_shared.js";

/** Mirror of `MTOC2_MAX_NDIM` in src/codegen/runtime/tensor.h. */
const MTOC2_MAX_NDIM = 8;

/** Detect numbl's `[]` placeholder: a multi-element numeric tensor with
 *  zero total elements (e.g. the empty `[]` literal lowers to a
 *  `TensorBuild` with shape `[0, 0]`). */
function isEmptyPlaceholder(t: Type): boolean {
  if (!isNumeric(t)) return false;
  if (isScalar(t)) return false;
  if (t.shape === undefined) return false;
  return t.shape.reduce((a, b) => a * b, 1) === 0;
}

/** Resolve the dim args (i.e. `argTypes.slice(1)`) into a concrete
 *  shape. Handles Form A and Form B in one pass. Throws on any
 *  non-static / non-integer / out-of-range dim. */
function resolveNewShape(dimArgTypes: Type[], span: Span): number[] {
  if (dimArgTypes.length < 1) {
    // Caught by the `arity` machinery upstream, but keep a clear error
    // for direct callers (e.g. codegenC re-resolving with synthetic span).
    throw new UnsupportedConstruct(
      `'reshape' requires at least one dim argument after the input tensor`,
      span
    );
  }

  let dims: number[];

  // Form B: single multi-element tensor whose `exact` is a
  // Float64Array of dim sizes.
  if (
    dimArgTypes.length === 1 &&
    isNumeric(dimArgTypes[0]) &&
    !isScalar(dimArgTypes[0])
  ) {
    const a = dimArgTypes[0];
    if (isEmptyPlaceholder(a)) {
      throw new UnsupportedConstruct(
        `reshape: '[]' auto-infer slot is not yet supported; specify all dims explicitly`,
        span
      );
    }
    if (a.elem !== "double" || a.isComplex) {
      throw new TypeError(
        `'reshape' dim vector must be a real-double tensor (got ${a.elem}${a.isComplex ? " complex" : ""})`,
        span
      );
    }
    const arr = exactRealArray(a);
    if (arr === undefined) {
      throw new UnsupportedConstruct(
        `'reshape' dim vector must be a statically-known constant in v1`,
        span
      );
    }
    // Numbl restricts the Form B path to dim vectors > 1 element; a
    // 1-element tensor would have collapsed to scalar at lowering in
    // mtoc2 (the tensorLit fast-path), so we never see one here. Still,
    // the check below keeps us safe if that representation ever changes.
    if (arr.length < 1 || arr.length > MTOC2_MAX_NDIM) {
      throw new UnsupportedConstruct(
        `'reshape' supports 1..${MTOC2_MAX_NDIM} output dims (got ${arr.length})`,
        span
      );
    }
    dims = [];
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
        throw new TypeError(
          `'reshape' dim ${i + 1} must be a finite non-negative integer (got ${v})`,
          span
        );
      }
      dims.push(v);
    }
  } else {
    // Form A: every dim arg must be a scalar real double with a known
    // non-negative integer `exact`.
    if (dimArgTypes.length > MTOC2_MAX_NDIM) {
      throw new UnsupportedConstruct(
        `'reshape' supports 1..${MTOC2_MAX_NDIM} output dims (got ${dimArgTypes.length})`,
        span
      );
    }
    dims = [];
    for (let i = 0; i < dimArgTypes.length; i++) {
      const a = dimArgTypes[i];
      if (!isNumeric(a) || a.elem !== "double" || a.isComplex) {
        throw new TypeError(
          `'reshape' dim arg ${i + 1} must be a scalar real double (got ${a.kind})`,
          span
        );
      }
      if (!isScalar(a)) {
        if (isEmptyPlaceholder(a)) {
          throw new UnsupportedConstruct(
            `reshape: '[]' auto-infer slot is not yet supported; specify all dims explicitly`,
            span
          );
        }
        throw new TypeError(
          `'reshape' dim arg ${i + 1} must be a scalar real double (got tensor)`,
          span
        );
      }
      const v = exactDouble(a);
      if (v === undefined) {
        throw new UnsupportedConstruct(
          `'reshape' dim arguments must be statically-known constants in v1`,
          span
        );
      }
      if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
        throw new TypeError(
          `'reshape' dim arg ${i + 1} must be a finite non-negative integer (got ${v})`,
          span
        );
      }
      dims.push(v);
    }
  }

  // Numbl strip rule: drop trailing singletons, but never below 2 axes.
  while (dims.length > 2 && dims[dims.length - 1] === 1) {
    dims.pop();
  }
  // mtoc2 represents every tensor with ≥ 2 axes (matching the rest of
  // the runtime helpers and the `mtoc2_tensor_t` "min logical 2-D"
  // convention). Pad with trailing 1s. Numbl conceptually has 1-D
  // tensors but renders [n] and [n, 1] identically in `disp`, so this
  // padding doesn't change the byte-for-byte cross-runner output.
  while (dims.length < 2) {
    dims.push(1);
  }
  return dims;
}

export const reshape: Builtin = {
  name: "reshape",
  // 1 input + 1..MTOC2_MAX_NDIM dim args. Form B counts as 1 dim arg
  // (a single tensor) regardless of its element count.
  arity: { min: 2, max: MTOC2_MAX_NDIM + 1 },
  transfer(argTypes, span) {
    const a = argTypes[0];
    if (!isNumeric(a)) {
      throw new TypeError(
        `'reshape' first arg must be numeric (got ${a.kind})`,
        span
      );
    }
    if (a.isComplex) {
      throw new TypeError(`'reshape' on complex inputs is not supported`, span);
    }
    if (a.elem !== "double" && a.elem !== "logical") {
      throw new TypeError(
        `'reshape' first arg must be a real double or logical tensor (got ${a.elem})`,
        span
      );
    }

    const newShape = resolveNewShape(argTypes.slice(1), span);
    const newTotal = newShape.reduce((p, d) => p * d, 1);

    // Element-count check when the input shape is statically known.
    // (When `shape` is undefined — e.g. a tensor field whose layout the
    // type system only tracks per-axis as `notOne`/`unknown` — we defer
    // the check to the runtime helper, which aborts on mismatch.)
    if (a.shape !== undefined) {
      const inTotal = a.shape.reduce((p, d) => p * d, 1);
      if (inTotal !== newTotal) {
        throw new TypeError(
          `'reshape' element count mismatch: input has ${inTotal} elements, ` +
            `requested shape needs ${newTotal}`,
          span
        );
      }
    }

    // Output type. When new shape is all-ones the output is a scalar at
    // the type level (every dim is "one"); otherwise it's a tensor.
    if (newShape.every(d => d === 1)) {
      // Scalar output. Propagate exact:
      //   - scalar input with exact: number → carry the value directly.
      //   - multi-element input with exact: Float64Array of length 1 →
      //     unreachable in mtoc2 (1-element tensors collapse to scalar
      //     at lowering); fall through to non-exact scalar.
      if (typeof a.exact === "number") {
        return scalarDouble(signFromNumber(a.exact), a.exact);
      }
      return scalarDouble("unknown");
    }

    // Multi-element output. Propagate exact when the input has a
    // Float64Array exact AND the result fits the cap. The buffer is
    // identical column-major data, just reinterpreted under a new
    // shape, so we share the same Float64Array reference (matches
    // tensorDouble's contract).
    if (
      a.exact instanceof Float64Array &&
      newTotal <= EXACT_ARRAY_MAX_ELEMENTS
    ) {
      // Defensive: `tensorDouble` enforces `exact.length === prod(shape)`.
      // We've already proven `inTotal === newTotal` and the input
      // exact's length equals `inTotal` (since it's a known-shape
      // exact tensor). So the reuse is safe.
      if (a.exact.length === newTotal) {
        return tensorDouble(newShape, a.exact);
      }
    }
    return tensorDouble(newShape);
  },
  codegenC(argsC, argTypes) {
    // Re-resolve the new shape from arg types (transfer succeeded, so
    // the same call is guaranteed to succeed here).
    const newShape = resolveNewShape(argTypes.slice(1), {
      file: "<codegen>",
      start: 0,
      end: 0,
    });

    // Scalar-output fast path: the type system has already collapsed
    // the result to a `double`-typed scalar. The runtime helper would
    // return a tensor — incompatible with the scalar slot — so we just
    // pass the input through as identity. This is reachable only when
    // both input and output are scalar (1 element each), which is the
    // `reshape(x, 1[, 1[, …]])` identity case.
    if (newShape.every(d => d === 1)) {
      return argsC[0];
    }

    const dimList = newShape.map(d => `${d}L`).join(", ");
    return `mtoc2_reshape_nd(${argsC[0]}, ${newShape.length}, (long[]){${dimList}})`;
  },
  runtimeDeps: ["mtoc2_reshape_nd"],
};

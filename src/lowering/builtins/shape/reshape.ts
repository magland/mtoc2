/**
 * `reshape` builtin. Two surface forms:
 *
 *   Form A — variadic scalar dims:  reshape(A, d1, d2, …, dN)
 *   Form B — vector of dims:        reshape(A, [d1, d2, …, dN])
 *
 * Discipline (mirrors numbl's array-manipulation `reshape`):
 *   - 1 ≤ N ≤ MTOC2_MAX_NDIM (8). Trailing-singletons are stripped
 *     down to a 2-axis minimum (numbl:
 *     `while (s.length>2 && s.last===1) s.pop()`), then padded back
 *     up to 2 axes if N=1 was given (mtoc2 represents every tensor
 *     as min-2D).
 *   - Form A — each `di` is a scalar real double; statically-known
 *     finite non-negative integers pin the corresponding axis, and
 *     dynamic scalars (no `exact`) leave the axis as `unknown` in
 *     the result lattice.
 *   - Form B — the dim vector must be a statically-known
 *     `Float64Array` of dims (runtime vectors are not yet supported).
 *   - Form A allows at most one `[]` auto-infer slot. The translator
 *     fills it from `numel(A)` / `prod(other dims)` when both are
 *     known statically, else codegen passes `-1L` to
 *     `mtoc2_reshape_nd` which computes the slot at runtime. Form B
 *     still rejects the placeholder (the dim vector itself must be a
 *     static constant; a single `[]` inside the bracket is ambiguous).
 *   - Input `A` must be a real numeric (scalar or tensor); complex /
 *     handle / struct / class / void / string rejected with TypeError.
 *   - Element-count check at transfer time when the input shape and
 *     every new dim are statically known; deferred to the runtime
 *     helper otherwise.
 *
 * Codegen routes through the per-op runtime helper `mtoc2_reshape_nd`
 * (declared in `src/codegen/runtime/tensor_reshape_nd.h`), which
 * already accepts a runtime `(int ndim, const long *dims)` pair plus
 * an optional `-1L` auto-infer sentinel. The result is freshly owned,
 * so the standard ANF / scope-exit-free pipeline carries it without
 * changes.
 */

import type { Span } from "../../../parser/index.js";
import { TypeError, UnsupportedConstruct } from "../../errors.js";
import {
  DIM_ONE,
  EXACT_ARRAY_MAX_ELEMENTS,
  MTOC2_MAX_NDIM,
  tensorDouble,
  tensorDoubleFromDims,
  scalarDouble,
  signFromNumber,
  isNumeric,
  isScalar,
} from "../../types.js";
import type { DimInfo, Type } from "../../types.js";
import type { Builtin } from "../registry.js";
import { exactDouble, exactRealArray } from "../_shared.js";

/** Per-axis resolution. `argIndex` (when present) refers to the index
 *  into the original Form A dim arg list (i.e. `argTypes.slice(1)` —
 *  argIndex 0 is `argsC[1]` in the full call's argsC array). Form B
 *  always produces all-exact axes (the dim vector itself must be
 *  statically known), so the argIndex is irrelevant there.
 *  `infer` is the `[]` auto-slot in Form A: at most one per call,
 *  filled from `numel / prod(others)` at runtime when the value can't
 *  be derived statically. */
type ResolvedAxis =
  | { kind: "exact"; value: number; argIndex?: number }
  | { kind: "dynamic"; argIndex: number }
  | { kind: "infer"; argIndex: number };

interface ResolvedNewShape {
  axes: ResolvedAxis[];
}

/** Detect numbl's `[]` placeholder: a multi-element numeric tensor with
 *  zero total elements (e.g. the empty `[]` literal lowers to a
 *  `TensorBuild` with shape `[0, 0]`). */
function isEmptyPlaceholder(t: Type): boolean {
  if (!isNumeric(t)) return false;
  if (isScalar(t)) return false;
  if (t.shape === undefined) return false;
  return t.shape.reduce((a, b) => a * b, 1) === 0;
}

/** Apply numbl's strip / pad rules to a resolved axis list. Drops
 *  trailing exact-1 axes subject to a 2-axis floor; never strips a
 *  dynamic or infer axis. Pads with trailing exact-1 axes if length < 2. */
function normalizeAxes(axes: ResolvedAxis[]): ResolvedAxis[] {
  const out = axes.slice();
  while (
    out.length > 2 &&
    out[out.length - 1].kind === "exact" &&
    (out[out.length - 1] as { value: number }).value === 1
  ) {
    out.pop();
  }
  while (out.length < 2) {
    out.push({ kind: "exact", value: 1 });
  }
  return out;
}

/** Resolve the dim args (i.e. `argTypes.slice(1)`) into a per-axis
 *  list. Handles Form A (variadic scalars) and Form B (exact vector)
 *  in one pass. Form A dim args may be dynamic; Form B requires the
 *  vector itself to be statically known. Throws on any out-of-range
 *  or wrong-typed dim. */
function resolveNewShape(dimArgTypes: Type[], span: Span): ResolvedNewShape {
  if (dimArgTypes.length < 1) {
    // Caught by the `arity` machinery upstream, but keep a clear error
    // for direct callers (e.g. codegenC re-resolving with synthetic span).
    throw new UnsupportedConstruct(
      `'reshape' requires at least one dim argument after the input tensor`,
      span
    );
  }

  let axes: ResolvedAxis[];

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
    if (arr.length < 1 || arr.length > MTOC2_MAX_NDIM) {
      throw new UnsupportedConstruct(
        `'reshape' supports 1..${MTOC2_MAX_NDIM} output dims (got ${arr.length})`,
        span
      );
    }
    axes = [];
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
        throw new TypeError(
          `'reshape' dim ${i + 1} must be a finite non-negative integer (got ${v})`,
          span
        );
      }
      axes.push({ kind: "exact", value: v });
    }
  } else {
    // Form A: every dim arg must be a scalar real double. Exact values
    // pin the axis; dynamic (no `exact`) defers to runtime.
    if (dimArgTypes.length > MTOC2_MAX_NDIM) {
      throw new UnsupportedConstruct(
        `'reshape' supports 1..${MTOC2_MAX_NDIM} output dims (got ${dimArgTypes.length})`,
        span
      );
    }
    axes = [];
    let sawInfer = false;
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
          if (sawInfer) {
            throw new UnsupportedConstruct(
              `'reshape' allows at most one '[]' auto-infer slot`,
              span
            );
          }
          sawInfer = true;
          axes.push({ kind: "infer", argIndex: i });
          continue;
        }
        throw new TypeError(
          `'reshape' dim arg ${i + 1} must be a scalar real double (got tensor)`,
          span
        );
      }
      const v = exactDouble(a);
      if (v === undefined) {
        // Dynamic dim — defer the value-range and element-count
        // checks to the runtime helper.
        axes.push({ kind: "dynamic", argIndex: i });
        continue;
      }
      if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
        throw new TypeError(
          `'reshape' dim arg ${i + 1} must be a finite non-negative integer (got ${v})`,
          span
        );
      }
      axes.push({ kind: "exact", value: v, argIndex: i });
    }
  }

  return { axes: normalizeAxes(axes) };
}

/** Concrete number[] shape iff every axis is exact, else undefined. */
function exactShape(r: ResolvedNewShape): number[] | undefined {
  const out: number[] = [];
  for (const a of r.axes) {
    if (a.kind !== "exact") return undefined;
    out.push(a.value);
  }
  return out;
}

/** Emit the C `long` expression for one axis. `dimArgsC` is sliced
 *  from the full Call argsC so its index 0 maps to `axes[*].argIndex
 *  = 0`. The `[]` auto-infer slot emits `-1L` — `mtoc2_reshape_nd`
 *  scans for the sentinel and fills it from `in_total / prod(others)`. */
function dimC(axis: ResolvedAxis, dimArgsC: string[]): string {
  if (axis.kind === "exact") return `${axis.value}L`;
  if (axis.kind === "infer") return `-1L`;
  return `(long)(${dimArgsC[axis.argIndex]})`;
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

    const resolved = resolveNewShape(argTypes.slice(1), span);
    // Try to materialize the `[]` slot at translate time: when the input
    // shape AND every other axis is exact, `numel / prod(others)` pins
    // the slot. Otherwise it stays `infer` and the runtime helper does
    // the math.
    if (a.shape !== undefined) {
      const inferIdx = resolved.axes.findIndex(ax => ax.kind === "infer");
      if (inferIdx !== -1) {
        const others: number[] = [];
        let allOthersExact = true;
        for (let i = 0; i < resolved.axes.length; i++) {
          if (i === inferIdx) continue;
          const ax = resolved.axes[i];
          if (ax.kind === "exact") {
            others.push(ax.value);
          } else {
            allOthersExact = false;
            break;
          }
        }
        if (allOthersExact) {
          const inTotal = a.shape.reduce((p, d) => p * d, 1);
          const otherProd = others.reduce((p, d) => p * d, 1);
          if (otherProd === 0 && inTotal !== 0) {
            throw new TypeError(
              `'reshape' element count mismatch: input has ${inTotal} ` +
                `elements but the explicit dims around '[]' multiply to 0`,
              span
            );
          }
          if (otherProd > 0 && inTotal % otherProd !== 0) {
            throw new TypeError(
              `'reshape' element count mismatch: input has ${inTotal} ` +
                `elements, not divisible by ${otherProd} (the explicit ` +
                `dims around '[]')`,
              span
            );
          }
          const inferred = otherProd === 0 ? 0 : inTotal / otherProd;
          resolved.axes[inferIdx] = { kind: "exact", value: inferred };
        }
      }
    }
    const newShape = exactShape(resolved);

    if (newShape !== undefined) {
      const newTotal = newShape.reduce((p, d) => p * d, 1);
      // Element-count check when the input shape is statically known.
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

      // Scalar output (every dim is exact 1). Propagate exact when
      // input is an exact scalar.
      if (newShape.every(d => d === 1)) {
        if (typeof a.exact === "number") {
          return scalarDouble(signFromNumber(a.exact), a.exact);
        }
        return scalarDouble("unknown");
      }

      // Multi-element output with all-exact shape.
      if (
        a.exact instanceof Float64Array &&
        newTotal <= EXACT_ARRAY_MAX_ELEMENTS &&
        a.exact.length === newTotal
      ) {
        return tensorDouble(newShape, a.exact);
      }
      return tensorDouble(newShape);
    }

    // At least one new dim is dynamic (or infer with non-static input
    // shape). Result is a tensor with a mixed exact/unknown dim
    // lattice; element-count check is deferred to `mtoc2_reshape_nd`
    // at runtime. Exact data on the input can't be carried (the
    // destination shape isn't known).
    const dims: DimInfo[] = resolved.axes.map(axis =>
      axis.kind === "exact"
        ? axis.value === 1
          ? DIM_ONE
          : { kind: "exact", value: axis.value }
        : { kind: "unknown" }
    );
    return tensorDoubleFromDims(dims);
  },
  codegenC(argsC, argTypes) {
    // Re-resolve from arg types (transfer succeeded, so the same
    // call is guaranteed to succeed here).
    const resolved = resolveNewShape(argTypes.slice(1), {
      file: "<codegen>",
      start: 0,
      end: 0,
    });
    const newShape = exactShape(resolved);

    // Scalar-output fast path: the type system has already collapsed
    // the result to a `double`-typed scalar. The runtime helper would
    // return a tensor — incompatible with the scalar slot — so we just
    // pass the input through as identity. This is reachable only when
    // both input and output are scalar (1 element each), which is the
    // `reshape(x, 1[, 1[, …]])` identity case. Only reachable when
    // every new dim is exact (a dynamic dim can't be proven 1 at
    // compile time).
    if (newShape !== undefined && newShape.every(d => d === 1)) {
      return argsC[0];
    }

    const dimArgsC = argsC.slice(1);
    const dimList = resolved.axes.map(axis => dimC(axis, dimArgsC)).join(", ");
    return `mtoc2_reshape_nd(${argsC[0]}, ${resolved.axes.length}, (long[]){${dimList}})`;
  },
  runtimeDeps: ["mtoc2_reshape_nd"],
};

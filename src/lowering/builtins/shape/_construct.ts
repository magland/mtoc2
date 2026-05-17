/**
 * Shared infrastructure for the rank-N constructor builtins
 * (`zeros`, `ones`). Each call site supplies 1..MTOC2_MAX_NDIM scalar
 * real shape arguments. Each dim arg is either statically-known
 * (`exact` set on its NumericType) or dynamic (a runtime scalar
 * `double`); both are accepted. MATLAB's `zeros(n)` / `ones(n)`
 * one-arg form means an n×n square — codegen routes the dynamic
 * variant through `mtoc2_tensor_<kind>_square` so the dim expression
 * is evaluated exactly once.
 *
 * When every dim is exact the transfer can compute the shape (and
 * sometimes the fill data); when any dim is dynamic the result type
 * is built via `tensorDoubleFromDims` so the unknown axes propagate
 * through the type lattice unchanged.
 *
 * Codegen always emits a runtime call:
 *   - all-exact dims: `mtoc2_tensor_<kind>_nd(<N>, (long[]){<lit>,…})`
 *   - dynamic single-arg square form:
 *     `mtoc2_tensor_<kind>_square((long)(<arg>))`
 *   - dynamic multi-arg form:
 *     `mtoc2_tensor_<kind>_nd(<N>, (long[]){<lit-or-cast>,…})`
 *
 * The element cap (8 = MTOC2_MAX_NDIM) is enforced at the source side
 * too; the runtime helper aborts beyond that, but raising at lowering
 * time gives a proper span.
 */

import type { Span } from "../../../parser/index.js";
import { UnsupportedConstruct, TypeError } from "../../errors.js";
import {
  DIM_ONE,
  EXACT_ARRAY_MAX_ELEMENTS,
  MTOC2_MAX_NDIM,
  tensorDouble,
  tensorDoubleFromDims,
  scalarDouble,
  shapeNumel,
  signFromNumber,
  isNumeric,
  isScalar,
} from "../../types.js";
import type { DimInfo, NumericType, Type } from "../../types.js";
import type { Builtin } from "../registry.js";
import { exactDouble, exactRealArray } from "../_shared.js";

/** Per-axis resolution. `argIndex` is the position in the original
 *  argTypes/argsC arrays that supplies this axis's value — both axes
 *  of the single-arg square form share `argIndex = 0`. Synthetic
 *  axes inserted by the pad-to-2 normalizer use `argIndex = 0` as
 *  a placeholder; they're always `kind: "exact", value: 1` and the
 *  emitter only consumes `argIndex` for dynamic axes. */
type ResolvedAxis =
  | { kind: "exact"; value: number; argIndex: number }
  | { kind: "dynamic"; argIndex: number };

/** Mirror numbl's makeTensor shape canonicalization: drop trailing
 *  exact-1 axes down to a 2-axis floor, then pad up to 2 if shorter.
 *  Dynamic axes are never stripped (their value isn't known at
 *  translate time, so trailing `zeros(3, n)` with `n == 1` at runtime
 *  must NOT collapse the axis here — that's the runtime helper's
 *  problem, not ours). Without this step `zeros(3, 2, 1)` would lower
 *  to a rank-3 tensor and `disp` / `size` would diverge from numbl. */
function normalizeAxes(axes: ResolvedAxis[]): ResolvedAxis[] {
  const out = axes.slice();
  while (
    out.length > 2 &&
    out[out.length - 1].kind === "exact" &&
    (out[out.length - 1] as { kind: "exact"; value: number }).value === 1
  ) {
    out.pop();
  }
  while (out.length < 2) {
    out.push({ kind: "exact", value: 1, argIndex: 0 });
  }
  return out;
}

interface ResolvedShape {
  axes: ResolvedAxis[];
  ndim: number;
  /** True iff the surface form was a single arg producing an n×n
   *  matrix (MATLAB's `zeros(n)` rule). When the source arg is
   *  dynamic, codegen routes through the `_square` helper to avoid
   *  double-evaluating the dim expression. */
  isSquare: boolean;
}

/** Resolve the source-level arg list to a per-axis shape, applying
 *  MATLAB's "single arg means square" rule. Each dim arg must be a
 *  scalar real double; exact non-negative integer dims are pinned at
 *  resolve time, dynamic dims are accepted as-is and surface as
 *  `kind: "dynamic"` axes. Throws on bad arg types or out-of-range
 *  exact values. */
function resolveShape(
  name: string,
  argTypes: Type[],
  span: Span
): ResolvedShape {
  if (argTypes.length < 1 || argTypes.length > MTOC2_MAX_NDIM) {
    throw new UnsupportedConstruct(
      `'${name}' supports 1..${MTOC2_MAX_NDIM} shape arguments (got ${argTypes.length})`,
      span
    );
  }

  // Form B: single multi-element tensor argument carrying the dim
  // vector (`zeros(size(xs))`, `zeros([2 3 4])`). Mirrors `reshape`'s
  // Form B; the vector must be statically-known in v1. Trailing
  // singletons get the same 2-axis-floor normalization as the
  // multi-scalar Form A.
  if (
    argTypes.length === 1 &&
    isNumeric(argTypes[0]) &&
    !isScalar(argTypes[0])
  ) {
    const a = argTypes[0];
    if (a.elem !== "double" && a.elem !== "logical") {
      throw new TypeError(
        `'${name}' dim vector must be a real-double tensor (got ${a.elem})`,
        span
      );
    }
    if (a.isComplex) {
      throw new TypeError(
        `'${name}' dim vector must be a real-double tensor (got complex)`,
        span
      );
    }
    const arr = exactRealArray(a);
    if (arr === undefined) {
      throw new UnsupportedConstruct(
        `'${name}' dim vector must be a statically-known constant in v1`,
        span
      );
    }
    if (arr.length < 1 || arr.length > MTOC2_MAX_NDIM) {
      throw new UnsupportedConstruct(
        `'${name}' supports 1..${MTOC2_MAX_NDIM} output dims (got ${arr.length})`,
        span
      );
    }
    const axes: ResolvedAxis[] = [];
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
        throw new TypeError(
          `'${name}' dim ${i + 1} must be a finite non-negative integer (got ${v})`,
          span
        );
      }
      axes.push({ kind: "exact", value: v, argIndex: 0 });
    }
    // Strip trailing exact-1 axes down to the 2-axis floor (mtoc2's
    // lattice represents every tensor with at least 2 axes; `zeros([5])`
    // == `zeros(5, 1)` per MATLAB), then pad up if shorter. Mirrors
    // numbl's makeTensor canonicalization so e.g. `zeros([3 2 1])`
    // surfaces as a 3×2, not a 3×2×1.
    const norm = normalizeAxes(axes);
    return { axes: norm, ndim: norm.length, isSquare: false };
  }

  const axes: ResolvedAxis[] = [];
  for (let i = 0; i < argTypes.length; i++) {
    const a = argTypes[i];
    if (!isNumeric(a) || a.elem !== "double" || a.isComplex) {
      throw new TypeError(
        `'${name}' arg ${i + 1} must be a scalar real double (got ${a.kind})`,
        span
      );
    }
    if (!isScalar(a)) {
      throw new TypeError(
        `'${name}' arg ${i + 1} must be a scalar real double (got tensor)`,
        span
      );
    }
    const v = exactDouble(a);
    if (v === undefined) {
      // Dynamic dim — runtime scalar. Defer all value-range checks
      // (`mtoc2_tensor_alloc_nd` aborts on overflow / negative dims at
      // runtime).
      axes.push({ kind: "dynamic", argIndex: i });
      continue;
    }
    if (!Number.isInteger(v) || v < 0) {
      throw new TypeError(
        `'${name}' arg ${i + 1} must be a finite non-negative integer (got ${v})`,
        span
      );
    }
    axes.push({ kind: "exact", value: v, argIndex: i });
  }
  // MATLAB's `zeros(n)` / `ones(n)` is an n×n square. The two axes
  // share `argIndex = 0` so codegen knows to route through the
  // single-eval `_square` helper when the value is dynamic.
  if (axes.length === 1) {
    return { axes: [axes[0], axes[0]], ndim: 2, isSquare: true };
  }
  // Strip trailing exact-1 axes down to a 2-axis floor (see Form B
  // for rationale). Without this, `zeros(3, 2, 1)` would lower to
  // a rank-3 tensor and diverge from numbl.
  const norm = normalizeAxes(axes);
  return { axes: norm, ndim: norm.length, isSquare: false };
}

/** Return the concrete number[] shape when every axis is exact;
 *  otherwise return undefined. */
function exactShapeOf(r: ResolvedShape): number[] | undefined {
  const out: number[] = [];
  for (const a of r.axes) {
    if (a.kind !== "exact") return undefined;
    out.push(a.value);
  }
  return out;
}

/** Emit the C `long`-typed dim expression for one axis: literal
 *  for exact, `(long)(argsC[i])` for dynamic. */
function dimC(axis: ResolvedAxis, argsC: string[]): string {
  if (axis.kind === "exact") return `${axis.value}L`;
  return `(long)(${argsC[axis.argIndex]})`;
}

/** Options for `defineShapeConstructor`. When `cFillValue` is set, the
 *  factory builds a "parameterized fill" constructor: the runtime
 *  helpers are invoked with `cFillValue` as their first arg
 *  (`mtoc2_tensor_fill_nd(v, ndim, dims)` style) and the scalar-
 *  collapse emit uses `cFillValue` verbatim. This is the path used by
 *  the non-finite constants (`nan`/`NaN`/`Inf`/`inf`), where the JS
 *  number's `toString` ("NaN" / "Infinity") doesn't round-trip to
 *  valid C. When `cFillValue` is undefined, the factory keeps the
 *  original zeros/ones contract: helpers take `(ndim, dims)` only
 *  and scalar collapse emits a JS-derived literal. */
interface ShapeConstructorOpts {
  /** Inclusive lower bound on argument count. Defaults to 1 (zeros /
   *  ones don't accept the 0-arg form). Set to 0 by callers that
   *  combine a scalar-constant 0-arg branch with the shape
   *  constructor (the constants in `math/constants.ts`); the
   *  combined builtin's transfer/codegen pre-dispatches 0 args
   *  before delegating to this factory's transfer/codegen. */
  minArgs?: number;
  /** When set, prepend this C expression as the first arg of every
   *  helper call and emit it directly for the scalar-collapse case.
   *  Required when `fillValue` is non-finite (NaN/Infinity). */
  cFillValue?: string;
}

/** Build a `zeros` / `ones` / fill-style shape-constructor builtin.
 *  `fillValue` is the constant the output is filled with at the
 *  type level (Float64Array). See `ShapeConstructorOpts.cFillValue`
 *  for the per-helper invocation contract. */
export function defineShapeConstructor(
  name: string,
  fillValue: number,
  ndHelper: string,
  squareHelper: string,
  opts: ShapeConstructorOpts = {}
): Builtin {
  const minArgs = opts.minArgs ?? 1;
  const cFillValue = opts.cFillValue;
  const helperPrefix = cFillValue !== undefined ? `${cFillValue}, ` : "";
  return {
    name,
    arity: { min: minArgs, max: MTOC2_MAX_NDIM },
    transfer(argTypes, span) {
      const resolved = resolveShape(name, argTypes, span);
      const shape = exactShapeOf(resolved);
      if (shape !== undefined) {
        const total = shapeNumel(shape);
        // Empty result (any axis 0) keeps the shape but no exact data —
        // there's no element to put in a Float64Array. Sign stays
        // "unknown" (vacuously true; empty tensors don't constrain
        // domain checks anyway).
        if (total === 0) {
          return tensorDouble(shape);
        }
        // Scalar result (every axis 1, e.g. `zeros(1,1)`): the type
        // collapses to scalar double, keeping the exact value.
        if (shape.every(s => s === 1)) {
          return scalarDouble(signFromNumber(fillValue), fillValue);
        }
        if (total <= EXACT_ARRAY_MAX_ELEMENTS) {
          const data = new Float64Array(total);
          if (fillValue !== 0) data.fill(fillValue);
          // tensorDouble auto-derives sign from the exact data.
          return tensorDouble(shape, data);
        }
        // Too large to carry exact data, but the fill value is still
        // known statically. Set the sign explicitly so domain checks
        // (e.g. `sqrt(zeros(20,20))`) succeed.
        const t = tensorDouble(shape);
        t.sign = signFromNumber(fillValue);
        return t;
      }
      // At least one axis is dynamic. Build a lattice-only type:
      // exact axes pin their value, dynamic ones land as `unknown`.
      const dims: DimInfo[] = resolved.axes.map(a =>
        a.kind === "exact"
          ? a.value === 1
            ? DIM_ONE
            : { kind: "exact", value: a.value }
          : { kind: "unknown" }
      );
      const t: NumericType = tensorDoubleFromDims(dims);
      t.sign = signFromNumber(fillValue);
      return t;
    },
    codegenC(argsC, argTypes) {
      // The transfer step has already validated every arg; reuse the
      // same resolution so codegen sees the same exact-vs-dynamic
      // verdict per axis. codegenC is only called after transfer
      // succeeded, so resolveShape can't throw here.
      const resolved = resolveShape(name, argTypes, {
        file: "<codegen>",
        start: 0,
        end: 0,
      });
      const shape = exactShapeOf(resolved);
      if (shape !== undefined) {
        // Scalar collapse (every axis 1, e.g. `zeros(1,1)`): the
        // surrounding code expects a `double`-valued expression
        // matching the scalar result type. Emit the literal directly.
        if (shape.every(s => s === 1)) {
          if (cFillValue !== undefined) return cFillValue;
          return Number.isInteger(fillValue)
            ? `${fillValue}.0`
            : `${fillValue}`;
        }
        const dimList = shape.map(d => `${d}L`).join(", ");
        return `${ndHelper}(${helperPrefix}${resolved.ndim}, (long[]){${dimList}})`;
      }
      // Dynamic single-arg square form — evaluate the source arg once.
      // (`isSquare` triggers regardless of whether the source value is
      // exact, but the all-exact case is handled by the `shape !==
      // undefined` branch above; only dynamic single-arg lands here.)
      if (resolved.isSquare) {
        const src = resolved.axes[0];
        return `${squareHelper}(${helperPrefix}(long)(${argsC[src.argIndex]}))`;
      }
      const dimList = resolved.axes.map(a => dimC(a, argsC)).join(", ");
      return `${ndHelper}(${helperPrefix}${resolved.ndim}, (long[]){${dimList}})`;
    },
    runtimeDeps: [ndHelper, squareHelper],
  };
}

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
  tensorDouble,
  tensorDoubleFromDims,
  scalarDouble,
  signFromNumber,
  isNumeric,
  isScalar,
} from "../../types.js";
import type { DimInfo, NumericType, Type } from "../../types.js";
import type { Builtin } from "../registry.js";
import { exactDouble } from "../_shared.js";

/** Mirror of `MTOC2_MAX_NDIM` in src/codegen/runtime/tensor.h. */
const MTOC2_MAX_NDIM = 8;

/** Per-axis resolution. `argIndex` is the position in the original
 *  argTypes/argsC arrays that supplies this axis's value — both axes
 *  of the single-arg square form share `argIndex = 0`. */
type ResolvedAxis =
  | { kind: "exact"; value: number; argIndex: number }
  | { kind: "dynamic"; argIndex: number };

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
  return { axes, ndim: axes.length, isSquare: false };
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

/** Build a `zeros` / `ones` builtin. `fillValue` is the constant the
 *  output is filled with at both type-level (Float64Array) and C
 *  level (the matching `_zeros_nd` / `_ones_nd` helper). The
 *  `squareHelper` covers the single-eval n×n form. */
export function defineShapeConstructor(
  name: string,
  fillValue: number,
  ndHelper: string,
  squareHelper: string
): Builtin {
  return {
    name,
    arity: { min: 1, max: MTOC2_MAX_NDIM },
    transfer(argTypes, span) {
      const resolved = resolveShape(name, argTypes, span);
      const shape = exactShapeOf(resolved);
      if (shape !== undefined) {
        const total = shape.reduce((a, b) => a * b, 1);
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
          return Number.isInteger(fillValue)
            ? `${fillValue}.0`
            : `${fillValue}`;
        }
        const dimList = shape.map(d => `${d}L`).join(", ");
        return `${ndHelper}(${resolved.ndim}, (long[]){${dimList}})`;
      }
      // Dynamic single-arg square form — evaluate the source arg once.
      // (`isSquare` triggers regardless of whether the source value is
      // exact, but the all-exact case is handled by the `shape !==
      // undefined` branch above; only dynamic single-arg lands here.)
      if (resolved.isSquare) {
        const src = resolved.axes[0];
        return `${squareHelper}((long)(${argsC[src.argIndex]}))`;
      }
      const dimList = resolved.axes.map(a => dimC(a, argsC)).join(", ");
      return `${ndHelper}(${resolved.ndim}, (long[]){${dimList}})`;
    },
    runtimeDeps: [ndHelper, squareHelper],
  };
}

/**
 * Shared infrastructure for the rank-N constructor builtins
 * (`zeros`, `ones`). Each call site must supply 1..MTOC2_MAX_NDIM
 * scalar real shape arguments, each statically-known (its `exact`
 * is a finite non-negative integer). MATLAB's `zeros(n)`/`ones(n)`
 * one-arg form means an n×n square.
 *
 * Codegen always emits the runtime helper call
 * `mtoc2_tensor_<kind>_nd(<N>, (long[]){<d1>, …, <dN>})` — the
 * exact-tagged result type carries through type-level folding but
 * the C side materializes via the runtime helper. The argsC
 * received here are unused: the lowerer has already proven the
 * dims are static.
 *
 * The element cap (8 = MTOC2_MAX_NDIM) is enforced at the source
 * side too; the runtime helper aborts beyond that, but raising at
 * lowering time gives a proper span.
 */

import type { Span } from "../../../parser/index.js";
import { UnsupportedConstruct, TypeError } from "../../errors.js";
import {
  EXACT_ARRAY_MAX_ELEMENTS,
  tensorDouble,
  scalarDouble,
  signFromNumber,
  isNumeric,
} from "../../types.js";
import type { Type } from "../../types.js";
import type { Builtin } from "../registry.js";
import { exactDouble } from "../_shared.js";

/** Mirror of `MTOC2_MAX_NDIM` in src/codegen/runtime/tensor.h. */
const MTOC2_MAX_NDIM = 8;

/** Resolve the source-level arg list to a concrete shape, applying
 *  MATLAB's "single arg means square" rule. Throws on bad args. */
function resolveShape(
  name: string,
  argTypes: Type[],
  span: Span
): { shape: number[]; ndim: number } {
  if (argTypes.length < 1 || argTypes.length > MTOC2_MAX_NDIM) {
    throw new UnsupportedConstruct(
      `'${name}' supports 1..${MTOC2_MAX_NDIM} shape arguments (got ${argTypes.length})`,
      span
    );
  }
  const dims: number[] = [];
  for (let i = 0; i < argTypes.length; i++) {
    const a = argTypes[i];
    if (!isNumeric(a) || a.elem !== "double" || a.isComplex) {
      throw new TypeError(
        `'${name}' arg ${i + 1} must be a scalar real double (got ${a.kind})`,
        span
      );
    }
    // Shape arg must be a real scalar — every axis statically 1.
    if (!a.dims.every(d => d.kind === "one")) {
      throw new TypeError(
        `'${name}' arg ${i + 1} must be a scalar real double (got tensor)`,
        span
      );
    }
    const v = exactDouble(a);
    if (v === undefined) {
      throw new UnsupportedConstruct(
        `'${name}' shape arguments must be statically-known constants in v1`,
        span
      );
    }
    if (!Number.isInteger(v) || v < 0) {
      throw new TypeError(
        `'${name}' arg ${i + 1} must be a finite non-negative integer (got ${v})`,
        span
      );
    }
    dims.push(v);
  }
  // MATLAB's `zeros(n)` / `ones(n)` is an n×n square, not a 1-D vector.
  if (dims.length === 1) {
    return { shape: [dims[0], dims[0]], ndim: 2 };
  }
  return { shape: dims, ndim: dims.length };
}

/** Build a `zeros` / `ones` builtin. `fillValue` is the constant the
 *  output is filled with at both type-level (Float64Array) and C
 *  level (the matching `_zeros_nd` / `_ones_nd` helper). */
export function defineShapeConstructor(
  name: string,
  fillValue: number,
  ndHelper: string
): Builtin {
  return {
    name,
    arity: { min: 1, max: MTOC2_MAX_NDIM },
    transfer(argTypes, span) {
      const { shape } = resolveShape(name, argTypes, span);
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
    },
    codegenC(_argsC, argTypes) {
      // The transfer step has already verified every arg has a
      // finite-int `exact`; reuse it for the C-side dim literals so
      // the runtime helper receives the exact same shape that the
      // type carries. codegenC is only called after transfer
      // succeeded, so resolveShape can't throw here.
      const { shape, ndim } = resolveShape(name, argTypes, {
        file: "<codegen>",
        start: 0,
        end: 0,
      });
      // Scalar collapse (every axis 1, e.g. `zeros(1,1)`): the
      // surrounding code expects a `double`-valued expression
      // matching the scalar result type. Emit the literal directly.
      if (shape.every(s => s === 1)) {
        return Number.isInteger(fillValue) ? `${fillValue}.0` : `${fillValue}`;
      }
      const dimList = shape.map(d => `${d}L`).join(", ");
      return `${ndHelper}(${ndim}, (long[]){${dimList}})`;
    },
    runtimeDeps: [ndHelper],
  };
}

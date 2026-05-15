/**
 * `eye(n)` and `eye(m, n)` — 2-D identity matrices.
 *
 * Accepts 1 or 2 scalar real-double args. Negative or fractional args
 * are rejected at translate when the exact value is known; runtime
 * scalars clamp negatives to 0 inside `mtoc2_eye_rect` (matching
 * numbl's `validateDim`). The 1-arg size-vector form (`eye([m, n])`)
 * is not yet supported and surfaces an `UnsupportedConstruct` with a
 * span.
 *
 * Codegen always emits a runtime helper call — the C compiler is
 * faster at unrolling small identity fills than the lowerer would be
 * at materializing a literal. The single-arg dynamic form routes
 * through `mtoc2_eye_square` to evaluate the source expression once;
 * everything else lands on `mtoc2_eye_rect`. When the result type
 * collapses to a scalar `1×1` (e.g. `eye(1)`, `eye(1, 1)`), codegen
 * emits the literal `1.0` instead so the surrounding code's `double`-
 * valued slot is satisfied.
 */

import type { Span } from "../../../parser/index.js";
import { UnsupportedConstruct, TypeError } from "../../errors.js";
import {
  EXACT_ARRAY_MAX_ELEMENTS,
  DIM_ONE,
  scalarDouble,
  tensorDouble,
  tensorDoubleFromDims,
  isNumeric,
  isScalar,
} from "../../types.js";
import type { DimInfo, NumericType, Type } from "../../types.js";
import type { Builtin } from "../registry.js";
import { exactDouble } from "../_shared.js";

interface ResolvedAxis {
  exact: number | undefined;
  /** Position in the original arg list whose C expression supplies this
   *  axis. For the 1-arg form both axes share `argIndex = 0` so the
   *  square-helper routing knows to evaluate the source once. */
  argIndex: number;
}

function resolveArgs(argTypes: Type[], span: Span): ResolvedAxis[] {
  if (argTypes.length < 1 || argTypes.length > 2) {
    throw new UnsupportedConstruct(
      `'eye' supports 1 or 2 arguments (got ${argTypes.length})`,
      span
    );
  }
  // Size-vector form `eye([m, n])` is deferred — fall through with a
  // clear span rather than silently accepting it.
  if (
    argTypes.length === 1 &&
    isNumeric(argTypes[0]) &&
    !isScalar(argTypes[0])
  ) {
    throw new UnsupportedConstruct(
      `'eye' with a size-vector argument is not yet supported; ` +
        `use 'eye(m, n)' instead`,
      span
    );
  }
  const out: ResolvedAxis[] = [];
  for (let i = 0; i < argTypes.length; i++) {
    const a = argTypes[i];
    if (!isNumeric(a) || a.elem !== "double" || a.isComplex) {
      throw new TypeError(
        `'eye' arg ${i + 1} must be a scalar real double (got ${a.kind})`,
        span
      );
    }
    if (!isScalar(a)) {
      throw new TypeError(
        `'eye' arg ${i + 1} must be a scalar real double (got tensor)`,
        span
      );
    }
    const v = exactDouble(a);
    if (v !== undefined) {
      if (!Number.isInteger(v) || v < 0) {
        throw new TypeError(
          `'eye' arg ${i + 1} must be a finite non-negative integer (got ${v})`,
          span
        );
      }
      out.push({ exact: v, argIndex: i });
    } else {
      out.push({ exact: undefined, argIndex: i });
    }
  }
  // MATLAB's `eye(n)` is an n×n square. The two axes share the same
  // source-arg slot so dynamic codegen can route through `_square`
  // for single-eval.
  if (out.length === 1) {
    return [out[0], { exact: out[0].exact, argIndex: out[0].argIndex }];
  }
  return out;
}

export const eye: Builtin = {
  name: "eye",
  arity: { min: 1, max: 2 },
  transfer(argTypes, span) {
    const axes = resolveArgs(argTypes, span);
    const rows = axes[0].exact;
    const cols = axes[1].exact;
    if (rows !== undefined && cols !== undefined) {
      const shape = [rows, cols];
      const total = rows * cols;
      // Any axis 0 → empty tensor, no exact data to attach.
      if (total === 0) return tensorDouble(shape);
      // 1×1 identity is the scalar 1.0 (lattice collapses to scalar).
      if (rows === 1 && cols === 1) return scalarDouble("positive", 1);
      if (total <= EXACT_ARRAY_MAX_ELEMENTS) {
        const data = new Float64Array(total);
        const min = rows < cols ? rows : cols;
        // Column-major: entry (i, i) sits at offset `i + i*rows`.
        for (let i = 0; i < min; i++) data[i + i * rows] = 1;
        return tensorDouble(shape, data);
      }
      // Too large for exact data; keep the shape and pin sign.
      const t = tensorDouble(shape);
      t.sign = "nonneg";
      return t;
    }
    // At least one axis is dynamic. Build the lattice with `unknown`
    // dims for the non-exact axes; pin exact ones (a 1 collapses to
    // `DIM_ONE`, matching the constructor helpers' convention).
    const dims: DimInfo[] = axes.map(a =>
      a.exact === undefined
        ? { kind: "unknown" }
        : a.exact === 1
          ? DIM_ONE
          : { kind: "exact", value: a.exact }
    );
    const t: NumericType = tensorDoubleFromDims(dims);
    t.sign = "nonneg";
    return t;
  },
  codegenC(argsC, argTypes) {
    const axes = resolveArgs(argTypes, {
      file: "<codegen>",
      start: 0,
      end: 0,
    });
    const rows = axes[0].exact;
    const cols = axes[1].exact;
    // Scalar collapse (1×1): surrounding code expects a `double`-valued
    // expression matching the scalar result type from `transfer`.
    if (rows === 1 && cols === 1) return "1.0";
    const rowsC =
      rows !== undefined ? `${rows}L` : `(long)(${argsC[axes[0].argIndex]})`;
    const colsC =
      cols !== undefined ? `${cols}L` : `(long)(${argsC[axes[1].argIndex]})`;
    // 1-arg dynamic form: both axes share `argIndex = 0`. Route
    // through `_square` so the source expression is evaluated once.
    if (
      argTypes.length === 1 &&
      rows === undefined &&
      cols === undefined &&
      axes[0].argIndex === axes[1].argIndex
    ) {
      return `mtoc2_eye_square((long)(${argsC[axes[0].argIndex]}))`;
    }
    return `mtoc2_eye_rect(${rowsC}, ${colsC})`;
  },
  runtimeDeps: ["mtoc2_tensor_eye"],
};

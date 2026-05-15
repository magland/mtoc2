/**
 * `linspace(a, b)` / `linspace(a, b, n)` — n linearly-spaced values
 * from `a` to `b` inclusive as a 1×n row tensor.
 *
 * Defaults: `n = 100` for the 2-arg form. Edge cases match numbl:
 *  - `n <= 0`              → 1×0 empty tensor.
 *  - `n == 1`              → scalar value `b` (mtoc2's 1×1 lattice
 *                            collapse — numbl's makeTensor returns
 *                            a 1×1 here, which numbl's disp prints
 *                            as a scalar so byte-for-byte aligns).
 *  - `n > 1`               → first/last slots pinned at `a`/`b`
 *                            exactly (so NaN/Inf at one endpoint
 *                            doesn't contaminate the other); inner
 *                            values are `a + (b-a)*i/(n-1)`.
 *
 * `n` is rounded to integer (numbl uses `Math.round`).
 *
 * Args must be real-numeric scalars (double / logical). Complex
 * inputs are rejected — numbl's match function only accepts
 * `number`/`boolean` scalars, so this matches upstream behavior.
 *
 * When all three values are exact and the result fits the exact-
 * array cap, the transfer carries the computed data so downstream
 * type-driven folds (e.g. `sum`/`reshape`) can use it. Codegen still
 * emits the runtime helper — there is no compile-time tensor literal
 * path. The `n == 1` scalar-collapse is the lone codegen-side
 * literal substitution (necessary because the result type is scalar,
 * not a tensor).
 */

import type { Span } from "../../../parser/index.js";
import { TypeError } from "../../errors.js";
import {
  DIM_ONE,
  EXACT_ARRAY_MAX_ELEMENTS,
  isNumeric,
  isScalar,
  scalarDouble,
  signFromNumber,
  tensorDouble,
  tensorDoubleFromDims,
  type DimInfo,
  type NumericType,
  type Type,
} from "../../types.js";
import type { Builtin } from "../registry.js";
import { exactDouble } from "../_shared.js";

const DEFAULT_N = 100;

function requireScalarReal(t: Type, what: string, span: Span): void {
  if (!isNumeric(t)) {
    throw new TypeError(
      `${what} must be a scalar real numeric (got ${t.kind})`,
      span
    );
  }
  if (t.isComplex) {
    throw new TypeError(`${what} must be real (got complex)`, span);
  }
  if (t.elem !== "double" && t.elem !== "logical") {
    throw new TypeError(
      `${what} must be double or logical (got ${t.elem})`,
      span
    );
  }
  if (!isScalar(t)) {
    throw new TypeError(`${what} must be a scalar (got tensor)`, span);
  }
}

/** Compute the linspace values for the all-exact path. Mirrors numbl's
 *  formula byte-for-byte (same operator order, same n==1 shortcut, same
 *  opposite-sign-infinite-endpoint center placement). */
function computeLinspaceData(a: number, b: number, n: number): Float64Array {
  const data = new Float64Array(n);
  if (n === 0) return data;
  if (n === 1) {
    data[0] = b;
    return data;
  }
  data[0] = a;
  data[n - 1] = b;
  for (let i = 1; i < n - 1; i++) {
    data[i] = a + ((b - a) * i) / (n - 1);
  }
  if (
    (n & 1) === 1 &&
    !Number.isFinite(a) &&
    !Number.isFinite(b) &&
    Math.sign(a) !== Math.sign(b)
  ) {
    data[(n - 1) / 2] = 0;
  }
  return data;
}

export const linspace: Builtin = {
  name: "linspace",
  arity: { min: 2, max: 3 },
  transfer(argTypes, span) {
    requireScalarReal(argTypes[0], "'linspace' arg 1", span);
    requireScalarReal(argTypes[1], "'linspace' arg 2", span);
    if (argTypes.length === 3) {
      requireScalarReal(argTypes[2], "'linspace' arg 3", span);
    }

    const aV = exactDouble(argTypes[0]);
    const bV = exactDouble(argTypes[1]);
    const nRaw = argTypes.length === 3 ? exactDouble(argTypes[2]) : DEFAULT_N;

    if (nRaw !== undefined) {
      const n = Math.round(nRaw);
      if (n <= 0) {
        // Empty 1×0 — no exact data (0 elements; the discipline accepts
        // an empty Float64Array but there's nothing to constrain).
        return tensorDouble([1, 0]);
      }
      if (n === 1) {
        // Scalar collapse — the result is just `b`. Carry exact when
        // `b` is exact AND finite (the lattice's `exact` discipline
        // rejects NaN/Inf scalars).
        if (bV !== undefined && Number.isFinite(bV)) {
          return scalarDouble(signFromNumber(bV), bV);
        }
        return scalarDouble();
      }
      // n > 1 → 1×n row tensor.
      if (
        aV !== undefined &&
        bV !== undefined &&
        Number.isFinite(aV) &&
        Number.isFinite(bV) &&
        n <= EXACT_ARRAY_MAX_ELEMENTS
      ) {
        const data = computeLinspaceData(aV, bV, n);
        // Sanity: every interior element should also be finite when
        // both endpoints are; bail to no-exact if not (defensive).
        let allFinite = true;
        for (let i = 0; i < data.length; i++) {
          if (!Number.isFinite(data[i])) {
            allFinite = false;
            break;
          }
        }
        if (allFinite) {
          return tensorDouble([1, n], data);
        }
      }
      return tensorDouble([1, n]);
    }

    // n is runtime: shape is [1, unknown].
    const dims: DimInfo[] = [DIM_ONE, { kind: "unknown" }];
    return tensorDoubleFromDims(dims);
  },
  codegenC(argsC, argTypes) {
    const aC = argsC[0];
    const bC = argsC[1];
    const nC = argTypes.length === 3 ? argsC[2] : `${DEFAULT_N}.0`;

    // n == 1 scalar collapse: result type is scalar `b`. Use the C
    // comma operator so any side effect in `a` still fires.
    if (argTypes.length === 3) {
      const nV = exactDouble(argTypes[2] as NumericType);
      if (nV !== undefined && Math.round(nV) === 1) {
        return `((${aC}), (${bC}))`;
      }
    }
    return `mtoc2_tensor_linspace((double)(${aC}), (double)(${bC}), (long)lround(${nC}))`;
  },
  runtimeDeps: ["mtoc2_tensor_linspace"],
};

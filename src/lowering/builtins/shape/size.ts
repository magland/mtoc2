/**
 * `size` builtin.
 *
 * Two forms supported in mtoc2 v1:
 *
 *   - `size(A)`         → 1×ndim row tensor of dim sizes.
 *   - `size(A, k)`      → scalar (k-th dim, 1-based).
 *
 * The multi-output `[r, c] = size(A)` form (numbl: line ~448 of
 * `introspection.ts`) is deferred — same template once multi-output
 * builtins are wired.
 *
 * Numbl reference: `getShape(v)` (introspection.ts:46) — scalars and
 * complex scalars report `[1, 1]`; tensors report `v.shape` if
 * `ndim ≥ 2` else `[1, ...v.shape]`. mtoc2's type lattice already
 * normalizes to ≥ 2 dims via `tensorDoubleFromDims`, so we can read
 * `a.dims.length` and `a.shape` directly.
 *
 * Fold rules:
 *   - `size(t, k)` with exact `k` and statically-known shape →
 *     scalar with `exact` set.
 *   - `size(t)` with statically-known shape → 1×ndim row tensor with
 *     `exact: Float64Array` set (the data is just the shape).
 *   - shape unknown → no fold; codegen emits the runtime helper.
 *
 * For dynamic `k`, the return type is a non-negative scalar with no
 * exact (codegen reads `a.dims[k-1]` at runtime).
 */

import { TypeError } from "../../errors.js";
import {
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
import { exactDouble } from "../_shared.js";

export const size: Builtin = {
  name: "size",
  arity: { min: 1, max: 2 },
  transfer(argTypes, span) {
    const a = argTypes[0];
    if (!isNumeric(a)) {
      throw new TypeError(
        `'size' first arg must be numeric (got ${typeToString(a)})`,
        span
      );
    }

    if (argTypes.length === 2) {
      const k = argTypes[1];
      if (!isNumeric(k) || k.isComplex || !isScalar(k)) {
        throw new TypeError(
          `'size' second arg must be a real scalar (got ${typeToString(k)})`,
          span
        );
      }
      const kv = exactDouble(k);
      if (kv !== undefined) {
        if (!Number.isFinite(kv) || !Number.isInteger(kv) || kv < 1) {
          throw new TypeError(
            `'size' dim argument must be a positive integer (got ${kv})`,
            span
          );
        }
        // Static shape known → fold to the dim value.
        if (a.shape !== undefined) {
          const dimSize = kv <= a.shape.length ? a.shape[kv - 1] : 1;
          return scalarDouble(signFromNumber(dimSize), dimSize);
        }
      }
      return scalarDouble("nonneg");
    }

    // Single-arg form. Static shape → fold to exact 1×ndim row.
    const ndim = a.dims.length;
    if (a.shape !== undefined) {
      const data = new Float64Array(ndim);
      for (let i = 0; i < ndim; i++) data[i] = a.shape[i];
      return tensorDouble([1, ndim], data);
    }
    return tensorDouble([1, ndim]);
  },
  codegenC(argsC, argTypes) {
    const a = argTypes[0] as NumericType;
    if (argTypes.length === 2) {
      const kv = exactDouble(argTypes[1] as NumericType);
      if (kv !== undefined) {
        // The transfer step already validated kv is an exact positive
        // integer. Reading `dims[kv-1]` is safe even if kv > ndim
        // (in which case numbl returns 1; we emit a conditional).
        const ndim = a.dims.length;
        if (kv <= ndim) {
          // Scalar dynamic input — read the dim at runtime in case
          // the value isn't pinned in the type (rare; usually the
          // transfer fold caught it). Codegen always emits the bare
          // index since the type-level fold has already short-
          // circuited the exact-known case.
          return `((double)${argsC[0]}.dims[${kv - 1}])`;
        }
        return `1.0`;
      }
      // Dynamic k: branch at runtime on `k <= ndim`. Numbl returns 1
      // for k > ndim; mirror.
      return (
        `({ long _mtoc2_k = (long)(${argsC[1]}); ` +
        `(double)(_mtoc2_k >= 1 && _mtoc2_k <= ${argsC[0]}.ndim ? ${argsC[0]}.dims[_mtoc2_k - 1] : 1); })`
      );
    }

    // Single-arg form. Scalar input has no `mtoc2_tensor_t` to query
    // (it's a bare double in C); emit the literal shape directly. The
    // type-level fold has already folded for known-shape inputs, but
    // a dynamic scalar can still reach codegen via `%!numbl:opaque`.
    if (!isMultiElement(a)) {
      // Scalar of any kind → 1×1 row tensor [1, 1].
      return `mtoc2_tensor_from_row((double[]){1.0, 1.0}, 2)`;
    }
    return `mtoc2_tensor_size_row(${argsC[0]})`;
  },
  runtimeDeps: ["mtoc2_tensor_size_row", "mtoc2_tensor_from_row"],
};

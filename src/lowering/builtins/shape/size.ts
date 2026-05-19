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
 */

import { TypeError, UnsupportedConstruct } from "../../errors.js";
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
import type { RuntimeTensor, RuntimeValue } from "../../../runtime/value.js";
import { isTensor } from "../../../runtime/value.js";
import {
  mtoc2_tensor_from_row,
  mtoc2_tensor_size_row,
} from "../../../codegen/runtime/snippets.gen.js";

export const size: Builtin = {
  name: "size",
  transfer(argTypes, nargout) {
    if (argTypes.length < 1 || argTypes.length > 2) {
      throw new TypeError(`'size' expects 1..2 arg(s), got ${argTypes.length}`);
    }
    if (nargout !== 1) {
      throw new UnsupportedConstruct(
        `'size' does not support multi-output (nargout=${nargout})`
      );
    }
    const a = argTypes[0];
    if (!isNumeric(a)) {
      throw new TypeError(
        `'size' first arg must be numeric (got ${typeToString(a)})`
      );
    }

    if (argTypes.length === 2) {
      const k = argTypes[1];
      if (!isNumeric(k) || k.isComplex || !isScalar(k)) {
        throw new TypeError(
          `'size' second arg must be a real scalar (got ${typeToString(k)})`
        );
      }
      const kv = exactDouble(k);
      if (kv !== undefined) {
        if (!Number.isFinite(kv) || !Number.isInteger(kv) || kv < 1) {
          throw new TypeError(
            `'size' dim argument must be a positive integer (got ${kv})`
          );
        }
        if (a.shape !== undefined) {
          const dimSize = kv <= a.shape.length ? a.shape[kv - 1] : 1;
          return [scalarDouble(signFromNumber(dimSize), dimSize)];
        }
      }
      return [scalarDouble("nonneg")];
    }

    const ndim = a.dims.length;
    if (a.shape !== undefined) {
      const data = new Float64Array(ndim);
      for (let i = 0; i < ndim; i++) data[i] = a.shape[i];
      return [tensorDouble([1, ndim], data)];
    }
    return [tensorDouble([1, ndim])];
  },
  emitC({ argsC, argTypes, useRuntime }) {
    useRuntime("mtoc2_tensor_size_row");
    useRuntime("mtoc2_tensor_from_row");
    const a = argTypes[0] as NumericType;
    if (argTypes.length === 2) {
      const kv = exactDouble(argTypes[1] as NumericType);
      if (kv !== undefined) {
        const ndim = a.dims.length;
        if (kv <= ndim) {
          return `((double)${argsC[0]}.dims[${kv - 1}])`;
        }
        return `1.0`;
      }
      return (
        `({ long _mtoc2_k = (long)(${argsC[1]}); ` +
        `(double)(_mtoc2_k >= 1 && _mtoc2_k <= ${argsC[0]}.ndim ? ${argsC[0]}.dims[_mtoc2_k - 1] : 1); })`
      );
    }

    if (!isMultiElement(a)) {
      return `mtoc2_tensor_from_row((double[]){1.0, 1.0}, 2)`;
    }
    return `mtoc2_tensor_size_row(${argsC[0]})`;
  },
  emitJs({ argsJs, argTypes, useRuntime }) {
    useRuntime("mtoc2_tensor_size_row");
    useRuntime("mtoc2_tensor_from_row");
    const a = argTypes[0] as NumericType;
    if (argTypes.length === 2) {
      const kv = exactDouble(argTypes[1] as NumericType);
      if (kv !== undefined) {
        const ndim = a.dims.length;
        if (kv <= ndim) return `(${argsJs[0]}.shape[${kv - 1}])`;
        return `1`;
      }
      return (
        `((k => (k >= 1 && k <= ${argsJs[0]}.shape.length ` +
        `? ${argsJs[0]}.shape[k - 1] : 1))(Math.trunc(${argsJs[1]})))`
      );
    }
    if (!isMultiElement(a)) {
      return `mtoc2_tensor_from_row([1, 1], 2)`;
    }
    return `mtoc2_tensor_size_row(${argsJs[0]})`;
  },
  call({ args, argTypes }) {
    const t = args[0] as RuntimeValue;
    if (argTypes.length === 2) {
      const kv =
        typeof args[1] === "number" ? args[1] : Number(args[1] as object);
      const k = Math.trunc(kv);
      if (k < 1) {
        throw new TypeError(
          `'size' dim argument must be a positive integer (got ${k})`
        );
      }
      if (isTensor(t)) return [k <= t.shape.length ? t.shape[k - 1] : 1];
      return [1];
    }
    if (!isTensor(t)) {
      // Scalar: pad to a 2-element row [1, 1].
      return [mtoc2_tensor_from_row([1, 1], 2) as unknown as RuntimeTensor];
    }
    return [mtoc2_tensor_size_row(t) as unknown as RuntimeTensor];
  },
};

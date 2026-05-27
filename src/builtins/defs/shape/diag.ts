/**
 * `diag` builtin — matrix-diagonal extract / vector-to-diagonal
 * construct.
 *
 *   diag(v)     — vector (1×N or N×1) ⇒ N×N matrix with v on the
 *                 main diagonal, zeros elsewhere.
 *   diag(A)     — 2-D matrix (neither dim ≡ 1) ⇒ min(M,N)×1 column
 *                 vector of the main diagonal.
 *   diag(v, k)  — k-th super-/sub-diagonal. `k` must be a
 *                 statically-known integer literal. `k > 0` is
 *                 super-, `k < 0` is sub-diagonal.
 *   diag(scalar)        — pass-through (matches numbl's 1+|k| sizing
 *                         with k=0).
 *   diag(scalar, k≠0)   — (|k|+1)×(|k|+1) matrix with the scalar at
 *                         the k-th diagonal position.
 *
 * Mirrors numbl's `diag` tensor-branch in
 * `interpreter/builtins/array-manipulation.ts`. The sparse-matrix
 * branch is N/A (mtoc2 has no sparse type), and complex inputs are
 * deferred with `UnsupportedConstruct`.
 *
 * Input shape must be statically known (matches numbl's eager
 * dispatch on rows/cols), and `k` must be statically known so the
 * result shape is decidable at lowering time. Both restrictions can
 * be relaxed later.
 */

import { TypeError, UnsupportedConstruct } from "../../../lowering/errors.js";
import {
  EXACT_ARRAY_MAX_ELEMENTS,
  isNumeric,
  isScalar,
  scalarDouble,
  signFromNumber,
  tensorDouble,
  typeToString,
} from "../../../lowering/types.js";
import type { NumericType, Type } from "../../../lowering/types.js";
import type { Builtin } from "../../registry.js";
import { exactDouble, exactRealArray } from "../_shared.js";
import type { RuntimeTensor } from "../../../runtime/value.js";
import { isTensor, makeTensor } from "../../../runtime/value.js";
import {
  mtoc2_tensor_diag_construct as jsDiagConstruct,
  mtoc2_tensor_diag_extract as jsDiagExtract,
  mtoc2_tensor_diag_from_scalar as jsDiagFromScalar,
} from "../../runtime/snippets.gen.js";

/** Resolve the optional `k` argument to a JS integer. Throws on
 *  dynamic / non-integer / non-scalar k. */
function resolveK(argTypes: Type[]): number {
  if (argTypes.length < 2) return 0;
  const t = argTypes[1];
  if (!isNumeric(t) || !isScalar(t) || t.isComplex) {
    throw new TypeError(
      `'diag' second arg must be a scalar real integer (got ${typeToString(t)})`
    );
  }
  if (t.elem !== "double" && t.elem !== "logical") {
    throw new TypeError(
      `'diag' second arg must be double or logical (got ${t.elem})`
    );
  }
  const kv = exactDouble(t);
  if (kv === undefined) {
    throw new UnsupportedConstruct(
      `'diag' with a dynamic k argument is not yet supported (require a literal integer)`
    );
  }
  if (!Number.isFinite(kv) || !Number.isInteger(kv)) {
    throw new TypeError(`'diag' k must be a finite integer (got ${kv})`);
  }
  return kv;
}

/** Compute the length of the k-th diagonal of an M×N matrix. */
function diagonalLength(rows: number, cols: number, k: number): number {
  return k >= 0
    ? Math.max(0, Math.min(rows, cols - k))
    : Math.max(0, Math.min(rows + k, cols));
}

export const diag: Builtin = {
  name: "diag",
  transfer(argTypes, nargout) {
    if (argTypes.length < 1 || argTypes.length > 2) {
      throw new TypeError(`'diag' expects 1..2 arg(s), got ${argTypes.length}`);
    }
    if (nargout !== 1) {
      throw new UnsupportedConstruct(
        `'diag' does not support multi-output (nargout=${nargout})`
      );
    }

    const a = argTypes[0];
    if (!isNumeric(a)) {
      throw new TypeError(
        `'diag' first arg must be numeric (got ${typeToString(a)})`
      );
    }
    if (a.elem !== "double" && a.elem !== "logical") {
      throw new TypeError(
        `'diag' first arg must be a double or logical tensor (got ${a.elem})`
      );
    }
    if (a.isComplex) {
      throw new UnsupportedConstruct(
        `'diag' on complex tensors is not yet supported`
      );
    }

    const k = resolveK(argTypes);
    const absK = Math.abs(k);

    // ── Scalar input ─────────────────────────────────────────
    if (isScalar(a)) {
      if (k === 0) {
        // Pass-through: 1×1 diag(v) is just v.
        const v = exactDouble(a);
        if (v !== undefined) {
          return [scalarDouble(signFromNumber(v), v)];
        }
        return [scalarDouble(a.sign)];
      }
      // (|k|+1)×(|k|+1) matrix with v at the off-diagonal position.
      const m = 1 + absK;
      const shape = [m, m];
      const total = m * m;
      const v = exactDouble(a);
      if (v !== undefined && total <= EXACT_ARRAY_MAX_ELEMENTS) {
        const data = new Float64Array(total);
        const r = k < 0 ? -k : 0;
        const c = k > 0 ? k : 0;
        data[r + c * m] = v;
        return [tensorDouble(shape, data)];
      }
      return [tensorDouble(shape)];
    }

    // ── Tensor input ─────────────────────────────────────────
    if (a.dims.length !== 2) {
      throw new UnsupportedConstruct(
        `'diag' requires a 2-D operand (got ${a.dims.length}-D)`
      );
    }
    if (a.shape === undefined) {
      throw new UnsupportedConstruct(
        `'diag' of a tensor with unknown shape is not yet supported`
      );
    }
    const [rows, cols] = a.shape;

    if (rows === 1 || cols === 1) {
      // Construct path. vecLen = max(rows, cols) (one dim is 1).
      const vecLen = Math.max(rows, cols);
      const m = vecLen + absK;
      const shape = [m, m];
      const total = m * m;
      const arr = exactRealArray(a);
      if (arr !== undefined && total <= EXACT_ARRAY_MAX_ELEMENTS) {
        const data = new Float64Array(total);
        for (let i = 0; i < vecLen; i++) {
          const r = k < 0 ? i - k : i;
          const c = k > 0 ? i + k : i;
          data[r + c * m] = arr[i];
        }
        return [tensorDouble(shape, data)];
      }
      return [tensorDouble(shape)];
    }

    // Extract path.
    const diagLen = diagonalLength(rows, cols, k);
    const arr = exactRealArray(a);

    if (diagLen === 0) {
      // Empty diagonal — 0×1 column vector. Cannot carry exact data.
      return [tensorDouble([0, 1])];
    }
    if (diagLen === 1) {
      // Single-element diagonal degenerates to a scalar.
      if (arr !== undefined) {
        const r = k < 0 ? -k : 0;
        const c = k > 0 ? k : 0;
        const v = arr[r + c * rows];
        return [scalarDouble(signFromNumber(v), v)];
      }
      return [scalarDouble("unknown")];
    }

    const shape = [diagLen, 1];
    if (arr !== undefined && diagLen <= EXACT_ARRAY_MAX_ELEMENTS) {
      const data = new Float64Array(diagLen);
      for (let i = 0; i < diagLen; i++) {
        const r = k < 0 ? -k + i : i;
        const c = k > 0 ? k + i : i;
        data[i] = arr[r + c * rows];
      }
      return [tensorDouble(shape, data)];
    }
    return [tensorDouble(shape)];
  },

  emitC({ argsC, argTypes, useRuntime }) {
    const a = argTypes[0] as NumericType;
    const k = resolveK(argTypes);

    if (isScalar(a)) {
      if (k === 0) return argsC[0];
      useRuntime("mtoc2_tensor_diag");
      return `mtoc2_tensor_diag_from_scalar(${argsC[0]}, ${k}L)`;
    }

    const rows = (a.shape as number[])[0];
    const cols = (a.shape as number[])[1];

    if (rows === 1 || cols === 1) {
      useRuntime("mtoc2_tensor_diag");
      return `mtoc2_tensor_diag_construct(${argsC[0]}, ${k}L)`;
    }

    const diagLen = diagonalLength(rows, cols, k);
    if (diagLen === 1) {
      const r = k < 0 ? -k : 0;
      const c = k > 0 ? k : 0;
      const offset = r + c * rows;
      return `${argsC[0]}.real[${offset}]`;
    }
    useRuntime("mtoc2_tensor_diag");
    return `mtoc2_tensor_diag_extract(${argsC[0]}, ${k}L)`;
  },

  emitJs({ argsJs, argTypes, useRuntime }) {
    const a = argTypes[0] as NumericType;
    const k = resolveK(argTypes);

    if (isScalar(a)) {
      if (k === 0) return argsJs[0];
      useRuntime("mtoc2_tensor_diag");
      return `mtoc2_tensor_diag_from_scalar(${argsJs[0]}, ${k})`;
    }

    const rows = (a.shape as number[])[0];
    const cols = (a.shape as number[])[1];

    if (rows === 1 || cols === 1) {
      useRuntime("mtoc2_tensor_diag");
      return `mtoc2_tensor_diag_construct(${argsJs[0]}, ${k})`;
    }

    const diagLen = diagonalLength(rows, cols, k);
    if (diagLen === 1) {
      const r = k < 0 ? -k : 0;
      const c = k > 0 ? k : 0;
      const offset = r + c * rows;
      return `${argsJs[0]}.data[${offset}]`;
    }
    useRuntime("mtoc2_tensor_diag");
    return `mtoc2_tensor_diag_extract(${argsJs[0]}, ${k})`;
  },

  call({ args, argTypes }) {
    const a = argTypes[0] as NumericType;
    const k = resolveK(argTypes);

    if (isScalar(a)) {
      if (k === 0) return [args[0]];
      const v = typeof args[0] === "number" ? args[0] : Number(args[0]);
      return [jsDiagFromScalar(v, k) as unknown as RuntimeTensor];
    }

    if (!isTensor(args[0])) {
      throw new TypeError(
        `'diag' runtime arg has tensor type but runtime value isn't a tensor`
      );
    }
    const t = args[0] as RuntimeTensor;
    const rows = t.shape[0];
    const cols = t.shape[1];

    if (rows === 1 || cols === 1) {
      return [jsDiagConstruct(t, k) as unknown as RuntimeTensor];
    }

    const diagLen = diagonalLength(rows, cols, k);
    if (diagLen === 0) {
      return [makeTensor([0, 1], new Float64Array(0))];
    }
    if (diagLen === 1) {
      const r = k < 0 ? -k : 0;
      const c = k > 0 ? k : 0;
      return [t.data[r + c * rows]];
    }
    return [jsDiagExtract(t, k) as unknown as RuntimeTensor];
  },
};

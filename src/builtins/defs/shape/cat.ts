/**
 * `cat` builtin — concatenate N tensors along a given dimension.
 *
 * Surface: `cat(dim, A, B, ...)` where `dim >= 1` is a statically-known
 * positive integer literal (dynamic dims are deferred). Mirrors numbl's
 * `cat` (and the underlying `catAlongDim` in
 * `numbl/runtime/tensor-construction.ts`):
 *
 *   - dim==1 → vertical concat (along rows). Equivalent to `[A; B]`.
 *   - dim==2 → horizontal concat (along cols). Equivalent to `[A B]`.
 *   - dim>=3 → grow a new outer axis; result is N-D.
 *
 * Discipline:
 *   - Every non-dim arg must be real numeric (double or logical).
 *     Complex inputs are rejected with `UnsupportedConstruct`.
 *   - Scalar args are treated as 1×1 tensors (matching numbl).
 *   - Empty inputs along the cat axis are dropped at runtime. A zero-
 *     element input also drops when its non-cat dims don't match the
 *     reference shape (the asymmetric MATLAB rule).
 *   - All inputs must agree on every non-cat axis; the result extent
 *     along the cat axis is the sum of input extents.
 *
 * Exact-folding: when every input has statically-known shape and exact
 * data, and the result fits `EXACT_ARRAY_MAX_ELEMENTS`, the result is
 * computed at transfer time.
 *
 * Codegen dispatches to `mtoc2_tensor_cat(dim, nin, xs)` (a single
 * runtime helper that accepts a tagged-arg array — see
 * `tensor_cat.h`).
 */

import { TypeError, UnsupportedConstruct } from "../../../lowering/errors.js";
import {
  EXACT_ARRAY_MAX_ELEMENTS,
  MTOC2_MAX_NDIM,
  isNumeric,
  isScalar,
  shapeNumel,
  tensorDouble,
  typeToString,
} from "../../../lowering/types.js";
import type { NumericType, Type } from "../../../lowering/types.js";
import type { Builtin } from "../../registry.js";
import type { RuntimeTensor, RuntimeValue } from "../../../runtime/value.js";
import { exactDouble, exactRealArray } from "../_shared.js";
import { mtoc2_tensor_cat as jsCat } from "../../runtime/snippets.gen.js";

/** Compile-time view of an input arg for the shape-derivation passes. */
interface InputView {
  /** Padded shape (length = ndim). `null` axis means unknown. */
  shape: (number | null)[];
  /** Total element count when every axis is known; null otherwise. */
  total: number | null;
  /** Exact data when both `total` is known and the input had exact data. */
  exact?: Float64Array | number;
  /** Original argTypes index (1-based wrt full argTypes). */
  idx: number;
}

/** Resolve and validate `dim` from `argTypes[0]`. Must be a static
 *  positive integer in v1. */
function resolveDim(argTypes: Type[]): number {
  const d = argTypes[0];
  if (!isNumeric(d) || !isScalar(d) || d.isComplex) {
    throw new TypeError(
      `'cat' first arg (dim) must be a scalar real integer (got ${typeToString(d)})`
    );
  }
  if (d.elem !== "double" && d.elem !== "logical") {
    throw new TypeError(
      `'cat' first arg (dim) must be a scalar real integer (got ${d.elem})`
    );
  }
  const v = exactDouble(d);
  if (v === undefined) {
    throw new UnsupportedConstruct(
      `'cat' with a dynamic dim argument is not yet supported (require a statically-known dim)`
    );
  }
  if (!Number.isFinite(v) || !Number.isInteger(v) || v < 1) {
    throw new TypeError(`'cat' dim must be a positive integer (got ${v})`);
  }
  if (v > MTOC2_MAX_NDIM) {
    throw new UnsupportedConstruct(
      `'cat' supports dim ≤ ${MTOC2_MAX_NDIM} (got ${v})`
    );
  }
  return v;
}

/** Validate each input's type and build a per-input static view. */
function viewsForInputs(argTypes: Type[], ndim: number): InputView[] {
  const views: InputView[] = [];
  for (let i = 1; i < argTypes.length; i++) {
    const a = argTypes[i];
    if (!isNumeric(a)) {
      throw new TypeError(
        `'cat' arg ${i + 1} must be numeric (got ${typeToString(a)})`
      );
    }
    if (a.isComplex) {
      throw new UnsupportedConstruct(
        `'cat' on complex tensors is not yet supported`
      );
    }
    if (a.elem !== "double" && a.elem !== "logical") {
      throw new TypeError(
        `'cat' arg ${i + 1} must be a real double or logical (got ${a.elem})`
      );
    }
    if (isScalar(a)) {
      const ex = exactDouble(a);
      const shape: (number | null)[] = new Array(ndim).fill(1);
      views.push({
        shape,
        total: 1,
        exact: ex,
        idx: i,
      });
      continue;
    }
    // Tensor.
    if (a.dims.length > ndim) {
      // Should already be ndim ≥ a.dims.length; assertion only.
      throw new UnsupportedConstruct(
        `'cat' result ndim ${ndim} cannot accommodate input rank ${a.dims.length}`
      );
    }
    const shape: (number | null)[] = [];
    let total: number | null = 1;
    for (let d = 0; d < ndim; d++) {
      const di =
        d < a.dims.length ? a.dims[d] : ({ kind: "exact", value: 1 } as const);
      if (di.kind === "exact") {
        shape.push(di.value);
        if (total !== null) total *= di.value;
      } else {
        shape.push(null);
        total = null;
      }
    }
    const arr = exactRealArray(a);
    views.push({
      shape,
      total,
      exact: arr,
      idx: i,
    });
  }
  return views;
}

/** Compute result shape and (optionally) exact-folded data when every
 *  input is statically resolved. Returns `null` for the shape if any
 *  axis is unresolvable. */
function deriveResultShape(
  views: InputView[],
  dimIdx: number,
  ndim: number
): { shape: (number | null)[]; allStatic: boolean; refShape?: number[] } {
  // Drop fully-empty (total==0) views with non-cat dims that don't
  // match the ref. We can only do this at compile time when all
  // shapes are static. For now, fall through to a simpler rule:
  // emulate the runtime behavior conservatively for the all-static
  // case, and otherwise produce a result with the cat axis unknown.

  // Find a reference: first view with total > 0 (statically). If all
  // are statically empty, result is [0,0].
  let refIdx = -1;
  for (let i = 0; i < views.length; i++) {
    if (views[i].total !== null && views[i].total! > 0) {
      refIdx = i;
      break;
    }
  }
  if (refIdx === -1) {
    // Either every view is statically known empty (refShape = [0,..,0]),
    // or at least one view has unknown size. Pick the first view's shape
    // as a guess; result fully unknown otherwise.
    if (views.every(v => v.total === 0)) {
      // Canonical empty.
      const shape = new Array(ndim).fill(0);
      shape[0] = 0;
      shape[1] = 0;
      return { shape, allStatic: true, refShape: shape.slice() };
    }
    return { shape: new Array(ndim).fill(null), allStatic: false };
  }

  const refShapeRaw = views[refIdx].shape;
  // If any ref-axis is unknown, give up on static result.
  if (refShapeRaw.some(s => s === null)) {
    return { shape: new Array(ndim).fill(null), allStatic: false };
  }
  const refShape = refShapeRaw.map(s => s as number);

  // Walk every view: for non-cat dims, must agree with refShape. For
  // empty (total==0) views, we may drop them at runtime; ignore for
  // non-cat compatibility check here. Static incompatibility on a
  // non-empty view is a hard error.
  let allStatic = true;
  for (let i = 0; i < views.length; i++) {
    if (i === refIdx) continue;
    const v = views[i];
    if (v.shape.some(s => s === null)) {
      allStatic = false;
      continue;
    }
    if (v.total === 0) {
      // Runtime will drop or keep based on non-cat-dim match. Either
      // way, this doesn't constrain the result shape.
      continue;
    }
    for (let d = 0; d < ndim; d++) {
      if (d === dimIdx) continue;
      if (v.shape[d] !== refShape[d]) {
        throw new TypeError(
          `'cat' dimension mismatch on dimension ${d + 1}: ` +
            `arg ${refIdx + 2} has size ${refShape[d]}, ` +
            `arg ${v.idx + 1} has size ${v.shape[d]}`
        );
      }
    }
  }

  if (!allStatic) {
    // Result has known non-cat dims (from ref) but unknown cat dim.
    const out: (number | null)[] = refShape.slice();
    out[dimIdx] = null;
    return { shape: out, allStatic: false };
  }

  // Sum cat-dim extents, applying runtime's drop rule for empty views
  // whose non-cat dims don't match.
  let sum = 0;
  for (const v of views) {
    if (v.shape.some(s => s === null)) {
      // Unreachable in allStatic branch.
      return { shape: new Array(ndim).fill(null), allStatic: false };
    }
    const shp = v.shape.map(s => s as number);
    if (v.total === 0) {
      let compat = true;
      for (let d = 0; d < ndim; d++) {
        if (d === dimIdx) continue;
        if (shp[d] !== refShape[d]) {
          compat = false;
          break;
        }
      }
      if (!compat) continue;
    }
    sum += shp[dimIdx];
  }
  const out = refShape.slice();
  out[dimIdx] = sum;
  return { shape: out, allStatic: true, refShape };
}

/** Folded column-major copy: place every kept view's slab into `data`.
 *  Caller must have already validated shapes are compatible. */
function foldExact(
  views: InputView[],
  resultShape: number[],
  refShape: number[],
  dimIdx: number,
  ndim: number
): Float64Array | undefined {
  // Every view must have exact data and known shape.
  for (const v of views) {
    if (v.shape.some(s => s === null)) return undefined;
    if (v.total === null) return undefined;
    if (v.total === 0) continue; // empty — no data needed.
    if (v.exact === undefined) return undefined;
  }

  const total = shapeNumel(resultShape);
  if (total > EXACT_ARRAY_MAX_ELEMENTS) return undefined;
  const out = new Float64Array(total);
  if (total === 0) return out;

  let strideDim = 1;
  for (let d = 0; d < dimIdx; d++) strideDim *= resultShape[d];
  let numOuter = 1;
  for (let d = dimIdx + 1; d < ndim; d++) numOuter *= resultShape[d];

  for (let outer = 0; outer < numOuter; outer++) {
    let dstOff = outer * strideDim * resultShape[dimIdx];
    for (const v of views) {
      if (v.total === 0) {
        // Empty — possibly dropped at runtime.
        const shp = v.shape.map(s => s as number);
        let compat = true;
        for (let d = 0; d < ndim; d++) {
          if (d === dimIdx) continue;
          if (shp[d] !== refShape[d]) {
            compat = false;
            break;
          }
        }
        if (!compat) continue;
        // Compatible empty: contributes 0 along cat dim.
        continue;
      }
      const shp = v.shape.map(s => s as number);
      const srcDimSize = shp[dimIdx];
      const blockSize = strideDim * srcDimSize;
      const srcOff = outer * blockSize;
      // exact is either a Float64Array or (for scalar) a number.
      if (typeof v.exact === "number") {
        // scalar — blockSize is 1.
        out[dstOff] = v.exact;
      } else if (v.exact instanceof Float64Array) {
        out.set(v.exact.subarray(srcOff, srcOff + blockSize), dstOff);
      } else {
        return undefined;
      }
      dstOff += blockSize;
    }
  }
  return out;
}

export const cat: Builtin = {
  name: "cat",

  transfer(argTypes, nargout) {
    if (nargout !== 1) {
      throw new UnsupportedConstruct(
        `'cat' does not support multi-output (nargout=${nargout})`
      );
    }
    if (argTypes.length < 1) {
      throw new TypeError(`'cat' requires at least the dim argument`);
    }
    const dim = resolveDim(argTypes);

    if (argTypes.length === 1) {
      // No inputs after dim: numbl returns an empty [0,0] tensor.
      return [tensorDouble([0, 0])];
    }

    // ndim = max(2, dim, max input ndim).
    let ndim = Math.max(2, dim);
    for (let i = 1; i < argTypes.length; i++) {
      const a = argTypes[i];
      if (isNumeric(a) && !isScalar(a) && a.dims.length > ndim) {
        ndim = a.dims.length;
      }
    }
    if (ndim > MTOC2_MAX_NDIM) {
      throw new UnsupportedConstruct(
        `'cat' result ndim ${ndim} exceeds ${MTOC2_MAX_NDIM}`
      );
    }

    const views = viewsForInputs(argTypes, ndim);
    const {
      shape: resultShapeMaybe,
      allStatic,
      refShape,
    } = deriveResultShape(views, dim - 1, ndim);

    if (allStatic) {
      // Strip trailing 1s down to a 2-axis minimum (matches numbl /
      // mtoc2's universal "min-2D" rule, applied via tensorDouble).
      const trimmed = resultShapeMaybe.map(s => s as number);
      while (trimmed.length > 2 && trimmed[trimmed.length - 1] === 1) {
        trimmed.pop();
      }
      while (trimmed.length < 2) trimmed.push(1);

      // Exact-fold attempt — only when nothing got trimmed away in a
      // way that loses the cat-axis position.
      let exact: Float64Array | undefined;
      if (refShape !== undefined) {
        // Refold with the un-trimmed shape (the same data layout under
        // column-major).
        const folded = foldExact(
          views,
          resultShapeMaybe.map(s => s as number),
          refShape,
          dim - 1,
          ndim
        );
        if (folded !== undefined) exact = folded;
      }
      return [tensorDouble(trimmed, exact)];
    }

    // Dynamic — only the cat axis is unknown.
    // Build a min-2D shape with the known non-cat axes pinned.
    const shape: number[] = [];
    let unknownAxisFound = false;
    for (const s of resultShapeMaybe) {
      if (s === null) {
        unknownAxisFound = true;
        break;
      }
      shape.push(s);
    }
    if (!unknownAxisFound) {
      // Shouldn't reach here when allStatic is false. Fall back to
      // a conservative tensorDouble with a fully-known shape.
      const trimmed = shape.slice();
      while (trimmed.length > 2 && trimmed[trimmed.length - 1] === 1) {
        trimmed.pop();
      }
      while (trimmed.length < 2) trimmed.push(1);
      return [tensorDouble(trimmed)];
    }
    // Build the dims lattice manually since some axes are unknown.
    const dims = resultShapeMaybe.map(s =>
      s === null
        ? ({ kind: "unknown" } as const)
        : s === 1
          ? { kind: "exact" as const, value: 1 }
          : { kind: "exact" as const, value: s }
    );
    // Trim trailing exact-1.
    while (
      dims.length > 2 &&
      dims[dims.length - 1].kind === "exact" &&
      (dims[dims.length - 1] as { value: number }).value === 1
    ) {
      dims.pop();
    }
    const t: NumericType = {
      kind: "Numeric",
      elem: "double",
      isComplex: false,
      dims,
      sign: "unknown",
    };
    if (dims.every(d => d.kind === "exact")) {
      t.shape = dims.map(d => (d as { value: number }).value);
    }
    return [t];
  },

  emitC({ argsC, argTypes, useRuntime }) {
    useRuntime("mtoc2_tensor_cat");
    const dim = resolveDim(argTypes);
    const nin = argTypes.length - 1;
    if (nin === 0) {
      // Empty cat: numbl returns the canonical empty `[0,0]` tensor.
      // Build via the alloc helper directly.
      useRuntime("mtoc2_tensor_alloc_nd");
      return `mtoc2_tensor_alloc_nd(2, (long[]){0L, 0L})`;
    }
    const argInits: string[] = [];
    for (let i = 1; i < argTypes.length; i++) {
      const a = argTypes[i];
      if (isNumeric(a) && isScalar(a)) {
        argInits.push(`{.kind = 1, .scalar = (double)(${argsC[i]})}`);
      } else {
        argInits.push(`{.kind = 0, .tensor = ${argsC[i]}}`);
      }
    }
    return (
      `mtoc2_tensor_cat(${dim}L, ${nin}, ` +
      `(mtoc2_cat_arg_t[]){${argInits.join(", ")}})`
    );
  },

  emitJs({ argsJs, argTypes, useRuntime }) {
    useRuntime("mtoc2_tensor_cat");
    const dim = resolveDim(argTypes);
    const nin = argTypes.length - 1;
    if (nin === 0) {
      useRuntime("mtoc2_tensor_alloc_nd");
      return `mtoc2_tensor_alloc_nd(2, [0, 0])`;
    }
    const items: string[] = [];
    for (let i = 1; i < argTypes.length; i++) {
      items.push(argsJs[i]);
    }
    return `mtoc2_tensor_cat(${dim}, ${nin}, [${items.join(", ")}])`;
  },

  call({ args, argTypes }) {
    const dim = resolveDim(argTypes);
    const inputs: RuntimeValue[] = [];
    for (let i = 1; i < args.length; i++) {
      inputs.push(args[i]);
    }
    return [jsCat(dim, inputs.length, inputs) as unknown as RuntimeTensor];
  },
};

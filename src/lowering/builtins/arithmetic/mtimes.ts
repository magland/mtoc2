import { TypeError, UnsupportedConstruct } from "../../errors.js";
import {
  EXACT_ARRAY_MAX_ELEMENTS,
  isMultiElement,
  signFromExactArray,
  tensorDouble,
  type NumericType,
  type Sign,
} from "../../types.js";
import { type Builtin, getBuiltin } from "../registry.js";
import {
  exactRealArray,
  requireRealDouble,
  requireRealOrComplex,
} from "../_shared.js";

/** Result-sign rule for matrix multiplication. Each output element is
 *  a sum of products; we only assert sign when both operands are
 *  fully non-negative (or both non-positive), since any sign mixing
 *  in either operand can produce zeros from cancellation. Conservative
 *  by design — mtimes results are rarely sign-pinnable. */
function mtimesSign(a: NumericType, b: NumericType): Sign {
  const aNonneg =
    a.sign === "positive" || a.sign === "nonneg" || a.sign === "zero";
  const bNonneg =
    b.sign === "positive" || b.sign === "nonneg" || b.sign === "zero";
  if (aNonneg && bNonneg) return "nonneg";
  const aNonpos =
    a.sign === "negative" || a.sign === "nonpositive" || a.sign === "zero";
  const bNonpos =
    b.sign === "negative" || b.sign === "nonpositive" || b.sign === "zero";
  if (aNonpos && bNonpos) return "nonneg";
  if (aNonneg && bNonpos) return "nonpositive";
  if (aNonpos && bNonneg) return "nonpositive";
  return "unknown";
}

/** Compute `A * B` exactly given column-major data and statically known
 *  shapes. */
function mtimesExact(
  ad: Float64Array,
  m: number,
  k: number,
  bd: Float64Array,
  n: number
): Float64Array {
  const out = new Float64Array(m * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < m; i++) {
      let acc = 0;
      for (let p = 0; p < k; p++) {
        acc += ad[i + p * m] * bd[p + j * k];
      }
      out[i + j * m] = acc;
    }
  }
  return out;
}

// `mtimes` (matrix *): mirrors elementwise `times` when at least one
// arg is scalar; routes to a real 2-D matrix-multiply runtime helper
// when both args are tensors.
export const mtimes: Builtin = {
  name: "mtimes",
  arity: 2,
  transfer(argTypes, span) {
    requireRealOrComplex(argTypes[0], `'mtimes' arg 1`, span);
    requireRealOrComplex(argTypes[1], `'mtimes' arg 2`, span);
    const a = argTypes[0] as NumericType;
    const b = argTypes[1] as NumericType;
    if (!isMultiElement(a) || !isMultiElement(b)) {
      // Scalar mtimes delegates to elementwise times — identical fold
      // and codegen. The `times` transfer handles complex contamination.
      return getBuiltin("times")!.transfer(argTypes, span);
    }
    // Tensor mtimes: real-only in Phase 1 (Phase 3 adds complex).
    requireRealDouble(argTypes[0], `'mtimes' arg 1`, span);
    requireRealDouble(argTypes[1], `'mtimes' arg 2`, span);
    // Both tensors. v1: real, 2-D, statically inner-dim-matching when
    // shapes are known.
    if (a.shape !== undefined && a.shape.length !== 2) {
      throw new UnsupportedConstruct(
        `'mtimes' on a ${a.shape.length}-D tensor is not supported ` +
          `(MATLAB defines matrix multiplication only on 2-D operands)`,
        span
      );
    }
    if (b.shape !== undefined && b.shape.length !== 2) {
      throw new UnsupportedConstruct(
        `'mtimes' on a ${b.shape.length}-D tensor is not supported ` +
          `(MATLAB defines matrix multiplication only on 2-D operands)`,
        span
      );
    }
    if (a.dims.length !== 2 || b.dims.length !== 2) {
      throw new UnsupportedConstruct(
        `'mtimes' requires 2-D tensor operands (got ${a.dims.length}-D, ${b.dims.length}-D)`,
        span
      );
    }
    const aRows = a.shape?.[0];
    const aCols = a.shape?.[1];
    const bRows = b.shape?.[0];
    const bCols = b.shape?.[1];
    if (aCols !== undefined && bRows !== undefined && aCols !== bRows) {
      throw new TypeError(
        `'mtimes' inner-dim mismatch: ${aRows ?? "?"}×${aCols} * ${bRows}×${bCols ?? "?"}`,
        span
      );
    }
    // Result shape: outer dims of A and B.
    const m = aRows;
    const n = bCols;
    const sign = mtimesSign(a, b);
    if (m !== undefined && n !== undefined) {
      const k = aCols ?? bRows!;
      const total = m * n;
      // Exact-fold when both inputs are exact and the result fits the
      // cap. Avoids re-running the helper at runtime for compile-time-
      // known matrices.
      const ad = exactRealArray(a);
      const bd = exactRealArray(b);
      if (
        ad !== undefined &&
        bd !== undefined &&
        total <= EXACT_ARRAY_MAX_ELEMENTS
      ) {
        const out = mtimesExact(ad, m, k, bd, n);
        const t = tensorDouble([m, n], out);
        return { ...t, sign: signFromExactArray(out) };
      }
      const t = tensorDouble([m, n]);
      return { ...t, sign };
    }
    // Partially-unknown shape (e.g. one axis is `unknown` due to a
    // runtime-only length): emit the helper call; shape stays as
    // unknown on the relevant axis. We don't have a `tensorDoubleFromDims`-
    // backed factory that pins the known axes here, so return an
    // unknown-shape 2-D tensor and let the runtime helper validate.
    return {
      kind: "Numeric",
      elem: "double",
      isComplex: false,
      dims: [
        m !== undefined ? { kind: "exact", value: m } : { kind: "unknown" },
        n !== undefined ? { kind: "exact", value: n } : { kind: "unknown" },
      ],
      sign,
    };
  },
  codegenC(argsC, argTypes) {
    if (!isMultiElement(argTypes[0]) || !isMultiElement(argTypes[1])) {
      return getBuiltin("times")!.codegenC(argsC, argTypes);
    }
    const a = argTypes[0] as NumericType;
    const b = argTypes[1] as NumericType;
    // 1×k * k×1 → 1×1 scalar. Transfer returns a scalar type for this
    // shape; consumers (`disp`, scalar arithmetic, …) expect a `double`
    // C expression. The scalar helper does the inner product without
    // allocating a tensor.
    if (a.shape?.[0] === 1 && b.shape?.[1] === 1) {
      return `mtoc2_tensor_mtimes_real_scalar(${argsC[0]}, ${argsC[1]})`;
    }
    return `mtoc2_tensor_mtimes_real(${argsC[0]}, ${argsC[1]})`;
  },
  runtimeDeps: ["mtoc2_tensor_elemwise_real", "mtoc2_tensor_mtimes_real"],
};

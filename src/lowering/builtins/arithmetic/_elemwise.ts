/**
 * Shared infrastructure for elementwise real binary builtins
 * (`plus`, `minus`, `times`, `rdivide`).
 */

import { UnsupportedConstruct, TypeError } from "../../errors.js";
import {
  type DimInfo,
  DIM_ONE,
  type NumericType,
  type Sign,
  scalarDouble,
  scalarComplex,
  tensorDouble,
  tensorDoubleFromDims,
  tensorComplexFromDims,
  signFromNumber,
  flipSign,
  isDimOne,
  isMultiElement,
  shapeNumel,
  EXACT_ARRAY_MAX_ELEMENTS,
} from "../../types.js";
import type { Builtin } from "../registry.js";
import {
  requireRealOrComplex,
  exactDouble,
  exactRealArray,
  exactScalarAsComplex,
} from "../_shared.js";

/** Result of broadcast shape resolution for the elementwise binary path.
 *  `outDims` is the output's per-axis dim info (MATLAB-style implicit
 *  expansion: align on axis 1, pad with 1s on the right, axis-wise
 *  `da == db || da == 1 || db == 1`). `bcast` is true when the C runtime
 *  needs the broadcasting helper rather than the fast `_tt` path —
 *  either the ndims differ or at least one statically-singleton axis
 *  needs to be replicated against a non-singleton sibling. */
type ResolvedShape = {
  outDims: DimInfo[];
  /** True when broadcast (any axis where one side is statically 1 but
   *  the other is not, OR ndims differ). False when the two arg shapes
   *  match dim-for-dim (modulo unknowns the runtime trusts). */
  bcast: boolean;
};

/** Shape resolution for elementwise binary. Returns `null` for scalar+
 *  scalar; otherwise computes the broadcast output shape and whether
 *  broadcasting is required. Throws on statically incompatible axes
 *  (no span — the framework's `withSpan` wrapper attaches the call-site
 *  span). Exported for `power.ts`, which shares the same broadcast rules. */
export function elemwiseResultShape(
  a: NumericType,
  b: NumericType,
  name: string
): ResolvedShape | null {
  const aMulti = isMultiElement(a);
  const bMulti = isMultiElement(b);
  if (!aMulti && !bMulti) return null; // scalar OP scalar
  if (!aMulti) return { outDims: b.dims.slice(), bcast: false };
  if (!bMulti) return { outDims: a.dims.slice(), bcast: false };
  // Both tensor. Pad to common ndim (trailing 1s) and check axis-wise.
  const rnd = Math.max(a.dims.length, b.dims.length);
  const outDims: DimInfo[] = new Array(rnd);
  let bcast = a.dims.length !== b.dims.length;
  for (let i = 0; i < rnd; i++) {
    const da: DimInfo = i < a.dims.length ? a.dims[i] : DIM_ONE;
    const db: DimInfo = i < b.dims.length ? b.dims[i] : DIM_ONE;
    const aOne = isDimOne(da);
    const bOne = isDimOne(db);
    if (aOne && bOne) {
      outDims[i] = DIM_ONE;
      continue;
    }
    if (aOne) {
      outDims[i] = db;
      bcast = true;
      continue;
    }
    if (bOne) {
      outDims[i] = da;
      bcast = true;
      continue;
    }
    // Neither statically 1. If both exact, must match.
    if (da.kind === "exact" && db.kind === "exact") {
      if (da.value !== db.value) {
        throw new UnsupportedConstruct(
          `'${name}' shape mismatch (${dimsToStr(a.dims)} vs ${dimsToStr(b.dims)}); axis ${i + 1} is ${da.value} vs ${db.value} — incompatible for implicit expansion`
        );
      }
      outDims[i] = da;
    } else if (da.kind === "exact") {
      outDims[i] = da;
    } else if (db.kind === "exact") {
      outDims[i] = db;
    } else {
      outDims[i] = { kind: "unknown" };
    }
  }
  return { outDims, bcast };
}

function dimsToStr(dims: ReadonlyArray<DimInfo>): string {
  return dims.map(d => (d.kind === "exact" ? `${d.value}` : "?")).join("×");
}

/** True iff an elementwise binary op on tensor operands `a` and `b`
 *  needs the broadcasting `_bcast_tt` helper rather than the same-shape
 *  `_tt` fast path. Mirrors the per-axis compatibility logic inside
 *  `elemwiseResultShape` but returns just the bool — codegen call
 *  sites don't need to thread the resolved output shape from transfer.
 *  Exported for `power.ts`, which shares the same codegen discipline. */
export function needsBroadcast(a: NumericType, b: NumericType): boolean {
  if (a.dims.length !== b.dims.length) return true;
  for (let i = 0; i < a.dims.length; i++) {
    if (isDimOne(a.dims[i]) !== isDimOne(b.dims[i])) return true;
  }
  return false;
}

/** Compute the broadcast-aware elementwise fold over `a` and `b` for
 *  the given (fully-exact) output shape, applying `step` per slot.
 *  Both sides must already carry exact data (a `Float64Array` or a
 *  scalar `number`); the caller is responsible for the
 *  `EXACT_ARRAY_MAX_ELEMENTS` cap. Singleton axes on either side get
 *  stride 0 so they broadcast against non-singleton output axes;
 *  output is filled in column-major order to match the runtime layout.
 *  Exported for `power.ts`, which shares the same broadcast rules. */
export function broadcastFoldExact(
  a: NumericType,
  b: NumericType,
  outShape: number[],
  step: (av: number, bv: number) => number
): Float64Array {
  const total = shapeNumel(outShape);
  const rnd = outShape.length;
  const aArr = exactRealArray(a);
  const bArr = exactRealArray(b);
  const ax = exactDouble(a);
  const bx = exactDouble(b);
  const aShape: number[] = new Array(rnd);
  const bShape: number[] = new Array(rnd);
  for (let i = 0; i < rnd; i++) {
    const da = i < a.dims.length ? a.dims[i] : DIM_ONE;
    const db = i < b.dims.length ? b.dims[i] : DIM_ONE;
    aShape[i] = da.kind === "exact" ? da.value : 1;
    bShape[i] = db.kind === "exact" ? db.value : 1;
  }
  const aStride: number[] = new Array(rnd);
  const bStride: number[] = new Array(rnd);
  let aAcc = 1;
  let bAcc = 1;
  for (let i = 0; i < rnd; i++) {
    aStride[i] = aShape[i] === 1 ? 0 : aAcc;
    bStride[i] = bShape[i] === 1 ? 0 : bAcc;
    aAcc *= aShape[i];
    bAcc *= bShape[i];
  }
  const data = new Float64Array(total);
  const ix = new Array(rnd).fill(0);
  for (let k = 0; k < total; k++) {
    let ai = 0;
    let bi = 0;
    for (let i = 0; i < rnd; i++) {
      ai += ix[i] * aStride[i];
      bi += ix[i] * bStride[i];
    }
    const av = aArr ? aArr[ai] : (ax as number);
    const bv = bArr ? bArr[bi] : (bx as number);
    data[k] = step(av, bv);
    for (let i = 0; i < rnd; i++) {
      ix[i]++;
      if (ix[i] < outShape[i]) break;
      ix[i] = 0;
    }
  }
  return data;
}

/** Build a real elementwise binary builtin: scalar, scalar+tensor,
 *  tensor+scalar, tensor+tensor. Folds when every input is exact.
 *  `helperBase` names the matching set of C runtime helpers
 *  (mtoc2_tensor_<helperBase>_tt / _ts / _st). Commutative ops set
 *  `commutative=true` so the scalar-first path reuses `_ts` with
 *  swapped operands.
 *
 *  The four shape combos and what they emit:
 *
 *  | a       | b       | C output                                   |
 *  |---------|---------|--------------------------------------------|
 *  | scalar  | scalar  | `(argsC[0] cOp argsC[1])`                  |
 *  | tensor  | scalar  | `mtoc2_tensor_<helperBase>_ts(a, b)`       |
 *  | scalar  | tensor  | commutative → `_ts(b, a)`; else `_st(a,b)` |
 *  | tensor  | tensor  | `mtoc2_tensor_<helperBase>_tt(a, b)`       |
 *
 *  `complexFold` / `complexScalarExpr` / `complexRuntimeDeps` are
 *  optional; when set, a scalar+scalar op with at least one complex
 *  operand routes through them (and `transfer` returns a complex
 *  result). Phase 1 wires complex scalars; tensor+complex paths are
 *  rejected until Phase 3 lands the runtime helpers.
 */
export function defineElemwiseRealBinary(opts: {
  name: string;
  cOp: string;
  helperBase: string;
  commutative: boolean;
  fold: (a: number, b: number) => number;
  signRule: (a: NumericType, b: NumericType) => Sign;
  /** Scalar-complex fold. Receives two `{re, im}` operands. */
  complexFold?: (
    a: { re: number; im: number },
    b: { re: number; im: number }
  ) => { re: number; im: number };
  /** Scalar-complex C expression. Defaults to the same `(a cOp b)`
   *  infix as the real path — works for `+ - *` because C99 promotes
   *  real↔complex automatically. Divide overrides to route through
   *  `mtoc2_cdiv(a, b)`. */
  complexScalarExpr?: (aC: string, bC: string) => string;
  /** Extra runtime snippet activations needed by the complex scalar
   *  path (e.g. `mtoc2_cdiv` for division). The real-only `_real`
   *  helper still activates unconditionally for the tensor path. */
  complexRuntimeDeps?: string[];
}): Builtin {
  // Default scalar-complex emit: route through the per-op helper from
  // `cscalar.h` instead of relying on C99 operator overloading on
  // `_Complex` operands. This keeps mtoc2's user-code emission
  // operator-free for complex, which lets the c2js JS backend ship
  // matching `{re, im}` helpers without learning to type-track
  // expressions. The C native path inlines `mtoc2_c*` back to the
  // same instructions C99 would have generated, so there's no cost.
  const defaultComplexHelper: Record<string, string | undefined> = {
    "+": "mtoc2_cadd",
    "-": "mtoc2_csub",
    "*": "mtoc2_cmul",
  };
  const helperName = defaultComplexHelper[opts.cOp];
  const defaultComplexScalarExpr = helperName
    ? (a: string, b: string) => `${helperName}(${a}, ${b})`
    : (a: string, b: string) => `(${a} ${opts.cOp} ${b})`;
  const defaultComplexDeps = helperName ? ["mtoc2_cscalar"] : [];
  return buildElemwiseRealBinary({
    name: opts.name,
    helperBase: opts.helperBase,
    commutative: opts.commutative,
    fold: opts.fold,
    signRule: opts.signRule,
    scalarExpr: (a, b) => `(${a} ${opts.cOp} ${b})`,
    runtimeDep: "mtoc2_tensor_elemwise_real",
    complexFold: opts.complexFold,
    complexScalarExpr: opts.complexScalarExpr ?? defaultComplexScalarExpr,
    complexRuntimeDeps: opts.complexRuntimeDeps ?? defaultComplexDeps,
  });
}

/** Same as `defineElemwiseRealBinary`, but the scalar path emits a C
 *  function call (`fmod(a,b)`, `atan2(a,b)`, …) instead of an infix
 *  operator. The tensor helpers still follow the `_tt`/`_ts`/`_st`
 *  naming convention; supply the appropriate `runtimeDep` for the
 *  snippet that defines them (`mtoc2_tensor_elemwise_real_fn`
 *  covers `mod`/`rem`/`atan2`/`hypot`). */
export function defineElemwiseRealBinaryFn(opts: {
  name: string;
  cFn: string;
  helperBase: string;
  commutative: boolean;
  fold: (a: number, b: number) => number;
  signRule: (a: NumericType, b: NumericType) => Sign;
  runtimeDep: string;
}): Builtin {
  return buildElemwiseRealBinary({
    name: opts.name,
    helperBase: opts.helperBase,
    commutative: opts.commutative,
    fold: opts.fold,
    signRule: opts.signRule,
    scalarExpr: (a, b) => `${opts.cFn}(${a}, ${b})`,
    runtimeDep: opts.runtimeDep,
  });
}

function buildElemwiseRealBinary(opts: {
  name: string;
  helperBase: string;
  commutative: boolean;
  fold: (a: number, b: number) => number;
  signRule: (a: NumericType, b: NumericType) => Sign;
  scalarExpr: (aC: string, bC: string) => string;
  runtimeDep: string;
  complexFold?: (
    a: { re: number; im: number },
    b: { re: number; im: number }
  ) => { re: number; im: number };
  complexScalarExpr?: (aC: string, bC: string) => string;
  complexRuntimeDeps?: string[];
}): Builtin {
  const {
    name,
    helperBase,
    commutative,
    fold,
    signRule,
    scalarExpr,
    runtimeDep,
    complexFold,
    complexScalarExpr,
    complexRuntimeDeps,
  } = opts;
  return {
    name,
    transfer(argTypes, nargout) {
      if (argTypes.length !== 2) {
        throw new TypeError(
          `'${name}' expects 2 arg(s), got ${argTypes.length}`
        );
      }
      if (nargout !== 1) {
        throw new UnsupportedConstruct(
          `'${name}' does not support multi-output (nargout=${nargout})`
        );
      }
      const a = argTypes[0];
      const b = argTypes[1];
      requireRealOrComplex(a, `'${name}' arg 1`);
      requireRealOrComplex(b, `'${name}' arg 2`);
      const aN = a as NumericType;
      const bN = b as NumericType;
      // Complex contamination: any complex operand makes the result
      // complex. The complex elemwise helpers tolerate an `imag ==
      // NULL` operand (treated as zero imag), so we can hand a real
      // tensor straight into the complex_tt path — no promote step.
      const aCx = aN.isComplex;
      const bCx = bN.isComplex;
      const anyComplex = aCx || bCx;
      if (anyComplex) {
        if (complexFold === undefined) {
          throw new UnsupportedConstruct(
            `'${name}' is not defined for complex scalars`
          );
        }
        if (!isMultiElement(aN) && !isMultiElement(bN)) {
          // Scalar+scalar (any mix) — fold or emit runtime.
          const ax = exactScalarAsComplex(aN);
          const bx = exactScalarAsComplex(bN);
          if (ax !== undefined && bx !== undefined) {
            const v = complexFold(ax, bx);
            if (Number.isFinite(v.re) && Number.isFinite(v.im)) {
              return [scalarComplex(v)];
            }
          }
          return [scalarComplex()];
        }
        // At least one is a complex tensor (the all-real-tensor +
        // complex-scalar case is also here). Build the result shape
        // via the same broadcast logic; the result is a complex
        // tensor (or scalar if both are scalar — handled above).
        const resolved = elemwiseResultShape(aN, bN, name);
        if (resolved === null) {
          // Unreachable: at least one is multi-element by the check
          // above. Defensive.
          return [scalarComplex()];
        }
        return [tensorComplexFromDims(resolved.outDims)];
      }
      const resolved = elemwiseResultShape(aN, bN, name);

      if (resolved === null) {
        // Pure scalar op — fold if exact.
        const ax = exactDouble(aN);
        const bx = exactDouble(bN);
        if (ax !== undefined && bx !== undefined) {
          const v = fold(ax, bx);
          if (Number.isFinite(v)) return [scalarDouble(signFromNumber(v), v)];
        }
        return [scalarDouble(signRule(aN, bN))];
      }

      // Build the result NumericType (carries `shape` automatically when
      // every output dim is exact).
      const outTy = tensorDoubleFromDims(resolved.outDims);

      // Try to fold when every input is exact AND every output dim is
      // known (so the result fits the exact-array cap).
      const aIsExact =
        exactRealArray(aN) !== undefined || exactDouble(aN) !== undefined;
      const bIsExact =
        exactRealArray(bN) !== undefined || exactDouble(bN) !== undefined;
      if (
        aIsExact &&
        bIsExact &&
        outTy.shape !== undefined &&
        shapeNumel(outTy.shape) <= EXACT_ARRAY_MAX_ELEMENTS
      ) {
        const data = broadcastFoldExact(aN, bN, outTy.shape, fold);
        return [tensorDouble(outTy.shape, data)];
      }
      outTy.sign = signRule(aN, bN);
      return [outTy];
    },
    emit({ argsC, argTypes, useRuntime }) {
      const aN = argTypes[0] as NumericType;
      const bN = argTypes[1] as NumericType;
      const aMulti = isMultiElement(aN);
      const bMulti = isMultiElement(bN);
      const anyComplex = aN.isComplex || bN.isComplex;
      if (!aMulti && !bMulti) {
        if (anyComplex) {
          if (complexScalarExpr === undefined) {
            throw new Error(
              `internal: '${name}' missing complexScalarExpr but reached complex codegen`
            );
          }
          if (complexRuntimeDeps) {
            for (const d of complexRuntimeDeps) useRuntime(d);
          }
          return complexScalarExpr(argsC[0], argsC[1]);
        }
        return scalarExpr(argsC[0], argsC[1]);
      }
      // Tensor paths — activate the runtime helper for this op.
      useRuntime(runtimeDep);
      if (anyComplex) {
        // Tensor + scalar / scalar + tensor with at least one
        // complex operand. The runtime helpers take a `double _Complex`
        // for the scalar slot; project a real scalar to that via
        // `mtoc2_cmake(re, 0.0)` at emit. The receiver tensor is
        // already complex (we reject mixed real-tensor + complex-
        // tensor at the transfer layer).
        useRuntime("mtoc2_tensor_elemwise_complex");
        useRuntime("mtoc2_cscalar");
        const base = `mtoc2_tensor_${helperBase}_complex`;
        const promote = (c: string, isComplexArg: boolean): string =>
          isComplexArg ? c : `mtoc2_cmake(${c}, 0.0)`;
        if (aMulti && bMulti) {
          return needsBroadcast(aN, bN)
            ? `${base}_bcast_tt(${argsC[0]}, ${argsC[1]})`
            : `${base}_tt(${argsC[0]}, ${argsC[1]})`;
        }
        if (aMulti) {
          return `${base}_ts(${argsC[0]}, ${promote(argsC[1], bN.isComplex)})`;
        }
        // scalar OP tensor
        if (commutative) {
          return `${base}_ts(${argsC[1]}, ${promote(argsC[0], aN.isComplex)})`;
        }
        return `${base}_st(${promote(argsC[0], aN.isComplex)}, ${argsC[1]})`;
      }
      if (aMulti && bMulti) {
        return needsBroadcast(aN, bN)
          ? `mtoc2_tensor_${helperBase}_bcast_tt(${argsC[0]}, ${argsC[1]})`
          : `mtoc2_tensor_${helperBase}_tt(${argsC[0]}, ${argsC[1]})`;
      }
      if (aMulti) {
        return `mtoc2_tensor_${helperBase}_ts(${argsC[0]}, ${argsC[1]})`;
      }
      // scalar OP tensor
      if (commutative) {
        return `mtoc2_tensor_${helperBase}_ts(${argsC[1]}, ${argsC[0]})`;
      }
      return `mtoc2_tensor_${helperBase}_st(${argsC[0]}, ${argsC[1]})`;
    },
    elementwise: true,
  };
}

export function signSum(a: NumericType, b: NumericType): Sign {
  // Conservative: only positive+positive ⇒ positive, nonneg+nonneg ⇒ nonneg.
  if (a.sign === "positive" && b.sign === "positive") return "positive";
  if (
    (a.sign === "positive" || a.sign === "nonneg" || a.sign === "zero") &&
    (b.sign === "positive" || b.sign === "nonneg" || b.sign === "zero")
  ) {
    return a.sign === "positive" || b.sign === "positive"
      ? "positive"
      : "nonneg";
  }
  if (a.sign === "negative" && b.sign === "negative") return "negative";
  if (
    (a.sign === "negative" || a.sign === "nonpositive" || a.sign === "zero") &&
    (b.sign === "negative" || b.sign === "nonpositive" || b.sign === "zero")
  ) {
    return a.sign === "negative" || b.sign === "negative"
      ? "negative"
      : "nonpositive";
  }
  return "unknown";
}

export function signDiff(a: NumericType, b: NumericType): Sign {
  return signSum(a, { ...b, sign: flipSign(b.sign) });
}

export function signProd(a: NumericType, b: NumericType): Sign {
  if (a.sign === "zero" || b.sign === "zero") return "zero";
  if (a.sign === "positive" && b.sign === "positive") return "positive";
  if (a.sign === "negative" && b.sign === "negative") return "positive";
  if (
    (a.sign === "positive" && b.sign === "negative") ||
    (a.sign === "negative" && b.sign === "positive")
  ) {
    return "negative";
  }
  // Lift the bounds to nonneg/nonpositive when both operands share a
  // sign. `0 * Inf = NaN` is the edge case; NaN is not `< 0` so it
  // doesn't violate the "≥ 0" interpretation our sqrt-domain check
  // relies on (and it doesn't violate `≤ 0` either).
  const aNonneg = a.sign === "positive" || a.sign === "nonneg";
  const bNonneg = b.sign === "positive" || b.sign === "nonneg";
  const aNonpos = a.sign === "negative" || a.sign === "nonpositive";
  const bNonpos = b.sign === "negative" || b.sign === "nonpositive";
  if (aNonneg && bNonneg) return "nonneg";
  if (aNonpos && bNonpos) return "nonneg";
  if ((aNonneg && bNonpos) || (aNonpos && bNonneg)) return "nonpositive";
  return "unknown";
}

/** Sign of `a / b`. Almost the same shape as `signProd`, but the
 *  divisor's sign tells a different story: `x / 0` is ±Inf (or NaN
 *  when `x` is also 0), NOT zero, so a zero divisor degrades the
 *  result to `unknown`. A zero numerator with a non-zero divisor is
 *  zero. */
export function signQuot(a: NumericType, b: NumericType): Sign {
  if (b.sign === "zero") return "unknown";
  if (a.sign === "zero") return "zero";
  if (a.sign === "positive" && b.sign === "positive") return "positive";
  if (a.sign === "negative" && b.sign === "negative") return "positive";
  if (
    (a.sign === "positive" && b.sign === "negative") ||
    (a.sign === "negative" && b.sign === "positive")
  ) {
    return "negative";
  }
  // Same "nonneg / nonneg = nonneg (NaN allowed)" relaxation as
  // signProd. Required for chains like `sqrt(errs / errs0 / k)` where
  // the numerator/denominator are sum-of-squares (nonneg) and we want
  // sqrt to accept the quotient.
  const aNonneg = a.sign === "positive" || a.sign === "nonneg";
  const bNonneg = b.sign === "positive" || b.sign === "nonneg";
  const aNonpos = a.sign === "negative" || a.sign === "nonpositive";
  const bNonpos = b.sign === "negative" || b.sign === "nonpositive";
  if (aNonneg && bNonneg) return "nonneg";
  if (aNonpos && bNonpos) return "nonneg";
  if ((aNonneg && bNonpos) || (aNonpos && bNonneg)) return "nonpositive";
  return "unknown";
}

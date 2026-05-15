/**
 * Shared infrastructure for elementwise real binary builtins
 * (`plus`, `minus`, `times`, `rdivide`).
 */

import type { Span } from "../../../parser/index.js";
import { UnsupportedConstruct } from "../../errors.js";
import {
  type DimInfo,
  DIM_ONE,
  type NumericType,
  type Sign,
  scalarDouble,
  scalarComplex,
  tensorDouble,
  tensorDoubleFromDims,
  signFromNumber,
  flipSign,
  isDimOne,
  isMultiElement,
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
 *  broadcasting is required. Throws on statically incompatible axes. */
function elemwiseResultShape(
  a: NumericType,
  b: NumericType,
  name: string,
  span: Span
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
          `'${name}' shape mismatch (${dimsToStr(a.dims)} vs ${dimsToStr(b.dims)}); axis ${i + 1} is ${da.value} vs ${db.value} — incompatible for implicit expansion`,
          span
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
}): Builtin;
export function defineElemwiseRealBinary(
  name: string,
  cOp: string,
  helperBase: string,
  commutative: boolean,
  fold: (a: number, b: number) => number,
  signRule: (a: NumericType, b: NumericType) => Sign
): Builtin;
export function defineElemwiseRealBinary(
  ...args:
    | [
        {
          name: string;
          cOp: string;
          helperBase: string;
          commutative: boolean;
          fold: (a: number, b: number) => number;
          signRule: (a: NumericType, b: NumericType) => Sign;
          complexFold?: (
            a: { re: number; im: number },
            b: { re: number; im: number }
          ) => { re: number; im: number };
          complexScalarExpr?: (aC: string, bC: string) => string;
          complexRuntimeDeps?: string[];
        },
      ]
    | [
        string,
        string,
        string,
        boolean,
        (a: number, b: number) => number,
        (a: NumericType, b: NumericType) => Sign,
      ]
): Builtin {
  const opts =
    args.length === 1
      ? args[0]
      : {
          name: args[0],
          cOp: args[1],
          helperBase: args[2],
          commutative: args[3],
          fold: args[4],
          signRule: args[5],
        };
  return buildElemwiseRealBinary({
    name: opts.name,
    helperBase: opts.helperBase,
    commutative: opts.commutative,
    fold: opts.fold,
    signRule: opts.signRule,
    scalarExpr: (a, b) => `(${a} ${opts.cOp} ${b})`,
    runtimeDep: "mtoc2_tensor_elemwise_real",
    complexFold: opts.complexFold,
    complexScalarExpr:
      opts.complexScalarExpr ?? ((a, b) => `(${a} ${opts.cOp} ${b})`),
    complexRuntimeDeps: opts.complexRuntimeDeps,
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
  const allDeps = [runtimeDep, ...(complexRuntimeDeps ?? [])];
  return {
    name,
    arity: 2,
    transfer(argTypes, span) {
      const a = argTypes[0];
      const b = argTypes[1];
      requireRealOrComplex(a, `'${name}' arg 1`, span);
      requireRealOrComplex(b, `'${name}' arg 2`, span);
      const aN = a as NumericType;
      const bN = b as NumericType;
      // Complex contamination: any complex operand makes the result
      // complex. Phase 1 supports scalar+scalar only — reject anything
      // with a multi-element complex operand.
      const aCx = aN.isComplex;
      const bCx = bN.isComplex;
      if (aCx || bCx) {
        if (isMultiElement(aN) || isMultiElement(bN)) {
          throw new UnsupportedConstruct(
            `'${name}' on a complex tensor is not yet supported`,
            span
          );
        }
        if (complexFold === undefined) {
          throw new UnsupportedConstruct(
            `'${name}' is not defined for complex scalars`,
            span
          );
        }
        const ax = exactScalarAsComplex(aN);
        const bx = exactScalarAsComplex(bN);
        if (ax !== undefined && bx !== undefined) {
          const v = complexFold(ax, bx);
          if (Number.isFinite(v.re) && Number.isFinite(v.im)) {
            return scalarComplex(v);
          }
        }
        return scalarComplex();
      }
      const resolved = elemwiseResultShape(aN, bN, name, span);

      if (resolved === null) {
        // Pure scalar op — fold if exact.
        const ax = exactDouble(aN);
        const bx = exactDouble(bN);
        if (ax !== undefined && bx !== undefined) {
          const v = fold(ax, bx);
          if (Number.isFinite(v)) return scalarDouble(signFromNumber(v), v);
        }
        return scalarDouble(signRule(aN, bN));
      }

      // Build the result NumericType (carries `shape` automatically when
      // every output dim is exact).
      const outTy = tensorDoubleFromDims(resolved.outDims);

      // Try to fold when every input is exact AND every output dim is
      // known (so the result fits the exact-array cap).
      const aArr = exactRealArray(aN);
      const bArr = exactRealArray(bN);
      const ax = exactDouble(aN);
      const bx = exactDouble(bN);
      const aIsExact = aArr !== undefined || ax !== undefined;
      const bIsExact = bArr !== undefined || bx !== undefined;
      if (
        aIsExact &&
        bIsExact &&
        outTy.shape !== undefined &&
        outTy.shape.reduce((p, q) => p * q, 1) <= EXACT_ARRAY_MAX_ELEMENTS
      ) {
        const outShape = outTy.shape;
        const n = outShape.reduce((p, q) => p * q, 1);
        const data = new Float64Array(n);
        // Per-axis broadcast strides for a and b (column-major). Stride
        // is 0 on any axis where the side has a singleton against a
        // non-singleton output axis (including ndim-pad axes).
        const rnd = outShape.length;
        const aShape: number[] = new Array(rnd);
        const bShape: number[] = new Array(rnd);
        for (let i = 0; i < rnd; i++) {
          const da = i < aN.dims.length ? aN.dims[i] : DIM_ONE;
          const db = i < bN.dims.length ? bN.dims[i] : DIM_ONE;
          aShape[i] = da.kind === "exact" ? da.value : 1;
          bShape[i] = db.kind === "exact" ? db.value : 1;
        }
        // If a was a bare scalar (aArr undefined, ax defined), treat its
        // shape as all-1 for the strider; the scalar value below is used
        // directly. Same for b.
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
        const ix = new Array(rnd).fill(0);
        for (let k = 0; k < n; k++) {
          let ai = 0;
          let bi = 0;
          for (let i = 0; i < rnd; i++) {
            ai += ix[i] * aStride[i];
            bi += ix[i] * bStride[i];
          }
          const av = aArr ? aArr[ai] : (ax as number);
          const bv = bArr ? bArr[bi] : (bx as number);
          data[k] = fold(av, bv);
          // column-major increment
          for (let i = 0; i < rnd; i++) {
            ix[i]++;
            if (ix[i] < outShape[i]) break;
            ix[i] = 0;
          }
        }
        // Reuse the constructor so shape/exact get validated and sign
        // is derived from the actual values.
        return tensorDouble(outShape, data);
      }
      outTy.sign = signRule(aN, bN);
      return outTy;
    },
    codegenC(argsC, argTypes) {
      const aN = argTypes[0] as NumericType;
      const bN = argTypes[1] as NumericType;
      const aMulti = isMultiElement(aN);
      const bMulti = isMultiElement(bN);
      if (!aMulti && !bMulti) {
        if (aN.isComplex || bN.isComplex) {
          if (complexScalarExpr === undefined) {
            throw new Error(
              `internal: '${name}' missing complexScalarExpr but reached complex codegen`
            );
          }
          return complexScalarExpr(argsC[0], argsC[1]);
        }
        return scalarExpr(argsC[0], argsC[1]);
      }
      if (aMulti && bMulti) {
        // Re-derive broadcast vs same-shape from the arg types. Identical
        // logic to `elemwiseResultShape`, but kept inline so codegen
        // can decide without threading state from `transfer`.
        const rnd = Math.max(aN.dims.length, bN.dims.length);
        let needsBcast = aN.dims.length !== bN.dims.length;
        if (!needsBcast) {
          for (let i = 0; i < rnd; i++) {
            const da = aN.dims[i];
            const db = bN.dims[i];
            const aOne = isDimOne(da);
            const bOne = isDimOne(db);
            if (aOne !== bOne) {
              needsBcast = true;
              break;
            }
          }
        }
        if (needsBcast) {
          return `mtoc2_tensor_${helperBase}_bcast_tt(${argsC[0]}, ${argsC[1]})`;
        }
        return `mtoc2_tensor_${helperBase}_tt(${argsC[0]}, ${argsC[1]})`;
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
    runtimeDeps: allDeps,
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

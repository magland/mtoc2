/**
 * Shared infrastructure for elementwise real binary builtins
 * (`plus`, `minus`, `times`, `rdivide`).
 */

import type { Span } from "../../../parser/index.js";
import { UnsupportedConstruct } from "../../errors.js";
import {
  type NumericType,
  type Sign,
  scalarDouble,
  tensorDouble,
  signFromNumber,
  flipSign,
  isMultiElement,
  EXACT_ARRAY_MAX_ELEMENTS,
} from "../../types.js";
import type { Builtin } from "../registry.js";
import { requireRealDouble, exactDouble, exactRealArray } from "../_shared.js";

/** Shape-compat check for elementwise binary. Same-shape only — broadcast
 *  beyond scalar-on-one-side stays a future slope. Returns the result
 *  shape (or `null` if both args are scalar — caller handles). Throws
 *  on incompatible shapes. */
function elemwiseResultShape(
  a: NumericType,
  b: NumericType,
  name: string,
  span: Span
): number[] | null {
  const aMulti = a.dims.some(d => d.kind !== "one");
  const bMulti = b.dims.some(d => d.kind !== "one");
  if (!aMulti && !bMulti) return null; // scalar OP scalar
  if (!aMulti) return b.shape ? b.shape.slice() : null;
  if (!bMulti) return a.shape ? a.shape.slice() : null;
  // both tensor — require identical statically-known shape
  if (!a.shape || !b.shape) {
    throw new UnsupportedConstruct(
      `'${name}' on tensors of unknown shape not yet supported`,
      span
    );
  }
  if (
    a.shape.length !== b.shape.length ||
    !a.shape.every((s, i) => s === b.shape![i])
  ) {
    throw new UnsupportedConstruct(
      `'${name}' shape mismatch (${a.shape.join("×")} vs ${b.shape.join("×")}); broadcast beyond scalar-on-one-side is not yet supported`,
      span
    );
  }
  return a.shape.slice();
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
 */
export function defineElemwiseRealBinary(
  name: string,
  cOp: string,
  helperBase: string,
  commutative: boolean,
  fold: (a: number, b: number) => number,
  signRule: (a: NumericType, b: NumericType) => Sign
): Builtin {
  return buildElemwiseRealBinary({
    name,
    helperBase,
    commutative,
    fold,
    signRule,
    scalarExpr: (a, b) => `(${a} ${cOp} ${b})`,
    runtimeDep: "mtoc2_tensor_elemwise_real",
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
}): Builtin {
  const {
    name,
    helperBase,
    commutative,
    fold,
    signRule,
    scalarExpr,
    runtimeDep,
  } = opts;
  return {
    name,
    arity: 2,
    transfer(argTypes, span) {
      const a = argTypes[0];
      const b = argTypes[1];
      requireRealDouble(a, `'${name}' arg 1`, span);
      requireRealDouble(b, `'${name}' arg 2`, span);
      const aN = a as NumericType;
      const bN = b as NumericType;
      const outShape = elemwiseResultShape(aN, bN, name, span);

      if (outShape === null) {
        // Pure scalar op — fold if exact.
        const ax = exactDouble(aN);
        const bx = exactDouble(bN);
        if (ax !== undefined && bx !== undefined) {
          const v = fold(ax, bx);
          if (Number.isFinite(v)) return scalarDouble(signFromNumber(v), v);
        }
        return scalarDouble(signRule(aN, bN));
      }

      // Tensor result. Try to fold when every input is exact.
      const aArr = exactRealArray(aN);
      const bArr = exactRealArray(bN);
      const ax = exactDouble(aN);
      const bx = exactDouble(bN);
      const aIsExact = aArr !== undefined || ax !== undefined;
      const bIsExact = bArr !== undefined || bx !== undefined;
      if (
        aIsExact &&
        bIsExact &&
        outShape.reduce((p, q) => p * q, 1) <= EXACT_ARRAY_MAX_ELEMENTS
      ) {
        const n = outShape.reduce((p, q) => p * q, 1);
        const data = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          const av = aArr ? aArr[i] : (ax as number);
          const bv = bArr ? bArr[i] : (bx as number);
          data[i] = fold(av, bv);
        }
        return tensorDouble(outShape, data);
      }
      return tensorDouble(outShape);
    },
    codegenC(argsC, argTypes) {
      const aMulti = isMultiElement(argTypes[0]);
      const bMulti = isMultiElement(argTypes[1]);
      if (!aMulti && !bMulti) {
        return scalarExpr(argsC[0], argsC[1]);
      }
      if (aMulti && bMulti) {
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
    runtimeDeps: [runtimeDep],
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
  const same = (x: Sign, y: Sign): boolean => x === y;
  if (same(a.sign, "zero") || same(b.sign, "zero")) return "zero";
  if (a.sign === "positive" && b.sign === "positive") return "positive";
  if (a.sign === "negative" && b.sign === "negative") return "positive";
  if (
    (a.sign === "positive" && b.sign === "negative") ||
    (a.sign === "negative" && b.sign === "positive")
  ) {
    return "negative";
  }
  return "unknown";
}

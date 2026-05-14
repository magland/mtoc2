/**
 * Builtin registry. Each builtin is a fused (transfer + codegenC) pair:
 *
 *   transfer(argTypes, span) — given input types, return the output
 *     type. When all inputs are exact, return a type whose `exact` is
 *     populated (the lowerer then emits a literal IR node instead of
 *     a call). transfer is the single source of truth for type rules
 *     AND compile-time evaluation for this builtin.
 *
 *   codegenC(argsC, argTypes) — return the C expression that evaluates
 *     this builtin at runtime. Not invoked when transfer returned an
 *     exact-tagged type (the lowerer short-circuits to a literal).
 *
 * MVP scope: scalar real double arithmetic, comparisons, disp.
 */

import type { Span } from "../parser/index.js";
import { BinaryOperation, UnaryOperation } from "../parser/index.js";
import { UnsupportedConstruct, TypeError } from "./errors.js";
import {
  type Type,
  type NumericType,
  type Sign,
  scalarDouble,
  scalarLogical,
  tensorDouble,
  signFromNumber,
  flipSign,
  isScalarRealDouble,
  isScalarRealNumeric,
  isMultiElement,
  isNumeric,
  isScalar,
  EXACT_ARRAY_MAX_ELEMENTS,
} from "./types.js";
export interface Builtin {
  /** Source-level name. */
  name: string;
  /** Arity (exact match for MVP). */
  arity: number;
  /** Transfer function: returns output type (with exact when fold-able). */
  transfer(argTypes: Type[], span: Span): Type;
  /** Emit C expression. The caller wraps it as a statement when needed. */
  codegenC(argsC: string[], argTypes: Type[]): string;
  /** Runtime-snippet names this builtin's codegenC output calls into.
   *  Registered names live in `src/codegen/runtime.ts`'s REGISTRY.
   *  The emitter activates each on every codegenC site so deps are
   *  pulled into the final output in topological order. */
  runtimeDeps?: ReadonlyArray<string>;
}

const REGISTRY = new Map<string, Builtin>();

export function registerBuiltin(b: Builtin): void {
  if (REGISTRY.has(b.name)) {
    throw new Error(`registerBuiltin: duplicate '${b.name}'`);
  }
  REGISTRY.set(b.name, b);
}

export function getBuiltin(name: string): Builtin | undefined {
  return REGISTRY.get(name);
}

/** Names of every registered builtin. Drives Monaco syntax highlighting. */
export function allBuiltinNames(): readonly string[] {
  return Array.from(REGISTRY.keys());
}

// ── Helpers ─────────────────────────────────────────────────────────────

function requireScalarRealDouble(t: Type, what: string, span: Span): void {
  if (!isScalarRealDouble(t)) {
    throw new TypeError(
      `${what} must be a scalar real double (got ${t.kind})`,
      span
    );
  }
}

function exactDouble(t: Type): number | undefined {
  if (!isNumeric(t)) return undefined;
  if (t.exact === undefined) return undefined;
  if (typeof t.exact === "number") return t.exact;
  return undefined;
}

// ── Arithmetic (real, elementwise) ──────────────────────────────────────

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

function exactRealArray(t: Type): Float64Array | undefined {
  if (!isNumeric(t)) return undefined;
  if (t.exact instanceof Float64Array) return t.exact;
  return undefined;
}

/** Define a real elementwise binary builtin: scalar, scalar+tensor,
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
function defineElemwiseRealBinary(
  name: string,
  cOp: string,
  helperBase: string,
  commutative: boolean,
  fold: (a: number, b: number) => number,
  signRule: (a: NumericType, b: NumericType) => Sign
): void {
  registerBuiltin({
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
        return `(${argsC[0]} ${cOp} ${argsC[1]})`;
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
    runtimeDeps: ["mtoc2_tensor_elemwise_real"],
  });
}

/** Like `requireScalarRealDouble` but accepts non-scalar real doubles
 *  (the elemwise path). Logical also accepted (stored as double in C). */
function requireRealDouble(t: Type, what: string, span: Span): void {
  if (!isNumeric(t) || t.isComplex) {
    throw new TypeError(`${what} must be a real numeric (got ${t.kind})`, span);
  }
  if (t.elem !== "double" && t.elem !== "logical") {
    throw new TypeError(
      `${what} must be double or logical (got ${t.elem})`,
      span
    );
  }
}

function signSum(a: NumericType, b: NumericType): Sign {
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

function signDiff(a: NumericType, b: NumericType): Sign {
  return signSum(a, { ...b, sign: flipSign(b.sign) });
}

function signProd(a: NumericType, b: NumericType): Sign {
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

defineElemwiseRealBinary("plus", "+", "plus", true, (a, b) => a + b, signSum);
defineElemwiseRealBinary(
  "minus",
  "-",
  "minus",
  false,
  (a, b) => a - b,
  signDiff
);
defineElemwiseRealBinary(
  "times",
  "*",
  "times",
  true,
  (a, b) => a * b,
  signProd
);
defineElemwiseRealBinary(
  "rdivide",
  "/",
  "rdivide",
  false,
  (a, b) => a / b,
  signProd
);

// `mtimes` / `mrdivide` (matrix * and /): mirror their elementwise
// siblings when at least one arg is scalar; reject the both-tensor
// case until matrix multiplication / division is implemented.
registerBuiltin({
  name: "mtimes",
  arity: 2,
  transfer(argTypes, span) {
    const a = argTypes[0];
    const b = argTypes[1];
    requireRealDouble(a, `'mtimes' arg 1`, span);
    requireRealDouble(b, `'mtimes' arg 2`, span);
    if (isMultiElement(a) && isMultiElement(b)) {
      throw new UnsupportedConstruct(
        `matrix multiplication (a*b on two tensors) is not yet supported; use '.*' for elementwise`,
        span
      );
    }
    return getBuiltin("times")!.transfer(argTypes, span);
  },
  codegenC(argsC, argTypes) {
    return getBuiltin("times")!.codegenC(argsC, argTypes);
  },
  runtimeDeps: ["mtoc2_tensor_elemwise_real"],
});

registerBuiltin({
  name: "mrdivide",
  arity: 2,
  transfer(argTypes, span) {
    const a = argTypes[0];
    const b = argTypes[1];
    requireRealDouble(a, `'mrdivide' arg 1`, span);
    requireRealDouble(b, `'mrdivide' arg 2`, span);
    if (isMultiElement(a) && isMultiElement(b)) {
      throw new UnsupportedConstruct(
        `matrix right-division (a/b on two tensors) is not yet supported; use './' for elementwise`,
        span
      );
    }
    return getBuiltin("rdivide")!.transfer(argTypes, span);
  },
  codegenC(argsC, argTypes) {
    return getBuiltin("rdivide")!.codegenC(argsC, argTypes);
  },
  runtimeDeps: ["mtoc2_tensor_elemwise_real"],
});

// ── Unary minus ─────────────────────────────────────────────────────────

registerBuiltin({
  name: "uminus",
  arity: 1,
  transfer(argTypes, span) {
    requireRealDouble(argTypes[0], `'uminus' arg`, span);
    const a = argTypes[0] as NumericType;
    if (isScalar(a)) {
      const ax = exactDouble(a);
      if (ax !== undefined) {
        const v = -ax;
        return scalarDouble(signFromNumber(v), v);
      }
      return scalarDouble(flipSign(a.sign));
    }
    // Tensor uminus: fold when exact, else runtime.
    const arr = exactRealArray(a);
    if (arr !== undefined && a.shape !== undefined) {
      const out = new Float64Array(arr.length);
      for (let i = 0; i < arr.length; i++) out[i] = -arr[i];
      return tensorDouble(a.shape, out);
    }
    if (a.shape === undefined) {
      throw new UnsupportedConstruct(
        `'uminus' on a tensor of unknown shape not yet supported`,
        span
      );
    }
    return tensorDouble(a.shape);
  },
  codegenC(argsC, argTypes) {
    if (isMultiElement(argTypes[0])) {
      return `mtoc2_tensor_uminus(${argsC[0]})`;
    }
    return `(-${argsC[0]})`;
  },
  runtimeDeps: ["mtoc2_tensor_elemwise_real"],
});

// ── Comparisons (return logical 0/1, emitted as double for MVP) ─────────

function defineCompare(
  name: string,
  cOp: string,
  fold: (a: number, b: number) => boolean
): void {
  registerBuiltin({
    name,
    arity: 2,
    transfer(argTypes, span) {
      requireScalarRealDouble(argTypes[0], `'${name}' arg 1`, span);
      requireScalarRealDouble(argTypes[1], `'${name}' arg 2`, span);
      const ax = exactDouble(argTypes[0]);
      const bx = exactDouble(argTypes[1]);
      if (ax !== undefined && bx !== undefined) {
        return scalarLogical(fold(ax, bx));
      }
      return scalarLogical();
    },
    codegenC(argsC) {
      return `((${argsC[0]} ${cOp} ${argsC[1]}) ? 1.0 : 0.0)`;
    },
  });
}

defineCompare("eq", "==", (a, b) => a === b);
defineCompare("ne", "!=", (a, b) => a !== b);
defineCompare("lt", "<", (a, b) => a < b);
defineCompare("le", "<=", (a, b) => a <= b);
defineCompare("gt", ">", (a, b) => a > b);
defineCompare("ge", ">=", (a, b) => a >= b);

// ── disp ────────────────────────────────────────────────────────────────

registerBuiltin({
  name: "disp",
  arity: 1,
  transfer(argTypes, span) {
    const t = argTypes[0];
    if (isScalarRealNumeric(t)) {
      // Scalar real (double or logical) — runtime call path.
      return { kind: "Unknown" };
    }
    if (
      isNumeric(t) &&
      !t.isComplex &&
      (t.elem === "double" || t.elem === "logical")
    ) {
      // Either an exact tensor (compile-time format) or a runtime
      // tensor with statically-known shape (mtoc2_disp_tensor call).
      return { kind: "Unknown" };
    }
    throw new TypeError(
      `'disp' arg must be a scalar real or a real tensor (got ${t.kind})`,
      span
    );
  },
  codegenC(argsC, argTypes) {
    const t = argTypes[0];
    if (isNumeric(t) && !isScalarRealNumeric(t)) {
      // Runtime tensor — call the runtime disp helper. The arg is
      // passed by value (struct copy of the pointers); disp_tensor
      // reads but doesn't take ownership. Lifetime stays with the
      // caller's local.
      return `mtoc2_disp_tensor(${argsC[0]})`;
    }
    // Scalar runtime path.
    return `mtoc2_disp_double(${argsC[0]})`;
  },
  runtimeDeps: ["mtoc2_disp_double", "mtoc2_disp_tensor"],
});

// ── length / numel / sum ────────────────────────────────────────────────

registerBuiltin({
  name: "length",
  arity: 1,
  transfer(argTypes, span) {
    const t = argTypes[0];
    if (!isNumeric(t)) {
      throw new TypeError(`'length' arg must be numeric (got ${t.kind})`, span);
    }
    if (t.shape === undefined) {
      throw new UnsupportedConstruct(
        `'length' on a tensor of unknown shape not yet supported`,
        span
      );
    }
    // MATLAB's `length`: max of the dim sizes, or 0 if any axis is 0.
    let v = 0;
    if (t.shape.some(s => s === 0)) v = 0;
    else v = t.shape.reduce((a, b) => Math.max(a, b), 0);
    return scalarDouble(signFromNumber(v), v);
  },
  codegenC(argsC, argTypes) {
    const t = argTypes[0];
    if (isNumeric(t) && isScalar(t)) {
      // length of a scalar is 1 — the C arg is a bare `double`, not a
      // tensor, so the runtime helper doesn't apply.
      return `1.0`;
    }
    return `mtoc2_length(${argsC[0]})`;
  },
  runtimeDeps: ["mtoc2_length"],
});

registerBuiltin({
  name: "numel",
  arity: 1,
  transfer(argTypes, span) {
    const t = argTypes[0];
    if (!isNumeric(t)) {
      throw new TypeError(`'numel' arg must be numeric (got ${t.kind})`, span);
    }
    if (t.shape === undefined) {
      throw new UnsupportedConstruct(
        `'numel' on a tensor of unknown shape not yet supported`,
        span
      );
    }
    const v = t.shape.reduce((a, b) => a * b, 1);
    return scalarDouble(signFromNumber(v), v);
  },
  codegenC(argsC, argTypes) {
    const t = argTypes[0];
    if (isNumeric(t) && isScalar(t)) {
      return `1.0`;
    }
    return `mtoc2_numel(${argsC[0]})`;
  },
  runtimeDeps: ["mtoc2_numel"],
});

registerBuiltin({
  name: "sum",
  arity: 1,
  transfer(argTypes, span) {
    const t = argTypes[0];
    if (!isNumeric(t) || t.isComplex) {
      throw new TypeError(
        `'sum' arg must be a real numeric (got ${t.kind})`,
        span
      );
    }
    // Scalar input: sum is the identity.
    if (isScalar(t)) {
      if (typeof t.exact === "number") {
        return scalarDouble(signFromNumber(t.exact), t.exact);
      }
      return scalarDouble(t.sign);
    }
    // Tensor input. MATLAB's `sum` of a vector (1×N or N×1) returns a
    // scalar; of a matrix it sums each column, returning a row. We
    // handle the vector case for now (compile-time fold when exact;
    // mtoc2_sum at runtime otherwise) and reject the matrix case.
    if (t.shape === undefined) {
      throw new UnsupportedConstruct(
        `'sum' on a tensor of unknown shape not yet supported`,
        span
      );
    }
    const isVector =
      t.shape.length === 2 && (t.shape[0] === 1 || t.shape[1] === 1);
    if (!isVector) {
      throw new UnsupportedConstruct(
        `'sum' on a non-vector tensor (matrix → row-vector reduction) is not yet supported`,
        span
      );
    }
    if (t.exact instanceof Float64Array) {
      let acc = 0;
      for (let i = 0; i < t.exact.length; i++) acc += t.exact[i];
      return scalarDouble(signFromNumber(acc), acc);
    }
    return scalarDouble("unknown");
  },
  codegenC(argsC, argTypes) {
    const t = argTypes[0];
    if (!isNumeric(t) || isScalar(t)) {
      // Scalar fall-through (sum(x) === x). Should have folded; if it
      // reaches codegen the input had no exact, so emit identity.
      return argsC[0];
    }
    return `mtoc2_sum(${argsC[0]})`;
  },
  runtimeDeps: ["mtoc2_sum"],
});

// ── Operator-to-builtin map ─────────────────────────────────────────────

export function binaryOpBuiltin(op: BinaryOperation): string {
  switch (op) {
    case BinaryOperation.Add:
      return "plus";
    case BinaryOperation.Sub:
      return "minus";
    case BinaryOperation.Mul:
      return "mtimes";
    case BinaryOperation.ElemMul:
      return "times";
    case BinaryOperation.Div:
      return "mrdivide";
    case BinaryOperation.ElemDiv:
      return "rdivide";
    case BinaryOperation.Equal:
      return "eq";
    case BinaryOperation.NotEqual:
      return "ne";
    case BinaryOperation.Less:
      return "lt";
    case BinaryOperation.LessEqual:
      return "le";
    case BinaryOperation.Greater:
      return "gt";
    case BinaryOperation.GreaterEqual:
      return "ge";
    default:
      throw new Error(`binaryOpBuiltin: unmapped op ${op}`);
  }
}

export function unaryOpBuiltin(op: UnaryOperation): string {
  switch (op) {
    case UnaryOperation.Minus:
      return "uminus";
    case UnaryOperation.Plus:
      return "uplus";
    default:
      throw new Error(`unaryOpBuiltin: unmapped op ${op}`);
  }
}

export function isOpBuiltinSupported(name: string, span: Span): void {
  if (!REGISTRY.has(name)) {
    throw new UnsupportedConstruct(`builtin '${name}' not supported`, span);
  }
}

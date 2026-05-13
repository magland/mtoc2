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
  signFromNumber,
  flipSign,
  isScalarRealDouble,
  isNumeric,
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

// ── Arithmetic (real scalar) ────────────────────────────────────────────

function defineRealBinary(
  name: string,
  cOp: string,
  fold: (a: number, b: number) => number,
  signRule: (a: NumericType, b: NumericType) => Sign
): void {
  registerBuiltin({
    name,
    arity: 2,
    transfer(argTypes, span) {
      requireScalarRealDouble(argTypes[0], `'${name}' arg 1`, span);
      requireScalarRealDouble(argTypes[1], `'${name}' arg 2`, span);
      const a = argTypes[0] as NumericType;
      const b = argTypes[1] as NumericType;
      const ax = exactDouble(a);
      const bx = exactDouble(b);
      if (ax !== undefined && bx !== undefined) {
        const v = fold(ax, bx);
        if (Number.isFinite(v)) return scalarDouble(signFromNumber(v), v);
      }
      return scalarDouble(signRule(a, b));
    },
    codegenC(argsC) {
      return `(${argsC[0]} ${cOp} ${argsC[1]})`;
    },
  });
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

defineRealBinary("plus", "+", (a, b) => a + b, signSum);
defineRealBinary("minus", "-", (a, b) => a - b, signDiff);
defineRealBinary("times", "*", (a, b) => a * b, signProd);
defineRealBinary("rdivide", "/", (a, b) => a / b, signProd);

// ── Unary minus ─────────────────────────────────────────────────────────

registerBuiltin({
  name: "uminus",
  arity: 1,
  transfer(argTypes, span) {
    requireScalarRealDouble(argTypes[0], `'uminus' arg`, span);
    const a = argTypes[0] as NumericType;
    const ax = exactDouble(a);
    if (ax !== undefined) {
      const v = -ax;
      return scalarDouble(signFromNumber(v), v);
    }
    return scalarDouble(flipSign(a.sign));
  },
  codegenC(argsC) {
    return `(-${argsC[0]})`;
  },
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
    requireScalarRealDouble(argTypes[0], `'disp' arg`, span);
    // disp returns void in MATLAB; we model this as Unknown which the
    // ExprStmt path discards.
    return { kind: "Unknown" };
  },
  codegenC(argsC) {
    return `mtoc2_disp_double(${argsC[0]})`;
  },
  runtimeDeps: ["mtoc2_disp_double"],
});

// ── Operator-to-builtin map ─────────────────────────────────────────────

export function binaryOpBuiltin(op: BinaryOperation): string {
  switch (op) {
    case BinaryOperation.Add:
      return "plus";
    case BinaryOperation.Sub:
      return "minus";
    case BinaryOperation.Mul:
    case BinaryOperation.ElemMul:
      return "times";
    case BinaryOperation.Div:
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

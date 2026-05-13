/**
 * mtoc2 intermediate representation. Built from scratch; only what the
 * MVP scope needs (scalar real double, arith + comparisons, disp,
 * if/while/for, user functions with specialization).
 *
 * Every node carries a `Span` for error attribution. Every IRExpr
 * carries a `Type`.
 */

import type { Span } from "../parser/index.js";
import type { Type } from "./types.js";
import { BinaryOperation, UnaryOperation } from "../parser/index.js";

// ── Expressions ─────────────────────────────────────────────────────────

export interface NumLit {
  kind: "NumLit";
  value: number;
  ty: Type;
  span: Span;
}

/** Compile-time-known tensor literal. Carries the column-major flat
 *  data + shape. Slope-1 model: these never materialize as runtime C
 *  values; tensor-aware builtins (disp, sum, length, ...) read the
 *  data from `ty.exact` at codegen time and emit the result directly.
 *  When emitExpr walks past a TensorLit (e.g. as a Call arg whose
 *  builtin handles the tensor case via argTypes), it emits a harmless
 *  placeholder. */
export interface TensorLit {
  kind: "TensorLit";
  /** Column-major flat data, same layout as numbl's RuntimeTensor.data. */
  data: Float64Array;
  /** Statically-known integer shape (length matches ty.dims). */
  shape: number[];
  ty: Type;
  span: Span;
}

export interface Var {
  kind: "Var";
  /** Source name (for diagnostics). */
  name: string;
  /** Allocated C identifier. Each SSA-like assignment gets a fresh one. */
  cName: string;
  ty: Type;
  span: Span;
}

export interface Binary {
  kind: "Binary";
  /** Builtin name (e.g. "plus", "minus"). */
  builtin: string;
  op: BinaryOperation;
  left: IRExpr;
  right: IRExpr;
  ty: Type;
  span: Span;
}

export interface Unary {
  kind: "Unary";
  builtin: string;
  op: UnaryOperation;
  operand: IRExpr;
  ty: Type;
  span: Span;
}

export interface Call {
  kind: "Call";
  /** Resolved name. For user functions this is the mangled name. */
  cName: string;
  /** Source-level name (for diagnostics). */
  name: string;
  args: IRExpr[];
  ty: Type;
  span: Span;
}

export type IRExpr = NumLit | TensorLit | Var | Binary | Unary | Call;

// ── Statements ──────────────────────────────────────────────────────────

export interface ExprStmt {
  kind: "ExprStmt";
  expr: IRExpr;
  span: Span;
}

export interface Assign {
  kind: "Assign";
  /** Source name. */
  name: string;
  /** Fresh C name allocated for this assignment. */
  cName: string;
  /** True if the variable is newly introduced (emit `double x = ...;`)
   *  rather than reassigned (emit `x = ...;`). */
  declare: boolean;
  ty: Type;
  expr: IRExpr;
  span: Span;
}

export interface If {
  kind: "If";
  cond: IRExpr;
  thenBody: IRStmt[];
  elseBody: IRStmt[];
  span: Span;
}

export interface While {
  kind: "While";
  cond: IRExpr;
  body: IRStmt[];
  span: Span;
}

export interface For {
  kind: "For";
  /** Source name of loop variable. */
  varName: string;
  /** Allocated C name for the loop variable. */
  cVar: string;
  start: IRExpr;
  /** Literal numeric step. */
  step: number;
  end: IRExpr;
  body: IRStmt[];
  span: Span;
}

export interface ReturnFromFunction {
  kind: "ReturnFromFunction";
  span: Span;
}

export interface Break {
  kind: "Break";
  span: Span;
}

export interface Continue {
  kind: "Continue";
  span: Span;
}

export type IRStmt =
  | ExprStmt
  | Assign
  | If
  | While
  | For
  | ReturnFromFunction
  | Break
  | Continue;

// ── Functions ───────────────────────────────────────────────────────────

export interface IRFunc {
  /** Source-level function name. */
  name: string;
  /** Mangled C identifier (name__<8-hex>). */
  cName: string;
  /** Parameter source names. */
  params: string[];
  /** Parameter C names (parallel to `params`). */
  cParams: string[];
  /** Per-parameter type at this specialization. */
  paramTypes: Type[];
  /** Source output names (single output for MVP). */
  outputs: string[];
  /** C names for outputs. */
  cOutputs: string[];
  /** Output types after lowering. */
  outputTypes: Type[];
  body: IRStmt[];
  span: Span;
}

// ── Program ─────────────────────────────────────────────────────────────

export interface IRProgram {
  /** Script-level top-level statements. */
  topLevelStmts: IRStmt[];
  /** All specialized function definitions, keyed by their mangled cName. */
  functions: Map<string, IRFunc>;
}

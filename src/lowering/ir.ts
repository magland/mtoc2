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

/** Runtime tensor construction for every tensor source-literal. Codegen
 *  emits `mtoc2_tensor_from_row` (1×N) or `mtoc2_tensor_from_matrix`
 *  (rows×cols) with a C99 compound literal of the per-element
 *  expressions. The shape is statically known; the element values may
 *  be any IR expressions (NumLit for literal cells, Var/Binary/... for
 *  computed cells).
 *
 *  `elements` is column-major and length-matches `shape`. */
export interface TensorBuild {
  kind: "TensorBuild";
  elements: IRExpr[];
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

export type IRExpr = NumLit | TensorBuild | Var | Binary | Unary | Call;

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
  /** True if the variable is newly introduced AND will emit a C-side
   *  declaration (i.e. `double x = ...;` for scalars). For tensors,
   *  declarations are hoisted to function top by the emitter and
   *  every Assign uses the assign helper, so this flag is ignored
   *  for owned types. */
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

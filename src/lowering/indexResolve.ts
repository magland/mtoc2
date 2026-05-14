/**
 * Shared validation helper + slice-arg predicate for the four index
 * lowering helpers (lowerIndexLoad / lowerIndexStore / lowerIndexSlice
 * / lowerIndexSliceStore).
 *
 * `isSliceArg` lets the dispatchers in `lower.ts` choose between the
 * scalar and slice paths without each call site re-discriminating on
 * `Expr` kinds.
 *
 * `resolveIndexBase` performs the common preamble shared by all four
 * helpers: env lookup, numeric/multi-element check, arity check,
 * builds the base `Var` IR node.
 *
 * Adapted from mtoc's `src/lowering/indexResolve.ts`, with the
 * char-tensor / complex / scalar-base branches dropped — mtoc2 v1
 * only indexes real-double multi-element tensors.
 */

import type { Expr, Span } from "../parser/index.js";
import { TypeError, UnsupportedConstruct } from "./errors.js";
import type { IRExpr } from "./ir.js";
import {
  isMultiElement,
  isNumeric,
  isScalar,
  type NumericType,
  typeToString,
} from "./types.js";
import type { Lowerer } from "./lower.js";

/** Operation label that selects operation-specific message text. */
export type IndexOperation = "read" | "write" | "sliceRead" | "sliceWrite";

/** True when an AST expression node is a range or bare colon — the
 *  dispatcher uses this predicate to decide between scalar (IndexLoad /
 *  IndexStore) and slice (IndexSlice / IndexSliceStore) paths. */
export function isSliceArg(a: Expr): boolean {
  return a.type === "Range" || a.type === "Colon";
}

interface ResolveOptions {
  /** Span of the base identifier node — used for the Var IR node and
   *  the "not in scope" diagnostic. Defaults to the outer index span. */
  baseSpan?: Span;
  /** "internal" when the dispatcher already verified the binding exists
   *  (a missing one would be a lowerer bug); "user-facing" when the
   *  caller is a statement-level dispatcher and the variable may
   *  genuinely be undefined. */
  notInScope: "internal" | "user-facing";
  operation: IndexOperation;
}

/** Validate and resolve the base variable for an index operation. */
export function resolveIndexBase(
  this: Lowerer,
  name: string,
  argCount: number,
  span: Span,
  opts: ResolveOptions
): {
  baseTy: NumericType;
  baseCName: string;
  base: Extract<IRExpr, { kind: "Var" }>;
} {
  const { baseSpan = span, notInScope, operation } = opts;

  const looked = this.envLookup(name);
  if (looked === undefined) {
    if (notInScope === "internal") {
      const fn = operation === "read" ? "lowerIndexLoad" : "lowerIndexSlice";
      throw new UnsupportedConstruct(
        `internal: ${fn} called for '${name}' which is not in scope`,
        span
      );
    }
    throw new TypeError(`use of undefined variable '${name}'`, baseSpan);
  }

  if (!isNumeric(looked.ty)) {
    throw new UnsupportedConstruct(
      `${opPrefix(operation)} into ${typeToString(looked.ty)} is not yet supported`,
      span
    );
  }

  // The "read" path emits a dedicated "scalar variable" message before
  // the generic multi-element check so the diagnostic names the variable.
  if (operation === "read" && isScalar(looked.ty)) {
    throw new UnsupportedConstruct(
      `indexing into a scalar variable '${name}' is not yet supported`,
      span
    );
  }

  if (!isMultiElement(looked.ty)) {
    throw new UnsupportedConstruct(
      notMultiElementMsg(operation, name, looked.ty),
      span
    );
  }

  // v1 limit: real-double only. Logical / complex / char tensors are
  // not yet a thing — when they land, expand here.
  if (looked.ty.isComplex || looked.ty.elem !== "double") {
    throw new UnsupportedConstruct(
      `${opPrefix(operation)} into ${typeToString(looked.ty)} is not yet supported`,
      span
    );
  }

  const ndim = looked.ty.dims.length;

  if (argCount === 0 && (operation === "read" || operation === "write")) {
    const msg =
      operation === "read"
        ? `indexing '${name}' requires at least one index`
        : `indexed write requires at least one index`;
    throw new UnsupportedConstruct(msg, span);
  }

  if (argCount !== 1 && argCount !== ndim) {
    throw new UnsupportedConstruct(arityMsg(operation, argCount, ndim), span);
  }

  const baseCName = looked.cName;
  const base: Extract<IRExpr, { kind: "Var" }> = {
    kind: "Var",
    name,
    cName: baseCName,
    ty: looked.ty,
    span: baseSpan,
  };
  return { baseTy: looked.ty, baseCName, base };
}

// ── Message helpers ─────────────────────────────────────────────────────

function opPrefix(op: IndexOperation): string {
  switch (op) {
    case "read":
      return "indexing";
    case "write":
      return "indexed write";
    case "sliceRead":
      return "range/colon indexing";
    case "sliceWrite":
      return "range/colon indexed write";
  }
}

function notMultiElementMsg(
  op: IndexOperation,
  name: string,
  baseTy: NumericType
): string {
  switch (op) {
    case "read":
      return `cannot index variable '${name}' with type ${typeToString(baseTy)}`;
    case "write":
      return `indexed write requires a multi-element tensor (got ${typeToString(baseTy)})`;
    case "sliceRead":
      return `range/colon indexing requires a multi-element tensor (got ${typeToString(baseTy)})`;
    case "sliceWrite":
      return `range/colon indexed write requires a multi-element tensor (got ${typeToString(baseTy)})`;
  }
}

function arityMsg(op: IndexOperation, argCount: number, ndim: number): string {
  switch (op) {
    case "read":
      return (
        `${argCount}-index access into a ${ndim}-D tensor is not yet ` +
        `supported (use 1 linear index or ${ndim} per-axis indices)`
      );
    case "write":
      return (
        `${argCount}-index write into a ${ndim}-D tensor is ` +
        `not yet supported (use 1 linear index or ${ndim} per-axis indices)`
      );
    case "sliceRead":
      return (
        `range/colon indexing of a ${ndim}-D tensor requires either 1 slot ` +
        `(linear) or ${ndim} slots (one per axis); got ${argCount}`
      );
    case "sliceWrite":
      return (
        `range/colon indexed write into a ${ndim}-D tensor requires either 1 ` +
        `slot (linear) or ${ndim} slots (one per axis); got ${argCount}`
      );
  }
}

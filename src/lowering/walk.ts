/**
 * IR walking helpers — read-only traversal of expression trees and
 * the top-level expressions inside a statement. Used by the liveness
 * analyzer (and any future IR-walking pass) to enumerate sub-
 * expressions without each call site re-discriminating on `IRExpr`
 * kinds.
 */

import type { IRExpr, IRStmt } from "./ir.js";

/** Visit every sub-expression of `e`, including `e` itself. Walks
 *  pre-order: the outer node is visited first, then children. Pure
 *  read-only — `visit` should not mutate the IR. */
export function forEachSubExpr(e: IRExpr, visit: (sub: IRExpr) => void): void {
  visit(e);
  switch (e.kind) {
    case "NumLit":
    case "Var":
      return;
    case "TensorBuild":
      for (const el of e.elements) forEachSubExpr(el, visit);
      return;
    case "Binary":
      forEachSubExpr(e.left, visit);
      forEachSubExpr(e.right, visit);
      return;
    case "Unary":
      forEachSubExpr(e.operand, visit);
      return;
    case "Call":
      for (const a of e.args) forEachSubExpr(a, visit);
      return;
    case "HandleLit":
      for (const c of e.captures) forEachSubExpr(c.value, visit);
      return;
    case "HandleCaptureLoad":
      forEachSubExpr(e.base, visit);
      return;
  }
}

/** Visit every top-level expression in `s` (the expressions that
 *  live directly under the statement node — NOT recursing into
 *  nested control-flow bodies). The visitor can then call
 *  `forEachSubExpr` to walk into each. */
export function forEachTopLevelExpr(
  s: IRStmt,
  visit: (e: IRExpr) => void
): void {
  switch (s.kind) {
    case "ExprStmt":
      visit(s.expr);
      return;
    case "Assign":
      visit(s.expr);
      return;
    case "If":
      visit(s.cond);
      return;
    case "While":
      visit(s.cond);
      return;
    case "For":
      visit(s.start);
      visit(s.end);
      return;
    case "ReturnFromFunction":
    case "Break":
    case "Continue":
    case "TypeComment":
      return;
  }
}

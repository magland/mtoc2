/**
 * Scalar index-read lowering: `v(i)` / `M(i, j)` / `T(i, j, k)` /
 * `v(end)` / `M(end, end)` / etc.
 *
 * Reached from `lowerFuncCall` whenever a `FuncCall` name resolves to
 * an in-scope multi-element numeric variable AND none of the args are
 * a range / bare colon (that case routes to `lowerIndexSlice`). Each
 * index slot must lower to a scalar real expression; an `end` token
 * inside a slot resolves through the Lowerer's `endStack` to the
 * appropriate axis size.
 */

import type { Expr, Span } from "../parser/index.js";
import { TypeError } from "./errors.js";
import type { IRExpr } from "./ir.js";
import { isScalarRealNumeric, scalarDouble, typeToString } from "./types.js";
import type { Lowerer } from "./lower.js";
import { resolveIndexBase } from "./indexResolve.js";

/** Lower an index-read of an in-scope variable. */
export function lowerIndexLoad(
  this: Lowerer,
  name: string,
  argExprs: ReadonlyArray<Expr>,
  span: Span
): IRExpr {
  const { baseTy, baseCName, base } = resolveIndexBase.call(
    this,
    name,
    argExprs.length,
    span,
    { notInScope: "internal", operation: "read" }
  );

  const indices: IRExpr[] = [];
  const numSlots = argExprs.length;
  for (let slot = 0; slot < numSlots; slot++) {
    const axis: number | "linear" = numSlots === 1 ? "linear" : slot;
    this.endStack.push({ baseCName, baseTy, axis });
    let lowered: IRExpr;
    try {
      lowered = this.lowerExpr(argExprs[slot]);
    } finally {
      this.endStack.pop();
    }
    if (!isScalarRealNumeric(lowered.ty)) {
      throw new TypeError(
        `index ${slot + 1} of '${name}' must be a real scalar ` +
          `(got ${typeToString(lowered.ty)})`,
        argExprs[slot].span
      );
    }
    indices.push(lowered);
  }

  return {
    kind: "IndexLoad",
    base,
    indices,
    ty: scalarDouble("unknown"),
    span,
  };
}

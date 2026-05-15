/**
 * Range / colon / scalar-mix indexed-write lowering: `v(:) = w`,
 * `v(a:b) = w`, `M(:, j) = w`, `T(:, :, i) = w`, … .
 *
 * Companion to `lowerIndexSlice` for slice writes. RHS shape:
 *   - scalar real numeric → broadcast into every slot.
 *   - named multi-element tensor (`Var`) → per-slot copy.
 *
 * Other RHS forms (a fresh `TensorBuild`, an `IndexSlice`, a tensor
 * Binary, etc.) are rejected with a clear message — the user must
 * assign the expression to a name first so the temporary lifetime is
 * explicit.
 */

import type { Expr, LValue, Span } from "../parser/index.js";
import { TypeError, UnsupportedConstruct } from "./errors.js";
import type { IRStmt, IndexSliceArg } from "./ir.js";
import { isMultiElement, isNumeric, typeToString } from "./types.js";
import type { Lowerer } from "./lower.js";
import { lowerSliceArg } from "./lowerIndexSlice.js";
import { resolveIndexBase } from "./indexResolve.js";

export function lowerIndexSliceStore(
  this: Lowerer,
  lvalue: Extract<LValue, { type: "Index" }>,
  exprAst: Expr,
  span: Span
): IRStmt | IRStmt[] {
  if (lvalue.base.type !== "Ident") {
    throw new UnsupportedConstruct(
      `indexed assignment requires a simple variable on the left ` +
        `(got ${lvalue.base.type})`,
      span
    );
  }
  const name = lvalue.base.name;
  const r = resolveIndexBase.call(this, name, lvalue.indices.length, span, {
    baseSpan: lvalue.base.span,
    notInScope: "user-facing",
    operation: "sliceWrite",
  });

  const isSingleSlot = lvalue.indices.length === 1;
  const slotHoists: IRStmt[] = [];
  const slots: IndexSliceArg[] = [];
  for (let i = 0; i < lvalue.indices.length; i++) {
    const axis: number | "linear" = isSingleSlot ? "linear" : i;
    const slot = lowerSliceArg.call(
      this,
      r.baseCName,
      r.baseTy,
      axis,
      lvalue.indices[i]
    );
    // The LogicalMask slot's expr is consumed at emit time as a Var
    // (codegen reads `.real[i]` / `.dims[k]` off it). ANF it here so a
    // non-Var producer (e.g. a Unary `~` directly in the slot) lands in
    // a named temp before the IndexSliceStore is emitted.
    if (slot.kind === "LogicalMask") {
      slots.push({
        ...slot,
        expr: this.anfRequireScalarOrVar(slot.expr, slotHoists),
      });
    } else {
      slots.push(slot);
    }
  }
  // Per-axis logical-mask writes (e.g. `M(:, mask) = rhs`) aren't yet
  // supported; only single-slot linear `a(mask) = rhs` is handled.
  if (!isSingleSlot) {
    for (const slot of slots) {
      if (slot.kind === "LogicalMask") {
        throw new UnsupportedConstruct(
          `per-axis logical-mask writes are not yet supported; only ` +
            `linear-form 'a(mask) = rhs' is handled`,
          slot.span
        );
      }
    }
  }

  const rawRhs = this.lowerExpr(exprAst);
  if (!isNumeric(rawRhs.ty)) {
    throw new TypeError(
      `right-hand side of an indexed assignment must be numeric ` +
        `(got ${typeToString(rawRhs.ty)})`,
      exprAst.span
    );
  }
  if (rawRhs.ty.elem !== "double") {
    throw new UnsupportedConstruct(
      `right-hand side of a range/colon indexed write must be a double ` +
        `(got ${typeToString(rawRhs.ty)})`,
      exprAst.span
    );
  }
  if (!r.baseTy.isComplex && rawRhs.ty.isComplex) {
    throw new TypeError(
      `cannot store a complex RHS into a real-typed tensor '${name}' ` +
        `(would silently drop the imaginary part). Promote the base to ` +
        `complex first (e.g. via 'x = x + 0i' before the indexed write).`,
      exprAst.span
    );
  }

  // Codegen accepts only a scalar (broadcast) or a Var (per-slot copy)
  // as RHS. Scalars pass through; multi-element non-Var RHSs (a
  // TensorBuild, an IndexSlice, a MakeRange, a tensor-returning Call,
  // a tensor Binary) hoist to a fresh `_mtoc2_t<N>` temp Assign so the
  // temporary's lifetime is named and the codegen pipeline stays
  // uniform. Same ANF rule used by every other owned consume site.
  const hoists: IRStmt[] = [];
  let rhs: typeof rawRhs;
  const rhsIsScalar =
    isNumeric(rawRhs.ty) &&
    rawRhs.ty.dims.every(d => d.kind === "exact" && d.value === 1);
  if (rhsIsScalar) {
    rhs = rawRhs;
  } else if (isMultiElement(rawRhs.ty)) {
    rhs = this.anfRequireScalarOrVar(rawRhs, hoists);
  } else {
    throw new TypeError(
      `right-hand side of a range/colon indexed write must be a scalar ` +
        `or a tensor (got ${typeToString(rawRhs.ty)})`,
      exprAst.span
    );
  }

  const store: IRStmt = {
    kind: "IndexSliceStore",
    base: r.base,
    index: slots,
    rhs,
    span,
  };
  const allHoists = [...slotHoists, ...hoists];
  if (allHoists.length === 0) return store;
  return [...allHoists, store];
}

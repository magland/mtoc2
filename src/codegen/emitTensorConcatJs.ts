/**
 * JS sibling of `emitTensorConcat.ts`. Same two-path structure
 * (fully-static vs. runtime-dim), same per-cell rectangle-copy
 * shape — only the language and field names differ:
 *   `.real` (C)  → `.data` (JS)
 *   `.dims[k]` (C) → `.shape[k]` (JS)
 *
 * GCC statement-expressions don't exist in JS; the destination
 * tensor and per-cell writes are wrapped in an IIFE that returns
 * the result.
 */

import type { IRExpr } from "../lowering/ir.js";
import { isScalar } from "../lowering/types.js";
import { useRuntimeByName, type RuntimeState } from "./runtime.js";

export function emitTensorConcatJs(
  e: Extract<IRExpr, { kind: "TensorConcat" }>,
  state: RuntimeState,
  emit: (e: IRExpr, state: RuntimeState) => string
): string {
  useRuntimeByName(state, "mtoc2_tensor_alloc_nd");

  const allStatic =
    e.shape.every(s => s !== null) &&
    e.rowHeights.every(h => h !== null) &&
    e.cellCols.every(row => row.every(c => c !== null));
  if (allStatic) {
    return emitTensorConcatJsStatic(
      e.cells,
      e.shape as number[],
      e.rowHeights as number[],
      e.cellCols as number[][],
      state,
      emit
    );
  }
  return emitTensorConcatJsDynamic(e, state, emit);
}

function emitTensorConcatJsStatic(
  cells: IRExpr[][],
  shape: number[],
  rowHeights: number[],
  cellCols: number[][],
  state: RuntimeState,
  emit: (e: IRExpr, state: RuntimeState) => string
): string {
  const [totalRows] = shape;
  const lines: string[] = [];
  lines.push(
    `const _mtoc2_t = mtoc2_tensor_alloc_nd(2, [${totalRows}, ${shape[1]}]);`
  );

  let rowOff = 0;
  for (let i = 0; i < cells.length; i++) {
    const row = cells[i];
    const cellRows = rowHeights[i];
    let colOff = 0;
    for (let j = 0; j < row.length; j++) {
      const cell = row[j];
      const cellColsHere = cellCols[i][j];
      const cellStr = emit(cell, state);

      if (cellRows === 1 && cellColsHere === 1) {
        const dstIdx = `${rowOff} + ${colOff} * ${totalRows}`;
        lines.push(`_mtoc2_t.data[${dstIdx}] = ${cellStr};`);
      } else {
        lines.push(
          `for (let _mtoc2_sc = 0; _mtoc2_sc < ${cellColsHere}; _mtoc2_sc++) {`
        );
        lines.push(
          `  for (let _mtoc2_sr = 0; _mtoc2_sr < ${cellRows}; _mtoc2_sr++) {`
        );
        const dstIdx = `(${rowOff} + _mtoc2_sr) + (${colOff} + _mtoc2_sc) * ${totalRows}`;
        const srcIdx = `_mtoc2_sr + _mtoc2_sc * ${cellRows}`;
        lines.push(
          `    _mtoc2_t.data[${dstIdx}] = ${cellStr}.data[${srcIdx}];`
        );
        lines.push(`  }`);
        lines.push(`}`);
      }
      colOff += cellColsHere;
    }
    rowOff += cellRows;
  }
  lines.push(`return _mtoc2_t;`);
  return `(() => { ${lines.join(" ")} })()`;
}

function emitTensorConcatJsDynamic(
  e: Extract<IRExpr, { kind: "TensorConcat" }>,
  state: RuntimeState,
  emit: (e: IRExpr, state: RuntimeState) => string
): string {
  const lines: string[] = [];
  const cellStrs: string[][] = e.cells.map(row => row.map(c => emit(c, state)));
  const cellRowsExpr = (i: number, j: number): string => {
    const c = e.cells[i][j];
    if (c.ty.kind !== "Numeric") return "1";
    if (c.ty.dims.length === 0 || isScalar(c.ty)) return "1";
    const r = e.rowHeights[i];
    if (r !== null) return `${r}`;
    return `${cellStrs[i][j]}.shape[0]`;
  };
  const cellColsExpr = (i: number, j: number): string => {
    const c = e.cells[i][j];
    if (c.ty.kind !== "Numeric") return "1";
    if (c.ty.dims.length === 0 || isScalar(c.ty)) return "1";
    const k = e.cellCols[i][j];
    if (k !== null) return `${k}`;
    return `${cellStrs[i][j]}.shape[1]`;
  };
  const rhLocals: string[] = [];
  for (let i = 0; i < e.cells.length; i++) {
    const name = `_mtoc2_rh_${i}`;
    rhLocals.push(name);
    lines.push(`const ${name} = ${cellRowsExpr(i, 0)};`);
  }
  const trExpr = e.shape[0] !== null ? `${e.shape[0]}` : rhLocals.join(" + ");
  lines.push(`const _mtoc2_tr = ${trExpr};`);
  const widthExpr = (() => {
    if (e.shape[1] !== null) return `${e.shape[1]}`;
    if (e.cells.length === 0) return "0";
    return e.cells[0].map((_, j) => cellColsExpr(0, j)).join(" + ");
  })();
  lines.push(`const _mtoc2_tc = ${widthExpr};`);
  lines.push(
    `const _mtoc2_t = mtoc2_tensor_alloc_nd(2, [_mtoc2_tr, _mtoc2_tc]);`
  );

  lines.push(`let _mtoc2_row_off = 0;`);
  for (let i = 0; i < e.cells.length; i++) {
    const row = e.cells[i];
    lines.push(`let _mtoc2_col_off_${i} = 0;`);
    for (let j = 0; j < row.length; j++) {
      const cell = row[j];
      const cellStr = cellStrs[i][j];
      const rowsHere = cellRowsExpr(i, j);
      const colsHere = cellColsExpr(i, j);
      const isScalarCell =
        cell.ty.kind === "Numeric" &&
        (cell.ty.dims.length === 0 || isScalar(cell.ty));
      if (isScalarCell) {
        const dstIdx = `_mtoc2_row_off + _mtoc2_col_off_${i} * _mtoc2_tr`;
        lines.push(`_mtoc2_t.data[${dstIdx}] = ${cellStr};`);
        lines.push(`_mtoc2_col_off_${i} += 1;`);
      } else {
        const sc = `_mtoc2_sc_${i}_${j}`;
        const sr = `_mtoc2_sr_${i}_${j}`;
        const cw = `_mtoc2_cw_${i}_${j}`;
        const ch = `_mtoc2_ch_${i}_${j}`;
        lines.push(`const ${cw} = ${colsHere};`);
        lines.push(`const ${ch} = ${rowsHere};`);
        lines.push(`for (let ${sc} = 0; ${sc} < ${cw}; ${sc}++) {`);
        lines.push(`  for (let ${sr} = 0; ${sr} < ${ch}; ${sr}++) {`);
        const dstIdx = `(_mtoc2_row_off + ${sr}) + (_mtoc2_col_off_${i} + ${sc}) * _mtoc2_tr`;
        const srcIdx = `${sr} + ${sc} * ${ch}`;
        lines.push(
          `    _mtoc2_t.data[${dstIdx}] = ${cellStr}.data[${srcIdx}];`
        );
        lines.push(`  }`);
        lines.push(`}`);
        lines.push(`_mtoc2_col_off_${i} += ${cw};`);
      }
    }
    lines.push(`_mtoc2_row_off += ${rhLocals[i]};`);
  }
  lines.push(`return _mtoc2_t;`);
  return `(() => { ${lines.join(" ")} })()`;
}

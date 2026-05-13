/**
 * JS-side mirror of numbl's `formatNumber` + `formatTensor` (see
 * ../numbl/src/numbl-core/runtime/display.ts). Used at compile time
 * by the `disp` builtin's tensor path: when an exact-tensor reaches
 * disp, we format the entire output here and emit a `fputs(...)`
 * call with the resulting literal string.
 *
 * Source of truth is numbl's display.ts. Any change there must be
 * mirrored here; the cross-runner enforces byte-for-byte parity.
 */

/** Mirror of numbl's `formatNumber`. */
export function formatNumber(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) {
    return n.toString();
  }
  const s = n.toPrecision(5);
  const eIdx = s.search(/[eE]/);
  const mantissa = eIdx === -1 ? s : s.slice(0, eIdx);
  const exponent = eIdx === -1 ? "" : s.slice(eIdx);
  const trimmed = mantissa.includes(".")
    ? mantissa.replace(/\.?0+$/, "") || "0"
    : mantissa;
  return trimmed + exponent;
}

/** Format a 2D slice the way numbl's `format2DSlice` does. `data` is
 *  column-major (matches `RuntimeTensor.data`). For slope-1 we only
 *  emit ≤ 256-element tensors, so no truncation logic. */
export function formatTensor2D(
  data: ArrayLike<number>,
  rows: number,
  cols: number
): string {
  if (rows * cols === 0) return ""; // empty: caller suppresses entirely
  if (rows * cols === 1) return formatNumber(data[0]);

  // Render every cell, track per-column widths (max string length).
  const formatted: string[][] = [];
  const colWidths = new Array<number>(cols).fill(0);
  for (let r = 0; r < rows; r++) {
    const row: string[] = [];
    for (let c = 0; c < cols; c++) {
      const idx = c * rows + r; // column-major
      const s = formatNumber(data[idx]);
      row.push(s);
      if (s.length > colWidths[c]) colWidths[c] = s.length;
    }
    formatted.push(row);
  }

  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    const parts = formatted[r].map((s, c) => s.padStart(colWidths[c]));
    lines.push("   " + parts.join("   "));
  }
  return lines.join("\n");
}

// JS helpers for scalar tensor indexing (1-based, MATLAB-style).
// Mirrors the bounds-checking entry points the C side calls
// (`mtoc2_idx_lin` / `mtoc2_idx_axis`) but returns the 0-based
// offset directly — no out-parameter dance.

function rangeError(idx, bound, where) {
  throw new RangeError(
    `Index in position ${where} (${idx}) exceeds array bounds (${bound})`
  );
}

/** Linear (column-major) 0-based offset for a 1-based MATLAB index. */
export function mtoc2_idx_lin_js(t, k) {
  const i = Math.trunc(k);
  if (i < 1 || i > t.data.length) rangeError(i, t.data.length, 1);
  return i - 1;
}

/** Per-axis (0-based for the axis index, 1-based for the value)
 *  bounds-checked subscript. */
export function mtoc2_idx_axis_js(t, axis, k) {
  const i = Math.trunc(k);
  const dim = t.shape[axis] ?? 1;
  if (i < 1 || i > dim) rangeError(i, dim, axis + 1);
  return i - 1;
}

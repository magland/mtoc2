// JS sibling of `tensor_diag.h`. Three helpers: from-scalar (wraps a
// bare scalar into an off-diagonal matrix when k≠0), construct (vec →
// matrix with vec on the k-th diagonal), extract (matrix → column
// vector of the k-th diagonal). Mirrors `diag`'s tensor branch in
// numbl's `array-manipulation.ts`.

import { mtoc2_tensor_alloc } from "../tensor/tensor_alloc.js";

export function mtoc2_tensor_diag_from_scalar(v, k) {
  const absk = Math.abs(k);
  const m = 1 + absk;
  const out = mtoc2_tensor_alloc(m, m);
  const r = k < 0 ? -k : 0;
  const c = k > 0 ? k : 0;
  out.data[r + c * m] = v;
  return out;
}

export function mtoc2_tensor_diag_construct(v, k) {
  const rows = v.shape[0];
  const cols = v.shape[1];
  const vecLen = Math.max(rows, cols);
  const absk = Math.abs(k);
  const m = vecLen + absk;
  const out = mtoc2_tensor_alloc(m, m);
  for (let i = 0; i < vecLen; i++) {
    const r = k < 0 ? i - k : i;
    const c = k > 0 ? i + k : i;
    out.data[r + c * m] = v.data[i];
  }
  return out;
}

export function mtoc2_tensor_diag_extract(a, k) {
  const rows = a.shape[0];
  const cols = a.shape[1];
  const iStart = k < 0 ? -k : 0;
  const jStart = k > 0 ? k : 0;
  const diagLen = Math.max(0, Math.min(rows - iStart, cols - jStart));
  const out = mtoc2_tensor_alloc(diagLen, 1);
  for (let i = 0; i < diagLen; i++) {
    const r = iStart + i;
    const c = jStart + i;
    out.data[i] = a.data[r + c * rows];
  }
  return out;
}

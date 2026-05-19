// JS sibling of `tensor_sort_real.h`. Stable ascending sort on a
// real tensor. Returns `{v, i}` for the two-output form; the
// single-output form just reads `.v`.

import { mtoc2_tensor_alloc_nd } from "../tensor/tensor_alloc_nd.js";

function pair_sort_indices(a) {
  // Return sorted index permutation [0..n-1], stable on equal values.
  const n = a.data.length;
  const idx = new Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((p, q) => {
    const av = a.data[p];
    const bv = a.data[q];
    if (av < bv) return -1;
    if (av > bv) return 1;
    return p - q;
  });
  return idx;
}

export function mtoc2_sort_real(a) {
  const v = mtoc2_tensor_alloc_nd(a.shape.length, a.shape);
  if (a.data.length === 0) return v;
  const sorted = pair_sort_indices(a);
  for (let i = 0; i < sorted.length; i++) v.data[i] = a.data[sorted[i]];
  return v;
}

export function mtoc2_sort_real_2(a) {
  const v = mtoc2_tensor_alloc_nd(a.shape.length, a.shape);
  const ix = mtoc2_tensor_alloc_nd(a.shape.length, a.shape);
  if (a.data.length === 0) return { v, ix };
  const sorted = pair_sort_indices(a);
  for (let i = 0; i < sorted.length; i++) {
    v.data[i] = a.data[sorted[i]];
    ix.data[i] = sorted[i] + 1;
  }
  return { v, ix };
}

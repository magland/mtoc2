// JS sibling of `tensor_fill_nd.h`. Like zeros/ones but takes the
// fill value as a leading argument — used by the `nan` / `Inf` shape-
// constructor branches.

import { mtoc2_tensor_alloc_nd } from "./tensor_alloc_nd.js";

export function mtoc2_tensor_fill_nd(value, ndim, dims) {
  const t = mtoc2_tensor_alloc_nd(ndim, dims);
  t.data.fill(value);
  return t;
}

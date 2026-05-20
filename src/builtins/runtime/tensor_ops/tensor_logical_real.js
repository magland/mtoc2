// JS sibling of `tensor_logical_real.h`. Elementwise logical NOT on a
// real tensor: returns a freshly-owned tensor of the same shape with
// `out[i] = (in[i] == 0) ? 1 : 0`. Result's type is logical at the
// type-system level; the runtime representation stays a double tensor
// flagged via `isLogical` so downstream index-slot resolution treats
// the value as a mask, not as a vector of 1-based indices.

import { mtoc2_tensor_alloc_nd } from "../tensor/tensor_alloc_nd.js";

export function mtoc2_tensor_not(a) {
  const r = mtoc2_tensor_alloc_nd(a.shape.length, a.shape);
  for (let i = 0; i < r.data.length; i++) {
    r.data[i] = a.data[i] === 0 ? 1 : 0;
  }
  // Tag as logical so `a(mask)` / `M(:, mask)` etc. take the mask
  // path in the interpreter (and js-aot, when wired). The tensor
  // alloc helpers return plain numeric tensors; we mutate the field
  // here rather than threading a parameter through every allocator.
  r.isLogical = true;
  return r;
}

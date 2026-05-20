// JS sibling of `tensor_logical_real.h`. Elementwise logical NOT on a
// real tensor: returns a freshly-owned tensor of the same shape with
// `out[i] = (in[i] == 0) ? 1 : 0`. Result's type is logical at the
// type-system level; the runtime representation stays a double tensor.

import { mtoc2_tensor_alloc_nd } from "../tensor/tensor_alloc_nd.js";

export function mtoc2_tensor_not(a) {
  const r = mtoc2_tensor_alloc_nd(a.shape.length, a.shape);
  for (let i = 0; i < r.data.length; i++) {
    r.data[i] = a.data[i] === 0 ? 1 : 0;
  }
  return r;
}

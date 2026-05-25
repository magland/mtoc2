// JS sibling of tensor_dot.h — real-double dot product.

import { mtoc2_tensor_alloc_nd } from "../tensor/tensor_alloc_nd.js";

export function mtoc2_dot_real(a, b) {
  if (a.data.length !== b.data.length) {
    throw new Error("dot: vectors must be same length");
  }
  let acc = 0.0;
  for (let i = 0; i < a.data.length; i++) acc += a.data[i] * b.data[i];
  return acc;
}

export function mtoc2_dot_real_matrix(a, b) {
  const rows = a.shape[0];
  const cols = a.shape[1];
  const r = mtoc2_tensor_alloc_nd(2, [1, cols]);
  for (let j = 0; j < cols; j++) {
    let acc = 0.0;
    for (let i = 0; i < rows; i++) {
      const off = j * rows + i;
      acc += a.data[off] * b.data[off];
    }
    r.data[j] = acc;
  }
  return r;
}

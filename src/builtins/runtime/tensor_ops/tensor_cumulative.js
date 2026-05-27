// JS sibling of `tensor_cumulative.h`. Prefix-scan helpers
// (`cumsum`, `cumprod`) on real tensors. `_dim` returns a
// freshly-allocated tensor of the SAME shape as the input,
// scanned along the 1-based `dim` axis. Mirrors numbl's
// `cumOp` (helpers/reduction/cumulative.ts) with column-major
// (before × axis × after) fiber traversal.
//
// NaN propagates: once acc becomes NaN (via + or *), every later
// output along that fiber is NaN. Matches the C side and numbl.

import { mtoc2_tensor_alloc_nd } from "../tensor/tensor_alloc_nd.js";

function cumScan(t, dim, init, op) {
  if (dim < 1) {
    throw new Error(`cumulative _dim: dim must be >= 1 (got ${dim})`);
  }
  const shape = t.shape;
  const out = mtoc2_tensor_alloc_nd(shape.length, shape.slice());
  if (dim > shape.length) {
    out.data.set(t.data);
    return out;
  }
  const dimIdx = dim - 1;
  const axis = shape[dimIdx];
  let before = 1;
  for (let i = 0; i < dimIdx; i++) before *= shape[i];
  let after = 1;
  for (let i = dimIdx + 1; i < shape.length; i++) after *= shape[i];
  for (let outer = 0; outer < after; outer++) {
    const slabBase = outer * before * axis;
    for (let inner = 0; inner < before; inner++) {
      let acc = init;
      for (let k = 0; k < axis; k++) {
        const idx = slabBase + inner + k * before;
        acc = op(acc, t.data[idx]);
        out.data[idx] = acc;
      }
    }
  }
  return out;
}

export const mtoc2_tensor_cumsum_dim = (t, dim) =>
  cumScan(t, dim, 0, (a, x) => a + x);
export const mtoc2_tensor_cumprod_dim = (t, dim) =>
  cumScan(t, dim, 1, (a, x) => a * x);

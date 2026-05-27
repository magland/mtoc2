// JS sibling of `tensor_predicate.h`. Real-tensor → logical-tensor
// predicate kernels for the js-aot backend. Result carries
// `isLogical: true` so downstream index-slot resolution treats it as
// a mask.

function pred_kernel(a, fn) {
  const out = new Float64Array(a.data.length);
  for (let i = 0; i < a.data.length; i++) out[i] = fn(a.data[i]) ? 1 : 0;
  return {
    mtoc2Tag: "tensor",
    shape: a.shape.slice(),
    data: out,
    isLogical: true,
  };
}

export function mtoc2_tensor_isnan(a) {
  return pred_kernel(a, Number.isNaN);
}

export function mtoc2_tensor_logical(a) {
  return pred_kernel(a, x => x !== 0);
}

// JS sibling of `tensor_predicate_complex.h`. Each helper takes a
// complex tensor (with `data` for the real lane and an optional
// `imag` lane) and returns a logical-tagged real tensor (1.0 / 0.0
// per element). Matches the C path so the js-aot and interpreter
// backends stay byte-identical with c-aot for complex predicate
// outputs.

import { mtoc2_tensor_alloc_nd } from "../tensor/tensor_alloc_nd.js";

function complexPredKernel(a, fn) {
  const r = mtoc2_tensor_alloc_nd(a.shape.length, a.shape);
  const im = a.imag;
  for (let i = 0; i < r.data.length; i++) {
    r.data[i] = fn(a.data[i], im !== undefined ? im[i] : 0) ? 1 : 0;
  }
  r.isLogical = true;
  return r;
}

export function mtoc2_tensor_isnan_complex(a) {
  return complexPredKernel(a, (re, im) => Number.isNaN(re) || Number.isNaN(im));
}

export function mtoc2_tensor_isinf_complex(a) {
  const isInf = x => x === Infinity || x === -Infinity;
  return complexPredKernel(a, (re, im) => isInf(re) || isInf(im));
}

export function mtoc2_tensor_isfinite_complex(a) {
  return complexPredKernel(
    a,
    (re, im) => Number.isFinite(re) && Number.isFinite(im)
  );
}

export function mtoc2_tensor_not_complex(a) {
  return complexPredKernel(a, (re, im) => re === 0 && im === 0);
}

// JS sibling of `tensor_elemwise_complex.h`. Per-op tensor-tensor /
// tensor-scalar / scalar-tensor / broadcast helpers for complex
// operands. Mirrors the real elemwise scaffold but each element is a
// `{re, im}` pair carried by the `data` + `imag` lanes.

import { mtoc2_tensor_alloc_nd_complex } from "../tensor/tensor_alloc_nd_complex.js";
import {
  mtoc2_cadd,
  mtoc2_csub,
  mtoc2_cmul,
  mtoc2_cneg,
} from "../system/cscalar.js";
import { mtoc2_cdiv } from "../system/cdiv.js";

function laneOf(t, idx) {
  return { re: t.data[idx], im: t.imag[idx] };
}

function tt_kernel(a, b, fn) {
  const r = mtoc2_tensor_alloc_nd_complex(a.shape.length, a.shape);
  for (let i = 0; i < r.data.length; i++) {
    const v = fn(laneOf(a, i), laneOf(b, i));
    r.data[i] = v.re;
    r.imag[i] = v.im;
  }
  return r;
}

function ts_kernel(a, s, fn) {
  const r = mtoc2_tensor_alloc_nd_complex(a.shape.length, a.shape);
  for (let i = 0; i < r.data.length; i++) {
    const v = fn(laneOf(a, i), s);
    r.data[i] = v.re;
    r.imag[i] = v.im;
  }
  return r;
}

function st_kernel(s, a, fn) {
  const r = mtoc2_tensor_alloc_nd_complex(a.shape.length, a.shape);
  for (let i = 0; i < r.data.length; i++) {
    const v = fn(s, laneOf(a, i));
    r.data[i] = v.re;
    r.imag[i] = v.im;
  }
  return r;
}

// Broadcast helper — same shape walk as the real elemwise broadcast
// path but each cell carries two lanes.
function bcast_kernel(a, b, fn) {
  const ndim = Math.max(a.shape.length, b.shape.length);
  const ashape = a.shape.slice();
  const bshape = b.shape.slice();
  while (ashape.length < ndim) ashape.push(1);
  while (bshape.length < ndim) bshape.push(1);
  const outShape = new Array(ndim);
  for (let i = 0; i < ndim; i++) {
    outShape[i] = Math.max(ashape[i], bshape[i]);
  }
  const r = mtoc2_tensor_alloc_nd_complex(ndim, outShape);
  const aStrides = new Array(ndim);
  const bStrides = new Array(ndim);
  let as = 1;
  let bs = 1;
  for (let i = 0; i < ndim; i++) {
    aStrides[i] = ashape[i] === 1 ? 0 : as;
    bStrides[i] = bshape[i] === 1 ? 0 : bs;
    as *= ashape[i];
    bs *= bshape[i];
  }
  const idx = new Array(ndim).fill(0);
  for (let k = 0; k < r.data.length; k++) {
    let aOff = 0;
    let bOff = 0;
    for (let i = 0; i < ndim; i++) {
      aOff += idx[i] * aStrides[i];
      bOff += idx[i] * bStrides[i];
    }
    const v = fn(laneOf(a, aOff), laneOf(b, bOff));
    r.data[k] = v.re;
    r.imag[k] = v.im;
    for (let i = 0; i < ndim; i++) {
      idx[i]++;
      if (idx[i] < outShape[i]) break;
      idx[i] = 0;
    }
  }
  return r;
}

// ── plus ──────────────────────────────────────────────────────────────────
export function mtoc2_tensor_plus_complex_tt(a, b) { return tt_kernel(a, b, mtoc2_cadd); }
export function mtoc2_tensor_plus_complex_ts(a, s) { return ts_kernel(a, s, mtoc2_cadd); }
export function mtoc2_tensor_plus_complex_bcast_tt(a, b) { return bcast_kernel(a, b, mtoc2_cadd); }

// ── minus ─────────────────────────────────────────────────────────────────
export function mtoc2_tensor_minus_complex_tt(a, b) { return tt_kernel(a, b, mtoc2_csub); }
export function mtoc2_tensor_minus_complex_ts(a, s) { return ts_kernel(a, s, mtoc2_csub); }
export function mtoc2_tensor_minus_complex_st(s, a) { return st_kernel(s, a, mtoc2_csub); }
export function mtoc2_tensor_minus_complex_bcast_tt(a, b) { return bcast_kernel(a, b, mtoc2_csub); }

// ── times ─────────────────────────────────────────────────────────────────
export function mtoc2_tensor_times_complex_tt(a, b) { return tt_kernel(a, b, mtoc2_cmul); }
export function mtoc2_tensor_times_complex_ts(a, s) { return ts_kernel(a, s, mtoc2_cmul); }
export function mtoc2_tensor_times_complex_bcast_tt(a, b) { return bcast_kernel(a, b, mtoc2_cmul); }

// ── rdivide ───────────────────────────────────────────────────────────────
export function mtoc2_tensor_rdivide_complex_tt(a, b) { return tt_kernel(a, b, mtoc2_cdiv); }
export function mtoc2_tensor_rdivide_complex_ts(a, s) { return ts_kernel(a, s, mtoc2_cdiv); }
export function mtoc2_tensor_rdivide_complex_st(s, a) { return st_kernel(s, a, mtoc2_cdiv); }
export function mtoc2_tensor_rdivide_complex_bcast_tt(a, b) { return bcast_kernel(a, b, mtoc2_cdiv); }

// ── uminus ────────────────────────────────────────────────────────────────
export function mtoc2_tensor_uminus_complex(a) {
  const r = mtoc2_tensor_alloc_nd_complex(a.shape.length, a.shape);
  for (let i = 0; i < r.data.length; i++) {
    const v = mtoc2_cneg(laneOf(a, i));
    r.data[i] = v.re;
    r.imag[i] = v.im;
  }
  return r;
}

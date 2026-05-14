/* mtoc2 runtime helper: reshape a real tensor to an N-D shape.
 *
 * Receives the input tensor by value (`mtoc2_tensor_t`) plus a
 * caller-supplied dim list (`ndim`, `dims`). Allocates a fresh
 * output tensor via `mtoc2_tensor_alloc_nd` and copies the input's
 * column-major buffer wholesale — reshape is a layout reinterpret,
 * so the linear element order is unchanged.
 *
 * Element-count check: the lowerer enforces `prod(input.dims) ==
 * prod(dims)` at translate time when the input shape is statically
 * known. This helper is the fallback when the input shape only
 * appears at runtime (e.g. a tensor function param whose
 * specialization arg type came in without a concrete shape). On
 * mismatch it prints to stderr and aborts, matching numbl's
 * runtime-error surface.
 *
 * Real-only — mtoc2's tensor side is real-only today; the type
 * lattice rejects complex inputs at lowering. The output's `imag`
 * is NULL, set by `mtoc2_tensor_alloc_nd`.
 */

#include <string.h>
#include <stdio.h>
#include <stdlib.h>

static mtoc2_tensor_t mtoc2_reshape_nd(
    mtoc2_tensor_t in, int ndim, const long *dims) {
  size_t in_total = 1;
  for (int i = 0; i < in.ndim; i++) in_total *= (size_t)in.dims[i];
  size_t out_total = 1;
  for (int i = 0; i < ndim; i++) out_total *= (size_t)dims[i];
  if (in_total != out_total) {
    fprintf(stderr,
      "mtoc2: reshape: number of elements must not change "
      "(in=%zu, out=%zu)\n", in_total, out_total);
    abort();
  }
  mtoc2_tensor_t out = mtoc2_tensor_alloc_nd(ndim, dims);
  if (out_total > 0)
    memcpy(out.real, in.real, out_total * sizeof(double));
  return out;
}

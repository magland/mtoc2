/* mtoc2 runtime helper: allocate an uninitialized real tensor with
 * an arbitrary N-D shape.
 *
 * The 2-D fast path lives in `mtoc2_tensor_alloc`; this helper is the
 * variadic N-D sibling that copies `ndim` dim sizes from the caller-
 * supplied `dims` array into the struct.
 *
 * `dims` is consumed read-only — the caller may pass a stack
 * `(long[]){…}` compound literal. The returned tensor owns its
 * `real` buffer; `imag` is NULL (the static-real marker). Aborts
 * on `ndim` exceeding `MTOC2_MAX_NDIM` or on size-math overflow.
 */

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

static mtoc2_tensor_t mtoc2_tensor_alloc_nd(int ndim, const long *dims) {
  if (ndim > MTOC2_MAX_NDIM) {
    fprintf(stderr,
      "mtoc2: tensor ndim %d exceeds MTOC2_MAX_NDIM=%d\n", ndim, MTOC2_MAX_NDIM);
    abort();
  }
  mtoc2_tensor_t out;
  size_t n = 1;
  for (int i = 0; i < ndim; i++) {
    out.dims[i] = dims[i];
    size_t new_n;
#if defined(__has_builtin) && __has_builtin(__builtin_mul_overflow)
    if (__builtin_mul_overflow(n, (size_t)dims[i], &new_n)) {
      fprintf(stderr,
        "mtoc2: tensor allocation overflow at dim %d (size %ld)\n", i, dims[i]);
      abort();
    }
#else
    if ((size_t)dims[i] != 0 && n > (SIZE_MAX / sizeof(double)) / (size_t)dims[i]) {
      fprintf(stderr,
        "mtoc2: tensor allocation overflow at dim %d (size %ld)\n", i, dims[i]);
      abort();
    }
    new_n = n * (size_t)dims[i];
#endif
    n = new_n;
  }
  out.ndim = ndim;
  out.real = mtoc2_alloc(n * sizeof(double));
  out.imag = NULL;
  return out;
}

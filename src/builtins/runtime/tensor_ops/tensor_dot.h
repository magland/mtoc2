/* mtoc2 runtime helpers: dot product on real-double tensors.
 *
 *   mtoc2_dot_real(a, b) → double
 *     Vector form: `dot(a, b)` for any-orientation 1-D vectors with
 *     the same total numel. Returns the scalar sum
 *     `sum_i a.real[i] * b.real[i]`. Length mismatch aborts (this
 *     mirrors numbl's RuntimeError — the static type system rejects
 *     the case when both lengths are known at compile time, so a
 *     mismatch only reaches the helper through dim-unknown shapes).
 *
 *   mtoc2_dot_real_matrix(a, b) → mtoc2_tensor_t
 *     Matrix form: both args same shape MxN, returns a freshly-owned
 *     `[1, N]` row vector whose j-th entry is `sum_i a[i,j] * b[i,j]`.
 *     Column-major buffer walked directly.
 */

#include <stdio.h>
#include <stdlib.h>

static double mtoc2_dot_real(mtoc2_tensor_t a, mtoc2_tensor_t b) {
  long na = 1, nb = 1;
  for (int i = 0; i < a.ndim; i++) na *= a.dims[i];
  for (int i = 0; i < b.ndim; i++) nb *= b.dims[i];
  if (na != nb) {
    fprintf(stderr, "mtoc2: dot: vectors must be same length\n");
    abort();
  }
  double acc = 0.0;
  for (long i = 0; i < na; i++) acc += a.real[i] * b.real[i];
  return acc;
}

static mtoc2_tensor_t mtoc2_dot_real_matrix(mtoc2_tensor_t a,
                                            mtoc2_tensor_t b) {
  long rows = a.dims[0];
  long cols = a.dims[1];
  mtoc2_tensor_t r;
  r.real = mtoc2_alloc((size_t)cols * sizeof(double));
  r.imag = NULL;
  r.ndim = 2;
  r.dims[0] = 1;
  r.dims[1] = cols;
  for (long j = 0; j < cols; j++) {
    double acc = 0.0;
    for (long i = 0; i < rows; i++) {
      long off = j * rows + i;
      acc += a.real[off] * b.real[off];
    }
    r.real[j] = acc;
  }
  return r;
}

/* mtoc2 runtime helper: real-tensor `diag` — construct from a vector
 * (placing it on the k-th diagonal of a square matrix) or extract the
 * k-th diagonal from a 2-D matrix. Mirrors numbl's `diag` tensor
 * branch in `interpreter/builtins/array-manipulation.ts`.
 *
 * Three entry points share one snippet:
 *   - `mtoc2_tensor_diag_from_scalar(v, k)` — wraps a bare scalar into
 *     a `(|k|+1)×(|k|+1)` matrix with `v` at position
 *     `(max(0,-k), max(0,k))`. Used only when the lowering layer's
 *     scalar-input + nonzero-k path can't be folded statically.
 *   - `mtoc2_tensor_diag_construct(v, k)` — `v` is `1×N` or `N×1`;
 *     returns an `(N+|k|) × (N+|k|)` matrix with `v` on the k-th
 *     diagonal (`k≥0` ⇒ super-, `k<0` ⇒ sub-diagonal), zeros
 *     elsewhere.
 *   - `mtoc2_tensor_diag_extract(a, k)` — returns the k-th diagonal
 *     of a 2-D matrix as a column vector of length
 *     `max(0, min(M - iStart, N - jStart))`, where
 *     `iStart = max(0, -k)`, `jStart = max(0, k)`.
 *
 * Storage column-major in/out to match `mtoc2_tensor_t`. Result is
 * freshly owned; `imag` is NULL (complex path handled at lowering).
 */

#include <string.h>
#include <stdlib.h>

static mtoc2_tensor_t mtoc2_tensor_diag_from_scalar(double v, long k) {
  long absk = k < 0 ? -k : k;
  long m = 1 + absk;
  mtoc2_tensor_t out = mtoc2_tensor_alloc(m, m);
  if (m > 0) memset(out.real, 0, (size_t)m * (size_t)m * sizeof(double));
  long r = k < 0 ? -k : 0;
  long c = k > 0 ? k : 0;
  out.real[r + c * m] = v;
  return out;
}

static mtoc2_tensor_t mtoc2_tensor_diag_construct(mtoc2_tensor_t v, long k) {
  long rows = v.dims[0];
  long cols = v.dims[1];
  /* One dim is always 1 (caller dispatched on vector shape). */
  long vecLen = rows > cols ? rows : cols;
  long absk = k < 0 ? -k : k;
  long m = vecLen + absk;
  mtoc2_tensor_t out = mtoc2_tensor_alloc(m, m);
  if (m > 0) memset(out.real, 0, (size_t)m * (size_t)m * sizeof(double));
  for (long i = 0; i < vecLen; i++) {
    long r = k < 0 ? i - k : i;
    long c = k > 0 ? i + k : i;
    out.real[r + c * m] = v.real[i];
  }
  return out;
}

static mtoc2_tensor_t mtoc2_tensor_diag_extract(mtoc2_tensor_t a, long k) {
  long rows = a.dims[0];
  long cols = a.dims[1];
  long iStart = k < 0 ? -k : 0;
  long jStart = k > 0 ? k : 0;
  long avail_r = rows - iStart;
  long avail_c = cols - jStart;
  long diagLen = avail_r < avail_c ? avail_r : avail_c;
  if (diagLen < 0) diagLen = 0;
  mtoc2_tensor_t out = mtoc2_tensor_alloc(diagLen, 1);
  for (long i = 0; i < diagLen; i++) {
    long r = iStart + i;
    long c = jStart + i;
    out.real[i] = a.real[r + c * rows];
  }
  return out;
}

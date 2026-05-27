/* mtoc2 runtime helper: real-tensor `triu` / `tril` — extract upper /
 * lower triangular part of a 2-D matrix around the k-th diagonal.
 * Mirrors numbl's `triPart` in `interpreter/builtins/array-extras.ts`.
 *
 *   - `mtoc2_tensor_triu(A, k)` returns a fresh `rows × cols` tensor
 *     equal to `A` where `j - i >= k` (column - row), zero elsewhere.
 *     `k = 0` is the main diagonal; `k > 0` selects a super-diagonal;
 *     `k < 0` selects a sub-diagonal.
 *   - `mtoc2_tensor_tril(A, k)` is the mirror: keep entries where
 *     `i - j >= -k` (equivalently `j - i <= k`), zero elsewhere.
 *
 * Storage column-major to match `mtoc2_tensor_t`. Result is freshly
 * owned; `imag` is NULL (complex path rejected at lowering).
 */

#include <string.h>
#include <stdlib.h>

static mtoc2_tensor_t mtoc2_tensor_triu(mtoc2_tensor_t a, long k) {
  long rows = a.dims[0];
  long cols = a.dims[1];
  mtoc2_tensor_t out = mtoc2_tensor_alloc(rows, cols);
  if (rows > 0 && cols > 0)
    memset(out.real, 0, (size_t)rows * (size_t)cols * sizeof(double));
  for (long j = 0; j < cols; j++) {
    for (long i = 0; i < rows; i++) {
      if (j - i >= k) {
        long idx = i + j * rows;
        out.real[idx] = a.real[idx];
      }
    }
  }
  return out;
}

static mtoc2_tensor_t mtoc2_tensor_tril(mtoc2_tensor_t a, long k) {
  long rows = a.dims[0];
  long cols = a.dims[1];
  mtoc2_tensor_t out = mtoc2_tensor_alloc(rows, cols);
  if (rows > 0 && cols > 0)
    memset(out.real, 0, (size_t)rows * (size_t)cols * sizeof(double));
  for (long j = 0; j < cols; j++) {
    for (long i = 0; i < rows; i++) {
      if (i - j >= -k) {
        long idx = i + j * rows;
        out.real[idx] = a.real[idx];
      }
    }
  }
  return out;
}

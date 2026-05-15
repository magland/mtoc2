/* mtoc2 runtime helper: build a rows×cols complex tensor from a flat
 * column-major `double _Complex[]` source. Allocates both lanes
 * and splits the incoming complex values into them. Sibling of
 * `mtoc2_tensor_from_matrix`.
 */

#include <complex.h>

static mtoc2_tensor_t mtoc2_tensor_from_matrix_complex(
    const double _Complex *src, long rows, long cols) {
  mtoc2_tensor_t out = mtoc2_tensor_alloc_complex(rows, cols);
  long n = rows * cols;
  for (long i = 0; i < n; i++) {
    out.real[i] = creal(src[i]);
    out.imag[i] = cimag(src[i]);
  }
  return out;
}

/* mtoc2 runtime helper: build a 1×N complex tensor from a flat
 * `double _Complex[]` source. Allocates both lanes and splits the
 * incoming complex values into them. Sibling of
 * `mtoc2_tensor_from_row`.
 */

#include <complex.h>

static mtoc2_tensor_t mtoc2_tensor_from_row_complex(
    const double _Complex *src, long n) {
  mtoc2_tensor_t out = mtoc2_tensor_alloc_complex(1, n);
  for (long i = 0; i < n; i++) {
    out.real[i] = creal(src[i]);
    out.imag[i] = cimag(src[i]);
  }
  return out;
}

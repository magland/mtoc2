/* mtoc2 runtime helpers: vector 2-norm.
 *
 * Two variants for real and complex storage. Both return a `double`
 * (the 2-norm is real-valued regardless of input type). The transfer
 * step has already verified the input is a 1-D vector (row or
 * column), so we just walk all elements column-major.
 *
 * Empty input (numel == 0) returns 0.0, matching MATLAB / numbl.
 */

#include <math.h>

static double mtoc2_norm2_real(mtoc2_tensor_t a) {
  long n = 1;
  for (int i = 0; i < a.ndim; i++) n *= a.dims[i];
  double acc = 0.0;
  for (long i = 0; i < n; i++) {
    double x = a.real[i];
    acc += x * x;
  }
  return sqrt(acc);
}

static double mtoc2_norm2_complex(mtoc2_tensor_t a) {
  long n = 1;
  for (int i = 0; i < a.ndim; i++) n *= a.dims[i];
  double acc = 0.0;
  for (long i = 0; i < n; i++) {
    double re = a.real[i];
    double im = a.imag[i];
    acc += re * re + im * im;
  }
  return sqrt(acc);
}

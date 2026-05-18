#include "my_matvec_impl.h"

void my_matvec_impl(
  long m, long n, const double *A, const double *x, double *y
) {
  for (long i = 0; i < m; i++) {
    double acc = 0.0;
    for (long j = 0; j < n; j++) {
      acc += A[i + j * m] * x[j];
    }
    y[i] = acc;
  }
}

#pragma once

/* Naive M-by-N matrix * N-by-1 vector multiply.
 * A is column-major (mtoc2's layout): A[i + j*m] is row i, col j.
 * Output `y` (length m) is overwritten. */
void my_matvec_impl(long m, long n, const double *A, const double *x, double *y);

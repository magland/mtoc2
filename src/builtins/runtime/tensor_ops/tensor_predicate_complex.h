/* mtoc2 runtime helpers: elementwise complex-tensor → logical-tensor
 * predicates. Sibling of `tensor_predicate.h`. Each per-element
 * decision is made on the `(real[i], imag[i])` pair (treating a
 * NULL `imag` lane as zero, so a real tensor that flows in via a
 * complex-typed route behaves the same as a genuine complex input
 * whose imag lane happens to be zero).
 *
 *   isnan_complex     :  re NaN || im NaN
 *   isinf_complex     :  re Inf || im Inf
 *   isfinite_complex  :  re finite && im finite
 *
 * Result is a real (logical-typed) tensor — `imag = NULL`, every
 * cell either 0.0 or 1.0.
 */
#include <math.h>
#include <stdlib.h>

#define MTOC2_DEFINE_UNARY_PRED_COMPLEX(name, EXPR)         \
  static mtoc2_tensor_t name(mtoc2_tensor_t a) {            \
    long n = 1;                                             \
    for (int i = 0; i < a.ndim; i++) n *= a.dims[i];        \
    mtoc2_tensor_t r;                                       \
    r.real = mtoc2_alloc((size_t)n * sizeof(double));       \
    r.imag = NULL;                                          \
    r.ndim = a.ndim;                                        \
    for (int i = 0; i < a.ndim; i++) r.dims[i] = a.dims[i]; \
    MTOC2_OMP_PARFOR_N                                      \
    for (long i = 0; i < n; i++) {                          \
      double re = a.real[i];                                \
      double im = (a.imag != NULL) ? a.imag[i] : 0.0;       \
      r.real[i] = (EXPR) ? 1.0 : 0.0;                       \
    }                                                       \
    return r;                                               \
  }

MTOC2_DEFINE_UNARY_PRED_COMPLEX(mtoc2_tensor_isnan_complex,
                                isnan(re) || isnan(im))
MTOC2_DEFINE_UNARY_PRED_COMPLEX(mtoc2_tensor_isinf_complex,
                                isinf(re) || isinf(im))
MTOC2_DEFINE_UNARY_PRED_COMPLEX(mtoc2_tensor_isfinite_complex,
                                isfinite(re) && isfinite(im))
MTOC2_DEFINE_UNARY_PRED_COMPLEX(mtoc2_tensor_not_complex,
                                (re == 0.0) && (im == 0.0))

#undef MTOC2_DEFINE_UNARY_PRED_COMPLEX

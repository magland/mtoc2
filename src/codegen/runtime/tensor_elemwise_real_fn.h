/* mtoc2 runtime helpers: elementwise binary functions on real
 * tensors (`mod`, `rem`, `atan2`, `hypot`). Same-shape only — same
 * constraint as `tensor_elemwise_real.h` for the infix ops.
 *
 * Each helper returns a freshly-owned tensor. The differences from
 * `tensor_elemwise_real.h`:
 *   - The kernel is `FN(a, b)` (a C function call) rather than
 *     `a OP b` (an infix operator).
 *   - `mod` needs `mtoc2_mod_real` (MATLAB convention: result sign
 *     tracks `b`'s sign), distinct from C's `fmod` (result sign
 *     tracks `a`'s sign).
 *
 * The scalar paths (mod/rem/atan2/hypot on two scalars) call the
 * underlying C function directly via the builtin's `codegenC`; this
 * header only carries the tensor helpers.
 */
#include <math.h>
#include <stdlib.h>

/* MATLAB `mod(a, b)`: result has the sign of `b`. `mod(a, 0) = a`. */
static double mtoc2_mod_real(double a, double b) {
  if (b == 0.0) return a;
  double r = fmod(a, b);
  if (r != 0.0 && ((r < 0) != (b < 0))) r += b;
  return r;
}

#define MTOC2_DEFINE_ELEMWISE_TT_FN(name, FN)                               \
  static mtoc2_tensor_t name(mtoc2_tensor_t a, mtoc2_tensor_t b) {          \
    long n = 1;                                                             \
    for (int i = 0; i < a.ndim; i++) n *= a.dims[i];                        \
    mtoc2_tensor_t r;                                                       \
    r.real = mtoc2_alloc((size_t)n * sizeof(double));                       \
    r.imag = NULL;                                                          \
    r.ndim = a.ndim;                                                        \
    for (int i = 0; i < a.ndim; i++) r.dims[i] = a.dims[i];                 \
    for (long i = 0; i < n; i++) r.real[i] = FN(a.real[i], b.real[i]);      \
    return r;                                                               \
  }

#define MTOC2_DEFINE_ELEMWISE_TS_FN(name, FN)                               \
  static mtoc2_tensor_t name(mtoc2_tensor_t a, double s) {                  \
    long n = 1;                                                             \
    for (int i = 0; i < a.ndim; i++) n *= a.dims[i];                        \
    mtoc2_tensor_t r;                                                       \
    r.real = mtoc2_alloc((size_t)n * sizeof(double));                       \
    r.imag = NULL;                                                          \
    r.ndim = a.ndim;                                                        \
    for (int i = 0; i < a.ndim; i++) r.dims[i] = a.dims[i];                 \
    for (long i = 0; i < n; i++) r.real[i] = FN(a.real[i], s);              \
    return r;                                                               \
  }

#define MTOC2_DEFINE_ELEMWISE_ST_FN(name, FN)                               \
  static mtoc2_tensor_t name(double s, mtoc2_tensor_t b) {                  \
    long n = 1;                                                             \
    for (int i = 0; i < b.ndim; i++) n *= b.dims[i];                        \
    mtoc2_tensor_t r;                                                       \
    r.real = mtoc2_alloc((size_t)n * sizeof(double));                       \
    r.imag = NULL;                                                          \
    r.ndim = b.ndim;                                                        \
    for (int i = 0; i < b.ndim; i++) r.dims[i] = b.dims[i];                 \
    for (long i = 0; i < n; i++) r.real[i] = FN(s, b.real[i]);              \
    return r;                                                               \
  }

MTOC2_DEFINE_ELEMWISE_TT_FN(mtoc2_tensor_mod_tt,   mtoc2_mod_real)
MTOC2_DEFINE_ELEMWISE_TT_FN(mtoc2_tensor_rem_tt,   fmod)
MTOC2_DEFINE_ELEMWISE_TT_FN(mtoc2_tensor_atan2_tt, atan2)
MTOC2_DEFINE_ELEMWISE_TT_FN(mtoc2_tensor_hypot_tt, hypot)

MTOC2_DEFINE_ELEMWISE_TS_FN(mtoc2_tensor_mod_ts,   mtoc2_mod_real)
MTOC2_DEFINE_ELEMWISE_TS_FN(mtoc2_tensor_rem_ts,   fmod)
MTOC2_DEFINE_ELEMWISE_TS_FN(mtoc2_tensor_atan2_ts, atan2)
MTOC2_DEFINE_ELEMWISE_TS_FN(mtoc2_tensor_hypot_ts, hypot)

/* Non-commutative non-fn ops (mod, rem, atan2) need scalar-first
 * variants. `hypot` is commutative; the builtin emits `_ts` with
 * swapped operands at scalar-OP-tensor sites. */
MTOC2_DEFINE_ELEMWISE_ST_FN(mtoc2_tensor_mod_st,   mtoc2_mod_real)
MTOC2_DEFINE_ELEMWISE_ST_FN(mtoc2_tensor_rem_st,   fmod)
MTOC2_DEFINE_ELEMWISE_ST_FN(mtoc2_tensor_atan2_st, atan2)

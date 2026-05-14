/* mtoc2 runtime helpers: elementwise binary + unary ops on real
 * tensors. Same-shape only (slope-3 first slice) — general broadcast
 * comes later.
 *
 * Convention in the function names:
 *   `_tt` — both args are tensors of the same shape
 *   `_ts` — tensor + scalar (broadcast scalar across all elements)
 *   `_st` — scalar + tensor (only emitted for non-commutative ops)
 *
 * Every helper returns a freshly-owned tensor — the codegen
 * invariant. The caller hands the result to `mtoc2_tensor_assign`
 * (or to a hoisted temp Assign for in-line uses). No shape check
 * here: same-shape requirement is enforced statically at lowering
 * time, so the runtime trusts its inputs.
 */

#include <stdlib.h>

#define MTOC2_DEFINE_ELEMWISE_TT(name, OP)                                  \
  static mtoc2_tensor_t name(mtoc2_tensor_t a, mtoc2_tensor_t b) {          \
    long n = 1;                                                             \
    for (int i = 0; i < a.ndim; i++) n *= a.dims[i];                        \
    mtoc2_tensor_t r;                                                       \
    r.real = mtoc2_alloc((size_t)n * sizeof(double));                       \
    r.imag = NULL;                                                          \
    r.ndim = a.ndim;                                                        \
    for (int i = 0; i < a.ndim; i++) r.dims[i] = a.dims[i];                 \
    for (long i = 0; i < n; i++) r.real[i] = a.real[i] OP b.real[i];        \
    return r;                                                               \
  }

#define MTOC2_DEFINE_ELEMWISE_TS(name, OP)                                  \
  static mtoc2_tensor_t name(mtoc2_tensor_t a, double s) {                  \
    long n = 1;                                                             \
    for (int i = 0; i < a.ndim; i++) n *= a.dims[i];                        \
    mtoc2_tensor_t r;                                                       \
    r.real = mtoc2_alloc((size_t)n * sizeof(double));                       \
    r.imag = NULL;                                                          \
    r.ndim = a.ndim;                                                        \
    for (int i = 0; i < a.ndim; i++) r.dims[i] = a.dims[i];                 \
    for (long i = 0; i < n; i++) r.real[i] = a.real[i] OP s;                \
    return r;                                                               \
  }

#define MTOC2_DEFINE_ELEMWISE_ST(name, OP)                                  \
  static mtoc2_tensor_t name(double s, mtoc2_tensor_t b) {                  \
    long n = 1;                                                             \
    for (int i = 0; i < b.ndim; i++) n *= b.dims[i];                        \
    mtoc2_tensor_t r;                                                       \
    r.real = mtoc2_alloc((size_t)n * sizeof(double));                       \
    r.imag = NULL;                                                          \
    r.ndim = b.ndim;                                                        \
    for (int i = 0; i < b.ndim; i++) r.dims[i] = b.dims[i];                 \
    for (long i = 0; i < n; i++) r.real[i] = s OP b.real[i];                \
    return r;                                                               \
  }

MTOC2_DEFINE_ELEMWISE_TT(mtoc2_tensor_plus_tt, +)
MTOC2_DEFINE_ELEMWISE_TT(mtoc2_tensor_minus_tt, -)
MTOC2_DEFINE_ELEMWISE_TT(mtoc2_tensor_times_tt, *)
MTOC2_DEFINE_ELEMWISE_TT(mtoc2_tensor_rdivide_tt, /)

MTOC2_DEFINE_ELEMWISE_TS(mtoc2_tensor_plus_ts, +)
MTOC2_DEFINE_ELEMWISE_TS(mtoc2_tensor_minus_ts, -)
MTOC2_DEFINE_ELEMWISE_TS(mtoc2_tensor_times_ts, *)
MTOC2_DEFINE_ELEMWISE_TS(mtoc2_tensor_rdivide_ts, /)

/* Commutative ops (plus, times) reuse `_ts` for `scalar OP tensor`.
 * Non-commutative ops need their own scalar-first flavor. */
MTOC2_DEFINE_ELEMWISE_ST(mtoc2_tensor_minus_st, -)
MTOC2_DEFINE_ELEMWISE_ST(mtoc2_tensor_rdivide_st, /)

/* Unary minus — negate every element. */
static mtoc2_tensor_t mtoc2_tensor_uminus(mtoc2_tensor_t a) {
  long n = 1;
  for (int i = 0; i < a.ndim; i++) n *= a.dims[i];
  mtoc2_tensor_t r;
  r.real = mtoc2_alloc((size_t)n * sizeof(double));
  r.imag = NULL;
  r.ndim = a.ndim;
  for (int i = 0; i < a.ndim; i++) r.dims[i] = a.dims[i];
  for (long i = 0; i < n; i++) r.real[i] = -a.real[i];
  return r;
}

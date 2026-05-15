/* mtoc2 runtime helpers: scalar complex operations as explicit
 * function calls.
 *
 * Every `double _Complex` operation mtoc2 emits into user code routes
 * through one of these helpers instead of relying on C99's operator
 * overloading or the `I` macro. Native: each is `static inline` and
 * the compiler folds back to the same instructions C99 would have
 * generated. The win is that secondary translators (the c2js JS
 * backend in `src/cjs/`) see plain function calls and don't need to
 * track types through expressions — they can ship a matching set of
 * helpers that operate on a JS `{re, im}` representation.
 *
 * Division and pow are NOT defined here:
 *   - `mtoc2_cdiv` lives in `cdiv.h` because it needs Smith's
 *     algorithm + signed-zero detection to match numbl byte-for-byte.
 *   - `cpow` is emitted directly today (still a libm call, not an
 *     operator); a `mtoc2_cpow` wrapper lands when the c2js side
 *     grows a JS power helper.
 */

#include <complex.h>
#include <math.h>

static inline double _Complex mtoc2_cmake(double re, double im) {
  return re + im * I;
}
static inline double mtoc2_creal(double _Complex z) { return creal(z); }
static inline double mtoc2_cimag(double _Complex z) { return cimag(z); }
static inline double _Complex mtoc2_cadd(double _Complex a, double _Complex b) { return a + b; }
static inline double _Complex mtoc2_csub(double _Complex a, double _Complex b) { return a - b; }
static inline double _Complex mtoc2_cmul(double _Complex a, double _Complex b) { return a * b; }
static inline double _Complex mtoc2_cneg(double _Complex z) { return -z; }
static inline double _Complex mtoc2_cconj(double _Complex z) { return conj(z); }
static inline double mtoc2_cabs(double _Complex z) {
  return hypot(creal(z), cimag(z));
}
static inline double mtoc2_cangle(double _Complex z) {
  return atan2(cimag(z), creal(z));
}
static inline int mtoc2_cnonzero(double _Complex z) {
  return creal(z) != 0.0 || cimag(z) != 0.0;
}
static inline int mtoc2_ceq(double _Complex a, double _Complex b) {
  return creal(a) == creal(b) && cimag(a) == cimag(b);
}
static inline int mtoc2_cne(double _Complex a, double _Complex b) {
  return creal(a) != creal(b) || cimag(a) != cimag(b);
}
static inline double _Complex mtoc2_cpow(double _Complex a, double _Complex b) {
  return cpow(a, b);
}

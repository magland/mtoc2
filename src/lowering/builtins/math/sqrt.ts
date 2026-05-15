import { defineUnaryRealMath } from "./_unary_real.js";
import { TypeError } from "../../errors.js";
import { signIsNonneg, signIsPositive } from "../../types.js";
import { cSqrt } from "./_complex_fold.js";

/** `sqrt(x)`: real-domain rejection — input must be statically nonneg
 *  on the real path; complex inputs fold through `mtoc2_csqrt`
 *  (z's principal square root) instead. Without an explicit "lift to
 *  complex on domain miss" rule, `sqrt(-1)` on a statically-real
 *  input still errors at translation — users opt into complex by
 *  writing `sqrt(-1 + 0i)` (or similar) to make the operand complex
 *  in the type system.
 *
 *  Sign rule on the (non-rejected) real input:
 *   - `positive` → `positive` (sqrt of strictly positive is strictly positive)
 *   - everything else (`nonneg` / `zero`) → `nonneg`.
 */
export const sqrt = defineUnaryRealMath({
  name: "sqrt",
  cFnReal: "sqrt",
  jsFn: x => Math.sqrt(x),
  signRule: t => (signIsPositive(t.sign) ? "positive" : "nonneg"),
  requireDomain: (t, span) => {
    if (!signIsNonneg(t.sign)) {
      throw new TypeError(
        `'sqrt' of input that may be negative is not yet supported ` +
          `for real-typed input (would produce a complex result). ` +
          `Either guard upstream or make the input complex (e.g. ` +
          `'sqrt(x + 0i)').`,
        span
      );
    }
  },
  complex: { cFnComplex: "mtoc2_csqrt", jsFnComplex: cSqrt },
});

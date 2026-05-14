import { defineUnaryRealMath } from "./_unary_real.js";
import { TypeError } from "../../errors.js";
import { signIsNonneg, signIsPositive } from "../../types.js";

/** `sqrt(x)`: real-domain rejection — input must be statically nonneg.
 *  numbl/MATLAB happily produces a complex result for negative input;
 *  mtoc2 has no complex type yet, so we error out at translation
 *  time. Workaround for users: assert positivity upstream.
 *
 *  The "statically nonneg" check works for both scalars and tensors:
 *  `tensorDouble(shape, exact)` derives the sign from the exact data,
 *  and `zeros`/`ones` attach an explicit sign even when the result is
 *  too large to carry exact data. So `sqrt([0 1 4 9])` and
 *  `sqrt(zeros(N))` both pass.
 *
 *  Sign rule on the (non-rejected) input:
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
          `(would produce a complex result; mtoc2 has no complex type). ` +
          `Pass a statically-nonneg input or guard upstream.`,
        span
      );
    }
  },
});

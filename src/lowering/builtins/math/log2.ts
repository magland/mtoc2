import { defineUnaryRealMath } from "./_unary_real.js";
import { TypeError } from "../../errors.js";
import { signIsPositive } from "../../types.js";

/** Base-2 log. Same positive-domain restriction as `log`.
 *  Single-output form only; two-output frexp form `[f,e] = log2(x)`
 *  is deferred.
 */
export const log2 = defineUnaryRealMath({
  name: "log2",
  cFnReal: "log2",
  jsFn: Math.log2,
  signRule: () => "unknown",
  requireDomain: (t, span) => {
    if (!signIsPositive(t.sign)) {
      throw new TypeError(
        `'log2' of input that is not statically positive is not yet supported ` +
          `(produces -Inf or complex; mtoc2 has no complex type). ` +
          `Pass a statically-positive input or guard upstream.`,
        span
      );
    }
  },
});

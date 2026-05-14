import { defineUnaryRealMath } from "./_unary_real.js";
import { TypeError } from "../../errors.js";
import { signIsPositive } from "../../types.js";

/** Natural log. Domain: strictly positive (`log(0) = -Inf`, `log(neg)`
 *  is complex). mtoc2 requires statically-positive input — guard
 *  upstream if the lattice can't prove it.
 */
export const log = defineUnaryRealMath({
  name: "log",
  cFnReal: "log",
  jsFn: Math.log,
  signRule: () => "unknown",
  requireDomain: (t, span) => {
    if (!signIsPositive(t.sign)) {
      throw new TypeError(
        `'log' of input that is not statically positive is not yet supported ` +
          `(produces -Inf or complex; mtoc2 has no complex type). ` +
          `Pass a statically-positive input or guard upstream.`,
        span
      );
    }
  },
});

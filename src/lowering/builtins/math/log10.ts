import { defineUnaryRealMath } from "./_unary_real.js";
import { TypeError } from "../../errors.js";
import { signIsPositive } from "../../types.js";

/** Base-10 log. Same positive-domain restriction as `log`. */
export const log10 = defineUnaryRealMath({
  name: "log10",
  cFnReal: "log10",
  jsFn: Math.log10,
  signRule: () => "unknown",
  requireDomain: (t, span) => {
    if (!signIsPositive(t.sign)) {
      throw new TypeError(
        `'log10' of input that is not statically positive is not yet supported ` +
          `(produces -Inf or complex; mtoc2 has no complex type). ` +
          `Pass a statically-positive input or guard upstream.`,
        span
      );
    }
  },
});

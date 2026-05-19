import { defineUnaryRealMath } from "./_unary_real.js";
import { TypeError } from "../../../lowering/errors.js";
import { signIsPositive } from "../../../lowering/types.js";
import { cLog10 } from "./_complex_fold.js";

/** Base-10 log. Same positive-domain restriction as `log` on the real
 *  path; complex inputs fold/emit through `mtoc2_clog10`. */
export const log10 = defineUnaryRealMath({
  name: "log10",
  cFnReal: "log10",
  jsFn: Math.log10,
  signRule: () => "unknown",
  requireDomain: t => {
    if (!signIsPositive(t.sign)) {
      throw new TypeError(
        `'log10' of input that is not statically positive is not yet supported ` +
          `for real-typed input (produces -Inf or complex). Guard upstream ` +
          `or make the input complex (e.g. 'log10(x + 0i)').`
      );
    }
  },
  complex: { cFnComplex: "mtoc2_clog10", jsFnComplex: cLog10 },
});

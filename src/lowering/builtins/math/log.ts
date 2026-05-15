import { defineUnaryRealMath } from "./_unary_real.js";
import { TypeError } from "../../errors.js";
import { signIsPositive } from "../../types.js";
import { cLog } from "./_complex_fold.js";

/** Natural log. Real-path domain: strictly positive. Complex inputs
 *  skip the domain check and fold/emit through `mtoc2_clog`.
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
          `for real-typed input (produces -Inf or complex). Guard upstream ` +
          `or make the input complex (e.g. 'log(x + 0i)').`,
        span
      );
    }
  },
  complex: { cFnComplex: "mtoc2_clog", jsFnComplex: cLog },
});

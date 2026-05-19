import { defineUnaryRealMath } from "./_unary_real.js";
import { TypeError } from "../../../lowering/errors.js";
import { signIsPositive } from "../../../lowering/types.js";
import { cLog2 } from "./_complex_fold.js";

/** Base-2 log. Same positive-domain restriction as `log` on the real
 *  path; complex inputs fold/emit through `mtoc2_clog2`. Single-output
 *  form only; two-output frexp form `[f,e] = log2(x)` is deferred.
 */
export const log2 = defineUnaryRealMath({
  name: "log2",
  cFnReal: "log2",
  jsFn: Math.log2,
  signRule: () => "unknown",
  requireDomain: t => {
    if (!signIsPositive(t.sign)) {
      throw new TypeError(
        `'log2' of input that is not statically positive is not yet supported ` +
          `for real-typed input (produces -Inf or complex). Guard upstream ` +
          `or make the input complex (e.g. 'log2(x + 0i)').`
      );
    }
  },
  complex: { cFnComplex: "mtoc2_clog2", jsFnComplex: cLog2 },
});

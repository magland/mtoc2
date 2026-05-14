import { defineUnaryRealMath } from "./_unary_real.js";

/** sign(x) ∈ {-1, 0, 1} for real `x`. The result's sign is the input's
 *  sign — passes the input lattice state through unchanged. */
export const signBuiltin = defineUnaryRealMath({
  name: "sign",
  cFnReal: "mtoc2_signum",
  jsFn: Math.sign,
  signRule: t => t.sign,
});

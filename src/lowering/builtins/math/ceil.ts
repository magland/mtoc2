import { defineUnaryRealMath, roundingSignRule } from "./_unary_real.js";

/** `ceil(x)` rounds toward +Inf. Only `negative` inputs may land on 0
 *  (e.g. `ceil(-0.5) = 0`); `positive` inputs are bounded away. */
export const ceil = defineUnaryRealMath({
  name: "ceil",
  cFnReal: "ceil",
  jsFn: Math.ceil,
  signRule: roundingSignRule(false, true),
});

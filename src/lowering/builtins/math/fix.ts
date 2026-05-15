import { defineUnaryRealMath, roundingSignRule } from "./_unary_real.js";

/** `fix(x)` truncates toward zero (C99 `trunc`). Both `positive` and
 *  `negative` inputs may collapse to 0 (e.g. `fix(±0.5) = 0`). */
export const fix = defineUnaryRealMath({
  name: "fix",
  cFnReal: "trunc",
  jsFn: Math.trunc,
  signRule: roundingSignRule(true, true),
});

import { defineUnaryRealMath } from "./_unary_real.js";

/** Result is `nonneg` in general; `positive` when input is known to be
 *  nonzero (i.e. `positive`, `negative`, or `nonzero`). */
export const abs = defineUnaryRealMath({
  name: "abs",
  cFnReal: "fabs",
  jsFn: Math.abs,
  signRule: t => {
    if (t.sign === "positive" || t.sign === "negative" || t.sign === "nonzero")
      return "positive";
    return "nonneg";
  },
});

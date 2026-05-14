import { defineUnaryRealMath } from "./_unary_real.js";

export const atan = defineUnaryRealMath({
  name: "atan",
  cFnReal: "atan",
  jsFn: Math.atan,
  signRule: t => t.sign,
});

import { defineUnaryRealMath } from "./_unary_real.js";

export const sin = defineUnaryRealMath({
  name: "sin",
  cFnReal: "sin",
  jsFn: Math.sin,
  signRule: () => "unknown",
});

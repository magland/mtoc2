import { defineUnaryRealMath } from "./_unary_real.js";

export const tan = defineUnaryRealMath({
  name: "tan",
  cFnReal: "tan",
  jsFn: Math.tan,
  signRule: () => "unknown",
});

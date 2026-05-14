import { defineUnaryRealMath } from "./_unary_real.js";

export const cos = defineUnaryRealMath({
  name: "cos",
  cFnReal: "cos",
  jsFn: Math.cos,
  signRule: () => "unknown",
});

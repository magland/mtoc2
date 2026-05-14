import { defineUnaryRealMath } from "./_unary_real.js";

export const exp = defineUnaryRealMath({
  name: "exp",
  cFnReal: "exp",
  jsFn: Math.exp,
  signRule: () => "positive",
});

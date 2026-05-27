import { cumsumSign, defineCumulative } from "./_cumulative.js";

export const cumsum = defineCumulative({
  name: "cumsum",
  init: 0,
  step: (acc, x) => acc + x,
  signRule: cumsumSign,
});

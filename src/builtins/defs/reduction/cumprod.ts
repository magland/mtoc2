import { cumprodSign, defineCumulative } from "./_cumulative.js";

export const cumprod = defineCumulative({
  name: "cumprod",
  init: 1,
  step: (acc, x) => acc * x,
  signRule: cumprodSign,
});

import { defineUnaryRealMath } from "./_unary_real.js";

/** `fix(x)` truncates toward zero (C99 `trunc`). Sign-preserving:
 *   - `positive` may truncate to 0 (`fix(0.5) = 0`) → `nonneg`.
 *   - `negative` may truncate to 0 (`fix(-0.5) = 0`) → `nonpositive`.
 *   - everything else passes through.
 */
export const fix = defineUnaryRealMath({
  name: "fix",
  cFnReal: "trunc",
  jsFn: Math.trunc,
  signRule: t => {
    if (t.sign === "positive") return "nonneg";
    if (t.sign === "negative") return "nonpositive";
    if (t.sign === "nonzero") return "unknown";
    return t.sign;
  },
});

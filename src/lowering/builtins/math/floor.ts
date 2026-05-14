import { defineUnaryRealMath } from "./_unary_real.js";

/** `floor(x)` rounds toward -Inf. Sign rule:
 *   - `positive` input may land on 0 (e.g. `floor(0.5) = 0`), so the
 *     output is `nonneg` (not `positive`).
 *   - `nonneg` / `negative` / `nonpositive` / `zero` all pass through:
 *     `floor(nonneg) >= 0`, `floor(negative) < 0`, etc.
 *   - `nonzero` / `unknown` → `unknown`.
 */
export const floor = defineUnaryRealMath({
  name: "floor",
  cFnReal: "floor",
  jsFn: Math.floor,
  signRule: t => {
    if (t.sign === "positive") return "nonneg";
    if (t.sign === "nonzero") return "unknown";
    return t.sign;
  },
});

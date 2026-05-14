import { defineUnaryRealMath } from "./_unary_real.js";

/** `ceil(x)` rounds toward +Inf. Sign rule mirrors `floor`:
 *   - `negative` input may land on 0 (e.g. `ceil(-0.5) = 0`), so the
 *     output is `nonpositive` (not `negative`).
 *   - `positive` / `nonneg` / `nonpositive` / `zero` all pass through.
 *   - `nonzero` / `unknown` → `unknown`.
 */
export const ceil = defineUnaryRealMath({
  name: "ceil",
  cFnReal: "ceil",
  jsFn: Math.ceil,
  signRule: t => {
    if (t.sign === "negative") return "nonpositive";
    if (t.sign === "nonzero") return "unknown";
    return t.sign;
  },
});

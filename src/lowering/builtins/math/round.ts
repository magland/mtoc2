import { defineUnaryRealMath } from "./_unary_real.js";

/** MATLAB-style `round`: half-away-from-zero (NOT JS `Math.round`, which
 *  rounds half toward +Inf). The compile-time JS fold uses the same
 *  formula numbl uses; the runtime calls a `mtoc2_round_half_away`
 *  helper backed by C99's `round()` (which is half-away-from-zero).
 *
 *  Sign rule:
 *   - `positive` may round to 0 (`round(0.4) = 0`) → `nonneg`.
 *   - `negative` may round to 0 (`round(-0.4) = 0`) → `nonpositive`.
 *   - everything else passes through.
 */
function matlabRound(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

export const round = defineUnaryRealMath({
  name: "round",
  cFnReal: "mtoc2_round_half_away",
  jsFn: matlabRound,
  signRule: t => {
    if (t.sign === "positive") return "nonneg";
    if (t.sign === "negative") return "nonpositive";
    if (t.sign === "nonzero") return "unknown";
    return t.sign;
  },
});

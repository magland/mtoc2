/**
 * Zero-arg numeric constants: `pi`, `eps`, `Inf`/`inf`, `NaN`/`nan`.
 *
 * MATLAB resolves these as function names. Numbl-equivalent: the bare-
 * name read goes through `lowerIdent`, which forwards to the matching
 * 0-arity builtin when the user hasn't shadowed it. A `pi()` paren-form
 * call works for free (standard builtin-call path).
 *
 * `e` is intentionally absent — MATLAB and numbl don't define it
 * either (use `exp(1)`).
 *
 * The C literal is emitted at full IEEE-754 precision (17 significant
 * digits is enough to round-trip every double, but JS's
 * `Number.prototype.toString` already produces the shortest round-trip
 * form, which matches what C `strtod` parses back exactly). For Inf
 * and NaN we use C's `INFINITY` / `NAN` macros from `<math.h>` (already
 * in `BASE_HEADERS`).
 *
 * Shape arg form (`pi(2,3)` to build a tensor of pi-values) is
 * deferred — passing arguments errors with the standard arity message
 * ("expects 0 arg(s)").
 */
import { scalarDouble } from "../../types.js";
import type { Builtin } from "../registry.js";

function constBuiltin(
  name: string,
  value: number,
  sign: "positive" | "unknown",
  cLiteral: string
): Builtin {
  return {
    name,
    arity: 0,
    transfer() {
      return scalarDouble(sign, value);
    },
    codegenC() {
      return cLiteral;
    },
  };
}

export const pi = constBuiltin("pi", Math.PI, "positive", "3.141592653589793");
export const eps = constBuiltin(
  "eps",
  Number.EPSILON,
  "positive",
  "2.220446049250313e-16"
);

/* `INFINITY` and `NAN` come from <math.h> (in BASE_HEADERS). Using the
 * macros (rather than `1.0/0.0` etc.) lets the compiler avoid div-by-
 * zero warnings and matches what numbl prints via its formatter. */
export const Inf = constBuiltin("Inf", Infinity, "positive", "INFINITY");
export const inf = constBuiltin("inf", Infinity, "positive", "INFINITY");
export const NaNBuiltin = constBuiltin("NaN", NaN, "unknown", "NAN");
export const nan = constBuiltin("nan", NaN, "unknown", "NAN");

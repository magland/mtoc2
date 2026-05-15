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
 * `nan` / `NaN` / `Inf` / `inf` also accept the MATLAB shape-constructor
 * form (`nan(3)`, `Inf(2, 3)`, `nan(m, n, p)`) — see `fillConstBuiltin`
 * below. `pi` / `eps` stay strictly 0-arity; passing args errors with
 * the standard arity message.
 */
import { MTOC2_MAX_NDIM, scalarDouble } from "../../types.js";
import type { Builtin } from "../registry.js";
import { defineShapeConstructor } from "../shape/_construct.js";

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
    /** Per-slot is the same literal — no loop-dependent context. Wiring
     *  this lets the fused emitter accept Assigns whose RHS contains
     *  `pi`, `eps`, `Inf`, `NaN`. */
    perSlotC() {
      return cLiteral;
    },
  };
}

/** Build a "constant + shape constructor" builtin for `nan` / `NaN` /
 *  `Inf` / `inf`. The 0-arg call is the scalar constant (same as
 *  `constBuiltin`); the >=1-arg call routes through the shared shape
 *  constructor with `cLiteral` as the C-side fill value. */
function fillConstBuiltin(
  name: string,
  value: number,
  sign: "positive" | "unknown",
  cLiteral: string
): Builtin {
  const shape = defineShapeConstructor(
    name,
    value,
    "mtoc2_tensor_fill_nd",
    "mtoc2_tensor_fill_square",
    { minArgs: 0, cFillValue: cLiteral }
  );
  return {
    name,
    arity: { min: 0, max: MTOC2_MAX_NDIM },
    transfer(argTypes, span) {
      if (argTypes.length === 0) return scalarDouble(sign, value);
      return shape.transfer(argTypes, span);
    },
    codegenC(argsC, argTypes) {
      if (argTypes.length === 0) return cLiteral;
      return shape.codegenC(argsC, argTypes);
    },
    perSlotC(argsC, argTypes) {
      // Per-slot is only invoked by the fused emitter for elementwise
      // ops, where the constant appears as a scalar slot. The shape-
      // constructor (>=1 args) is a tensor producer — A-normalization
      // hoists it out before the fused emitter sees the surrounding
      // expression, so this branch only runs with `argTypes.length === 0`
      // in practice. Forward `cLiteral` unconditionally.
      void argsC;
      void argTypes;
      return cLiteral;
    },
    runtimeDeps: shape.runtimeDeps,
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
export const Inf = fillConstBuiltin("Inf", Infinity, "positive", "INFINITY");
export const inf = fillConstBuiltin("inf", Infinity, "positive", "INFINITY");
export const NaNBuiltin = fillConstBuiltin("NaN", NaN, "unknown", "NAN");
export const nan = fillConstBuiltin("nan", NaN, "unknown", "NAN");

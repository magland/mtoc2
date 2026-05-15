/**
 * toc — read the elapsed wall-clock seconds since `tic`.
 *
 * Two forms:
 *   - `toc` (no args): elapsed since the most recent `tic;`. Uses the
 *     shared `mtoc2_tic_seconds` slot.
 *   - `toc(t0)`: elapsed since the start time `t0` returned by an
 *     earlier `t0 = tic;`. Does not touch the shared slot, so an outer
 *     `tic; ...; toc` pair can wrap an inner handle measurement
 *     without interference.
 *
 * Both forms return a non-negative double (CLOCK_MONOTONIC never goes
 * backwards). Always emits a runtime call — the elapsed value is never
 * known at compile time.
 *
 * The bare-`toc;` ExprStmt print form is NOT handled here — the
 * lowerer special-cases that position to synthesize a direct call to
 * `mtoc2_toc_print` (see `lowerExprStmt` in `lower.ts`). That keeps
 * the value-returning and printing forms cleanly separated.
 */

import { TypeError } from "../../errors.js";
import { isScalarRealNumeric, scalarDouble } from "../../types.js";
import type { Builtin } from "../registry.js";

export const toc: Builtin = {
  name: "toc",
  arity: { min: 0, max: 1 },
  transfer(argTypes, span) {
    if (argTypes.length === 1 && !isScalarRealNumeric(argTypes[0])) {
      throw new TypeError(
        `'toc' tic-handle argument must be a scalar real numeric ` +
          `(the value returned by 'tic'); got ${argTypes[0].kind}`,
        span
      );
    }
    return scalarDouble("nonneg");
  },
  codegenC(argsC) {
    if (argsC.length === 1) return `mtoc2_toc_handle(${argsC[0]})`;
    return "mtoc2_toc()";
  },
  runtimeDeps: ["mtoc2_tic_toc"],
};

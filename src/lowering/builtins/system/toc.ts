/**
 * toc — read the elapsed wall-clock seconds since the most recent
 * `tic`. Returns a non-negative double (CLOCK_MONOTONIC never goes
 * backwards). Always emits a runtime call — the elapsed value is
 * never known at compile time.
 *
 * v1 rejects the tic-handle form (`toc(t0)`) — passing the start
 * time as an argument is a numbl-supported variant that mtoc2
 * doesn't yet implement. Users should call `toc` with no args.
 *
 * The bare-`toc;` ExprStmt print form is NOT handled here — the
 * lowerer special-cases that position to synthesize a direct call to
 * `mtoc2_toc_print` (see `lowerExprStmt` in `lower.ts`). That keeps
 * the value-returning and printing forms cleanly separated.
 */

import { TypeError } from "../../errors.js";
import { scalarDouble } from "../../types.js";
import type { Builtin } from "../registry.js";

export const toc: Builtin = {
  name: "toc",
  arity: 0,
  transfer(argTypes, span) {
    if (argTypes.length !== 0) {
      throw new TypeError(
        `'toc' with a tic-handle argument is not yet supported; ` +
          `use the no-argument form ('tic; ...; toc')`,
        span
      );
    }
    return scalarDouble("nonneg");
  },
  codegenC() {
    return "mtoc2_toc()";
  },
  runtimeDeps: ["mtoc2_tic_toc"],
};

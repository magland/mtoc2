/**
 * tic — start the wall-clock stopwatch.
 *
 * Returns the start time in seconds (matches numbl: `performance.now()
 * / 1000`). The value is a runtime quantity — never folded — so the
 * returned type has no `exact`. `sign` is `positive` (CLOCK_MONOTONIC
 * is monotonically non-decreasing and starts > 0 in every realistic
 * environment).
 *
 * The bare-`tic;` case is just an ExprStmt whose value is discarded;
 * codegen emits `mtoc2_tic();` like any other scalar-returning call.
 * The assigned form `t = tic;` works naturally since the helper
 * returns the start time.
 */

import { scalarDouble } from "../../types.js";
import type { Builtin } from "../registry.js";

export const tic: Builtin = {
  name: "tic",
  arity: 0,
  transfer() {
    return scalarDouble("positive");
  },
  codegenC() {
    return "mtoc2_tic()";
  },
  runtimeDeps: ["mtoc2_tic_toc"],
};

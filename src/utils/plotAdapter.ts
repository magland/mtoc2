/**
 * Plot-record adapter — converts the JSON-shaped `PlotRecord` lines
 * emitted by mtoc2's `mtoc2_plot_dispatch` C runtime into numbl's
 * `PlotInstruction[]`, then ships them through numbl's own
 * `figuresReducer`.
 *
 * The key idea: mtoc2 doesn't reimplement plot semantics. Numbl's
 * [`runtime/plotBuiltinDispatch.ts`](../../../numbl/src/numbl-core/runtime/plotBuiltinDispatch.ts)
 * already knows what arguments `plot` / `surf` / `bar` / `figure` /
 * etc. accept (line specs, name-value pairs, color cycling, tiled
 * layouts, etc.) and turns them into `PlotInstruction` records. We
 * just need to bridge the JSON wire format to the `RuntimeValue[]`
 * shape that dispatch expects.
 *
 * Two helpers:
 *   - `jsonArgToRuntimeValue(arg)` — single-value translation.
 *   - `applyPlotRecord(record, instructions, state)` — full record
 *     translation + dispatch, pushing into `instructions` and
 *     updating `state.holdState` / `state.tiledLayoutState`.
 *
 * `NaN` restoration: the C runtime encodes non-finite scalars as
 * JSON `null` (per ECMA-404). When we materialize a tensor's flat
 * data buffer or a scalar arg, `null` becomes `NaN`. ±Infinity is
 * lossy (both encode as `null`) — a known limitation; mention in
 * the comment so it doesn't become an ambush later.
 */

import { allocFloat64Array } from "../../../numbl/src/numbl-core/executors/jsJit/helpers/alloc.js";
import { RTV } from "../../../numbl/src/numbl-core/runtime/constructors.js";
import type { RuntimeValue } from "../../../numbl/src/numbl-core/runtime/types.js";
import type { PlotInstruction } from "../../../numbl/src/graphics/types.js";
import {
  dispatchPlotBuiltin,
  type PlotDispatchState,
} from "../../../numbl/src/numbl-core/runtime/plotBuiltinDispatch.js";
import type { PlotArg, PlotRecord } from "./wasmRunner.worker";

/** Fresh `PlotDispatchState` for a new viewer session. Matches the
 *  defaults numbl's `Runtime` class uses (`holdState: false`, no
 *  tiled layout). */
export function newPlotDispatchState(): PlotDispatchState {
  return { holdState: false, tiledLayoutState: null };
}

function restoreScalar(v: number | null): number {
  // `null` from JSON.parse came from a non-finite double on the C
  // side. NaN is the most useful restoration: numbl's plot pipeline
  // skips NaN points (the line breaks rather than drawing to the
  // origin). ±Infinity round-trips lossy here — both encode as null.
  return v === null ? NaN : v;
}

/** Translate a single JSON-shaped argument into a numbl `RuntimeValue`. */
export function jsonArgToRuntimeValue(arg: PlotArg): RuntimeValue {
  if (typeof arg === "number" || arg === null) {
    return RTV.num(restoreScalar(arg));
  }
  if (arg.kind === "text") {
    // mtoc2 collapses char and string into one wire kind. MATLAB plot
    // semantics treat them identically (color spec, name-value pair
    // name) — picking RTV.char so numbl's `toString(arg)` helpers
    // strip the surrounding quotes consistently.
    return RTV.char(arg.data);
  }
  // tensor
  const flat = arg.data;
  const buf = allocFloat64Array(flat.length);
  for (let i = 0; i < flat.length; i++) buf[i] = restoreScalar(flat[i]);
  return RTV.tensor(buf, [...arg.dims]);
}

/** Apply one plot-dispatch record: translate its args, run numbl's
 *  shared dispatch, mutate `instructions` and `state`. Returns `true`
 *  if numbl recognized the call name (every name registered by the
 *  mtoc2 lowering should), `false` otherwise (defensive — surfaces
 *  drift between the mtoc2 registration list and numbl's dispatch). */
export function applyPlotRecord(
  record: PlotRecord,
  instructions: PlotInstruction[],
  state: PlotDispatchState
): boolean {
  const args = record.args.map(jsonArgToRuntimeValue);
  return dispatchPlotBuiltin(record.call, args, instructions, state);
}

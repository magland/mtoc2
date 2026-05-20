/**
 * Single bridge module for everything mtoc2 imports from the sibling
 * numbl checkout at `../../../numbl/`. Every `numbl-core/*` (and
 * `graphics/*`) path mtoc2 depends on appears here exactly once, so:
 *
 * - `grep -r "numbl-core" src/` shows ONE file (this one);
 * - a numbl rename / move surfaces as a single tsc error in this file
 *   rather than scattering across consumer call sites;
 * - the surface area is visible at a glance for audit and porting
 *   work.
 *
 * The pinned numbl SHA lives in `NUMBL_VERSION` (which CI consults to
 * pick the checkout ref). Structural drift caught at `tsc` time;
 * semantic drift caught by the cross-runner. See `parser/index.ts`
 * for the historic parser-only bridge, which now re-exports through
 * this module so existing consumer paths stay unchanged.
 */

// ── Parser (AST shape, lexer dispatch, operator enums) ──────────────────

export {
  parseMFile,
  SyntaxError,
  BinaryOperation,
  UnaryOperation,
} from "../../../numbl/src/numbl-core/parser/index.js";

export type {
  Span,
  Expr,
  Stmt,
  LValue,
  AbstractSyntaxTree,
} from "../../../numbl/src/numbl-core/parser/index.js";

// ── Resolver / lowering context (workspace function dispatch) ───────────

export { LoweringContext } from "../../../numbl/src/numbl-core/lowering/loweringContext.js";
export { resolveFunction } from "../../../numbl/src/numbl-core/functionResolve.js";

export type { CallSite } from "../../../numbl/src/numbl-core/runtime/runtimeHelpers.js";
export type { ItemType } from "../../../numbl/src/numbl-core/lowering/itemTypes.js";
export type { ClassInfo } from "../../../numbl/src/numbl-core/lowering/classInfo.js";

// ── Plot dispatch (cross-runner protocol + accepted name set) ───────────

export { PLOT_ALL_NAMES } from "../../../numbl/src/numbl-core/runtime/plotBuiltinDispatch.js";
export {
  dispatchPlotBuiltin,
  type PlotDispatchState,
} from "../../../numbl/src/numbl-core/runtime/plotBuiltinDispatch.js";

export type { PlotInstruction } from "../../../numbl/src/graphics/types.js";

// ── Runtime value model (used by the plot adapter) ──────────────────────

export { allocFloat64Array } from "../../../numbl/src/numbl-core/executors/jsJit/helpers/alloc.js";
export { RTV } from "../../../numbl/src/numbl-core/runtime/constructors.js";
export type { RuntimeValue } from "../../../numbl/src/numbl-core/runtime/types.js";

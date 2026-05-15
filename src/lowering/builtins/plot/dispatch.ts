/**
 * Plot dispatch — every plotting builtin (`plot`, `surf`, `imagesc`,
 * `bar`, `figure`, `hold`, `xlabel`, …) shares a single lowering.
 * Numbl handles plotting by accumulating an in-memory instruction
 * stream that a separate viewer renders; mtoc2 mirrors that on the
 * wire by emitting one line of JSON per call, prefixed with the
 * `\x1emtoc2:plot\t` sentinel (see `plot_dispatch.h` for the wire
 * shape and `scripts/run_test_scripts.ts` for the cross-runner drop).
 *
 * Per-name C code is zero — every name reuses
 * `mtoc2_plot_dispatch` with the name string baked in as the
 * leading arg. The set of accepted names is imported directly from
 * numbl (`PLOT_ALL_NAMES` in
 * [plotBuiltinDispatch.ts](../../../../../numbl/src/numbl-core/runtime/plotBuiltinDispatch.ts)),
 * which is the single source of truth. When numbl adds a new
 * plotting builtin — renderable or no-op stub — mtoc2 accepts it at
 * the next `tsc` run with no edit here; conversely, names not in
 * `PLOT_ALL_NAMES` raise `UnsupportedConstruct` at lowering, an
 * honest signal that numbl can't render or stub them.
 *
 * Type rules:
 *   - Variadic arity (0..64), matching numbl's `varargin` stubs.
 *   - Args must be scalar real numeric / text / real multi-element
 *     tensor — same set fprintf accepts (complex / struct / class /
 *     handle / Void / Unknown rejected at lowering).
 *   - Result is `Void` — these builtins are statement-only in v1.
 *     Numbl's value-returning variants (`h = gcf`, `lim = xlim`,
 *     etc.) are not supported here; assign forms surface a clean
 *     "cannot consume Void as a value" error. Users that need a
 *     return value should fall back to numbl for that program.
 *
 * MATLAB command syntax (`hold on`, `figure 1`) isn't supported —
 * mtoc2's parser routes those as bare identifiers, which has no
 * generic "treat next token as char arg" support. Use the
 * function-call form: `hold('on')`, `figure(1)`.
 */

import { VOID } from "../../types.js";
import type { Builtin } from "../registry.js";
import {
  emitFormatSlot,
  emitFormatSlotArray,
  validateFormatArgs,
} from "../io/_format_args.js";
import { PLOT_ALL_NAMES } from "../../../../../numbl/src/numbl-core/runtime/plotBuiltinDispatch.js";

/** Source-level names that route through `mtoc2_plot_dispatch`.
 *  Authoritative list lives in numbl (see file header); we re-bind
 *  locally only so the rest of this module is self-contained. */
const PLOT_BUILTIN_NAMES: ReadonlyArray<string> = PLOT_ALL_NAMES;

/** JSON-escape a builtin name for inclusion as the first arg to
 *  `mtoc2_plot_dispatch`. Plot names are ASCII identifiers, but the
 *  escape stays defensive — a future plot name like `print` (where
 *  a backslash would be invalid C anyway) doesn't surprise us. */
function escapeCStringLiteral(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ch === "\\" || ch === '"') {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  return out;
}

function makePlotBuiltin(name: string): Builtin {
  const cName = escapeCStringLiteral(name);
  return {
    name,
    arity: { min: 0, max: 64 },
    transfer(argTypes, span) {
      validateFormatArgs(name, argTypes, 0, span);
      return VOID;
    },
    codegenC(argsC, argTypes) {
      const slots: string[] = [];
      for (let i = 0; i < argTypes.length; i++) {
        slots.push(emitFormatSlot(name, argsC[i], argTypes[i], i));
      }
      return `mtoc2_plot_dispatch("${cName}", ${slots.length}, ${emitFormatSlotArray(slots)})`;
    },
    runtimeDeps: ["mtoc2_plot_dispatch"],
  };
}

export const plotBuiltins: ReadonlyArray<Builtin> =
  PLOT_BUILTIN_NAMES.map(makePlotBuiltin);

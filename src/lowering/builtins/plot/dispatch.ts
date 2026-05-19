/**
 * Plot dispatch — every plotting builtin (`plot`, `surf`, `imagesc`,
 * `bar`, `figure`, `hold`, `xlabel`, …) shares a single lowering.
 */

import { UnsupportedConstruct } from "../../errors.js";
import { VOID } from "../../types.js";
import type { Builtin } from "../registry.js";
import {
  emitFormatSlot,
  emitFormatSlotArray,
  validateFormatArgs,
} from "../io/_format_args.js";
import { PLOT_ALL_NAMES } from "../../../../../numbl/src/numbl-core/runtime/plotBuiltinDispatch.js";

const PLOT_BUILTIN_NAMES: ReadonlyArray<string> = PLOT_ALL_NAMES;

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
    transfer(argTypes, nargout) {
      if (nargout !== 1) {
        throw new UnsupportedConstruct(
          `'${name}' does not support multi-output (nargout=${nargout})`
        );
      }
      validateFormatArgs(name, argTypes, 0);
      return [VOID];
    },
    emitC({ argsC, argTypes, useRuntime }) {
      useRuntime("mtoc2_plot_dispatch");
      const slots: string[] = [];
      for (let i = 0; i < argTypes.length; i++) {
        slots.push(emitFormatSlot(name, argsC[i], argTypes[i], i));
      }
      return `mtoc2_plot_dispatch("${cName}", ${slots.length}, ${emitFormatSlotArray(slots)})`;
    },
  };
}

export const plotBuiltins: ReadonlyArray<Builtin> =
  PLOT_BUILTIN_NAMES.map(makePlotBuiltin);

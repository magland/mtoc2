import { TypeError } from "../../errors.js";
import { isText, typeToString, type Type } from "../../types.js";
import type { Builtin } from "../registry.js";
import {
  emitFormatSlot,
  emitFormatSlotArray,
  emitTextView,
  validateFormatArgs,
} from "./_format_args.js";

/** `sprintf(fmt, args...)` — return the formatted text as an owned
 *  value.
 *
 *  Shape rule (mirrors numbl):
 *   - char-typed format (`'fmt'`)  → returns `Char`
 *   - string-typed format (`"fmt"`) → returns `String`
 *
 *  The kind is decided statically by the format arg's lattice type;
 *  codegen picks the matching runtime entry point. v1 requires the
 *  format to be a `Char` or `String` (rejects opaque or non-text); the
 *  format's lattice kind drives output typing. */
export const sprintfBuiltin: Builtin = {
  name: "sprintf",
  arity: { min: 1, max: 64 },
  transfer(argTypes, span): Type {
    if (argTypes.length === 0) {
      throw new TypeError(`'sprintf' requires at least a format arg`, span);
    }
    const fmt = argTypes[0];
    if (!isText(fmt)) {
      throw new TypeError(
        `'sprintf' first arg must be char or string (got ${typeToString(fmt)})`,
        span
      );
    }
    validateFormatArgs("sprintf", argTypes, 1, span);
    return fmt.kind === "String" ? { kind: "String" } : { kind: "Char" };
  },
  codegenC(argsC, argTypes) {
    const fmt = argTypes[0];
    const fmtView = emitTextView(argsC[0], fmt);
    const slots: string[] = [];
    for (let i = 1; i < argTypes.length; i++) {
      slots.push(emitFormatSlot("sprintf", argsC[i], argTypes[i], i));
    }
    const fn =
      fmt.kind === "String" ? "mtoc2_sprintf_str" : "mtoc2_sprintf_char";
    return `${fn}(${fmtView}, ${slots.length}, ${emitFormatSlotArray(slots)})`;
  },
  runtimeDeps: ["mtoc2_sprintf_str", "mtoc2_sprintf_char"],
};

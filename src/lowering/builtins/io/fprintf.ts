import { TypeError, UnsupportedConstruct } from "../../errors.js";
import { isNumeric, isText, typeToString } from "../../types.js";
import type { Builtin } from "../registry.js";
import {
  emitFormatSlot,
  emitFormatSlotArray,
  emitTextView,
  validateFormatArgs,
} from "./_format_args.js";

/** `fprintf(fmt, args...)` — format text to stdout.
 *
 *  v1 scope:
 *   - The format arg must be a `Char` or `String` (the literal form is
 *     the common case; an opaque variable works too).
 *   - Trailing args may be scalar real numeric, text, or real
 *     multi-element tensors. Complex / Void / Unknown / function-handle
 *     / cell / struct / class instance args are rejected with a span.
 *   - The optional leading-fid form (`fprintf(1, fmt, ...)` /
 *     `fprintf(2, fmt, ...)`) is deferred — pass the format as the
 *     first arg. (Numbl routes fid 1 and 2 both to its `output` stream,
 *     so dropping the fid loses no chunkie_simple behavior.)
 *
 *  Return: numbl returns the byte count when `nargout >= 1` and
 *  nothing otherwise. mtoc2 v1 supports only the statement form (no
 *  value), so the transfer returns `Void`. */
export const fprintf: Builtin = {
  name: "fprintf",
  arity: { min: 1, max: 64 },
  transfer(argTypes, span) {
    if (argTypes.length === 0) {
      throw new TypeError(`'fprintf' requires at least a format arg`, span);
    }
    const fmt = argTypes[0];
    if (isNumeric(fmt)) {
      throw new UnsupportedConstruct(
        `'fprintf' with a leading fid (e.g. fprintf(1, fmt, ...)) is not ` +
          `yet supported — pass the format as the first arg`,
        span
      );
    }
    if (!isText(fmt)) {
      throw new TypeError(
        `'fprintf' first arg must be a char or string format (got ${typeToString(fmt)})`,
        span
      );
    }
    validateFormatArgs("fprintf", argTypes, 1, span);
    return { kind: "Void" };
  },
  codegenC(argsC, argTypes) {
    const fmtView = emitTextView(argsC[0], argTypes[0]);
    const slots: string[] = [];
    for (let i = 1; i < argTypes.length; i++) {
      slots.push(emitFormatSlot("fprintf", argsC[i], argTypes[i], i));
    }
    return `mtoc2_fprintf(stdout, ${fmtView}, ${slots.length}, ${emitFormatSlotArray(slots)})`;
  },
  runtimeDeps: ["mtoc2_fprintf"],
};

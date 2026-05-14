import { TypeError, UnsupportedConstruct } from "../../errors.js";
import { isText, typeToString } from "../../types.js";
import type { Builtin } from "../registry.js";
import {
  emitFormatSlot,
  emitFormatSlotArray,
  emitTextView,
  validateFormatArgs,
} from "./_format_args.js";

/** Numbl/MATLAB error identifier shape: `Component:Mnemonic` with one
 *  or more colon-separated word segments, each starting with a letter.
 *  Mirrors numbl's regex in interpreter/builtins/utility.ts so we
 *  classify the `error(id, fmt, ...)` form identically. */
const MATLAB_ID_REGEX = /^[A-Za-z]\w*(:[A-Za-z]\w*)+$/;

/** `error(...)` — write the formatted message to stderr and abort.
 *
 *  Three shapes (matching numbl):
 *   - `error(msg)`            — `msg` is the message; no format args.
 *   - `error(fmt, args...)`   — `fmt` is the format; remaining args
 *                               feed the format spec stream.
 *   - `error(id, fmt, ...)`   — first arg is a MATLAB error id
 *                               (matches `Comp:Mn`); second is the
 *                               format; rest are args.
 *
 *  Resolution: if the first arg's exact string matches the id regex
 *  AND there's at least one more arg, we treat the first arg as an id
 *  and the second as the format. The id is NOT emitted in the stderr
 *  output (numbl uses it only as metadata on the thrown RuntimeError;
 *  the printed message is the formatted body).
 *
 *  v1 requires the first arg to have an exact value (the literal form),
 *  so the id-vs-fmt decision is made at lowering. Opaque first args
 *  are rejected with `UnsupportedConstruct`; defer to a follow-up if
 *  the test corpus ever needs them. */
export const errorBuiltin: Builtin = {
  name: "error",
  arity: { min: 1, max: 64 },
  transfer(argTypes, span) {
    if (argTypes.length === 0) {
      throw new TypeError(`'error' requires at least 1 arg`, span);
    }
    const first = argTypes[0];
    if (!isText(first)) {
      throw new TypeError(
        `'error' first arg must be char or string (got ${typeToString(first)})`,
        span
      );
    }
    const firstExact =
      first.kind === "Char" || first.kind === "String"
        ? first.exact
        : undefined;
    if (firstExact === undefined) {
      throw new UnsupportedConstruct(
        `'error' first arg must be a literal text value in v1 (so the ` +
          `id-vs-format decision can be resolved at compile time)`,
        span
      );
    }
    let fmtIdx = 0;
    if (argTypes.length >= 2 && MATLAB_ID_REGEX.test(firstExact)) {
      fmtIdx = 1;
    }
    const fmt = argTypes[fmtIdx];
    if (!isText(fmt)) {
      throw new TypeError(
        `'error' format arg must be char or string (got ${typeToString(fmt)})`,
        span
      );
    }
    validateFormatArgs("error", argTypes, fmtIdx + 1, span);
    return { kind: "Void" };
  },
  codegenC(argsC, argTypes) {
    const first = argTypes[0];
    const firstExact =
      first.kind === "Char" || first.kind === "String"
        ? first.exact
        : undefined;
    let fmtIdx = 0;
    if (
      argTypes.length >= 2 &&
      firstExact !== undefined &&
      MATLAB_ID_REGEX.test(firstExact)
    ) {
      fmtIdx = 1;
    }
    const fmtView = emitTextView(argsC[fmtIdx], argTypes[fmtIdx]);
    const slots: string[] = [];
    for (let i = fmtIdx + 1; i < argTypes.length; i++) {
      slots.push(emitFormatSlot("error", argsC[i], argTypes[i], i));
    }
    return `mtoc2_error_fmt(${fmtView}, ${slots.length}, ${emitFormatSlotArray(slots)})`;
  },
  runtimeDeps: ["mtoc2_error_fmt"],
};

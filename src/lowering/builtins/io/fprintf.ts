import { TypeError, UnsupportedConstruct } from "../../errors.js";
import {
  isMultiElement,
  isNumeric,
  isScalarRealNumeric,
  isText,
  typeToString,
} from "../../types.js";
import type { Builtin } from "../registry.js";

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
    for (let i = 1; i < argTypes.length; i++) {
      const a = argTypes[i];
      if (isText(a)) continue;
      if (isNumeric(a)) {
        if (a.isComplex) {
          throw new UnsupportedConstruct(
            `'fprintf' on a complex arg is not yet supported`,
            span
          );
        }
        if (a.elem !== "double" && a.elem !== "logical") {
          throw new UnsupportedConstruct(
            `'fprintf' on a '${a.elem}' arg is not yet supported`,
            span
          );
        }
        continue;
      }
      throw new TypeError(
        `'fprintf' arg ${i + 1} must be numeric or text (got ${typeToString(a)})`,
        span
      );
    }
    return { kind: "Void" };
  },
  codegenC(argsC, argTypes) {
    const fmtT = argTypes[0];
    const fmtView =
      fmtT.kind === "String"
        ? `mtoc2_text_from_string(${argsC[0]})`
        : `mtoc2_text_from_char_tensor(${argsC[0]})`;
    const slots: string[] = [];
    for (let i = 1; i < argTypes.length; i++) {
      const t = argTypes[i];
      const c = argsC[i];
      if (t.kind === "String") {
        slots.push(`{.kind = 3, .u = {.t = mtoc2_text_from_string(${c})}}`);
      } else if (t.kind === "Char") {
        slots.push(
          `{.kind = 3, .u = {.t = mtoc2_text_from_char_tensor(${c})}}`
        );
      } else if (isScalarRealNumeric(t)) {
        slots.push(`{.kind = 1, .u = {.d = (double)(${c})}}`);
      } else if (isNumeric(t) && isMultiElement(t)) {
        // ANF in lower.ts hoists every multi-element non-Var into a temp,
        // so `c` is a bare identifier (lvalue). Take its address for the
        // tensor slot.
        slots.push(`{.kind = 4, .u = {.tensor = &${c}}}`);
      } else {
        // transfer already rejected unsupported kinds, so this is
        // defensive.
        throw new Error(
          `internal: fprintf arg ${i + 1} reached codegen with unsupported type ${t.kind}`
        );
      }
    }
    const n = slots.length;
    // The compound-literal-array form keeps the call a single expression
    // even for variadic counts. Use `{ {0} }` for n=0 since C requires
    // a non-empty array (zero-length arrays are a GNU extension).
    const argsLit =
      n === 0
        ? `(const mtoc2_fprintf_arg_t[]){ {0} }`
        : `(const mtoc2_fprintf_arg_t[]){ ${slots.join(", ")} }`;
    return `mtoc2_fprintf(stdout, ${fmtView}, ${n}, ${argsLit})`;
  },
  runtimeDeps: ["mtoc2_fprintf"],
};

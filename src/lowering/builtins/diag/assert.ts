/**
 * `assert(cond)` / `assert(cond, msg)` / `assert(cond, fmt, args...)` —
 * runtime + compile-time assertion.
 *
 * Numbl reference: `interpreter/builtins/utility.ts:151`. For
 * scalar/numeric conds the truth check is `v !== 0 && !isNaN(v)`;
 * for tensors, every element must be non-zero and non-NaN AND the
 * tensor must be non-empty.
 *
 * v1 scope:
 *   - cond is a scalar real numeric (double or logical).
 *   - msg may be omitted, a literal text value, or a literal format
 *     plus printf args. The printf-style form routes through the
 *     shared format engine via `mtoc2_assert_scalar_fmt`.
 *
 * Compile-time fold:
 *   - cond is exact-known truthy → emit nothing (no-op).
 *   - cond is exact-known falsy → throw TypeError at lowering time
 *     ("assertion failed at compile time: <msg>"). Catches accidental
 *     `assert(false, '...')` early.
 *
 * Tensor-cond support (numbl: "every element nonzero and non-NaN")
 * is a small followup once we need it — chunkie_simple's only
 * `assert` call is a scalar comparison.
 *
 * Returns `Unknown` — the result is never consumed and the call only
 * makes sense as the expression of an `ExprStmt`.
 */

import { TypeError, UnsupportedConstruct } from "../../errors.js";
import { isNumeric, isScalar, isText, typeToString } from "../../types.js";
import type { Builtin } from "../registry.js";
import { exactDouble } from "../_shared.js";
import {
  emitFormatSlot,
  emitFormatSlotArray,
  emitTextView,
  validateFormatArgs,
} from "../io/_format_args.js";

export const assert: Builtin = {
  name: "assert",
  arity: { min: 1, max: 64 },
  transfer(argTypes, span) {
    const cond = argTypes[0];
    if (!isNumeric(cond)) {
      throw new TypeError(
        `'assert' first arg must be numeric (got ${typeToString(cond)})`,
        span
      );
    }
    if (cond.isComplex) {
      throw new TypeError(`'assert' on complex cond is not supported`, span);
    }
    if (!isScalar(cond)) {
      throw new UnsupportedConstruct(
        `'assert' on a tensor cond is not yet supported in mtoc2 v1 ` +
          `(numbl tests every element non-zero and non-NaN); pass a scalar predicate instead`,
        span
      );
    }
    if (argTypes.length >= 2) {
      const m = argTypes[1];
      if (!isText(m)) {
        throw new UnsupportedConstruct(
          `'assert' message must be char or string (got ${typeToString(m)})`,
          span
        );
      }
      validateFormatArgs("assert", argTypes, 2, span);
    }

    // Compile-time fold.
    const v = exactDouble(cond);
    if (v !== undefined) {
      const truthy = v !== 0 && !Number.isNaN(v);
      if (!truthy) {
        const m = argTypes.length >= 2 ? argTypes[1] : undefined;
        const msgPart =
          m && (m.kind === "String" || m.kind === "Char")
            ? `: ${m.exact ?? "(opaque)"}`
            : "";
        throw new TypeError(`'assert' is statically false${msgPart}`, span);
      }
      // truthy → emit nothing
    }

    return { kind: "Unknown" };
  },
  codegenC(argsC, argTypes) {
    const cond = argTypes[0];
    if (isNumeric(cond) && exactDouble(cond) !== undefined) {
      // Truthy-exact reaches codegen — emit a no-op (the transfer
      // would have thrown on falsy-exact).
      return `((void)0)`;
    }
    const condC = `(double)(${argsC[0]})`;
    if (argTypes.length < 2) {
      return `mtoc2_assert_scalar(${condC}, (const char *)0)`;
    }
    // 2-arg form with a literal text message and no format args: keep
    // the bare-string fast path so simple `assert(cond, 'msg')` calls
    // don't activate the whole format engine.
    if (argTypes.length === 2) {
      const m = argTypes[1];
      if ((m.kind === "Char" || m.kind === "String") && m.exact !== undefined) {
        return `mtoc2_assert_scalar(${condC}, ${JSON.stringify(m.exact)})`;
      }
    }
    // 3+ args, or 2-arg with an opaque text variable: route through
    // the format engine.
    const fmtView = emitTextView(argsC[1], argTypes[1]);
    const slots: string[] = [];
    for (let i = 2; i < argTypes.length; i++) {
      slots.push(emitFormatSlot("assert", argsC[i], argTypes[i], i));
    }
    return `mtoc2_assert_scalar_fmt(${condC}, ${fmtView}, ${slots.length}, ${emitFormatSlotArray(slots)})`;
  },
  runtimeDeps: ["mtoc2_assert_scalar", "mtoc2_assert_scalar_fmt"],
};

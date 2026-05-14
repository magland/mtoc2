/**
 * `assert(cond)` / `assert(cond, msg)` — runtime + compile-time
 * assertion.
 *
 * Numbl reference: `interpreter/builtins/utility.ts:151`. For
 * scalar/numeric conds the truth check is `v !== 0 && !isNaN(v)`;
 * for tensors, every element must be non-zero and non-NaN AND the
 * tensor must be non-empty.
 *
 * v1 scope:
 *   - cond is a scalar real numeric (double or logical).
 *   - optional msg is a string literal (numbl's `'…'` / `"…"`).
 *     `assert(cond, fmt, ...)` printf-style is deferred.
 *
 * Compile-time fold:
 *   - cond is exact-known truthy → emit nothing (no-op).
 *   - cond is exact-known falsy → throw TypeError at lowering time
 *     ("assertion failed at compile time: <msg>"). Catches accidental
 *     `assert(false, '...')` early, mirroring how the language treats
 *     a static contradiction.
 *
 * Tensor-cond support (numbl: "every element nonzero and non-NaN")
 * is a small followup once we need it — chunkie_simple's only
 * `assert` call is a scalar comparison.
 *
 * Returns `Unknown` (same as `disp`) — the result is never consumed
 * and the call only makes sense as the expression of an `ExprStmt`.
 */

import { TypeError, UnsupportedConstruct } from "../../errors.js";
import { isNumeric, isScalar, typeToString } from "../../types.js";
import type { Builtin } from "../registry.js";
import { exactDouble } from "../_shared.js";

export const assert: Builtin = {
  name: "assert",
  arity: { min: 1, max: 2 },
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

    if (argTypes.length === 2) {
      const m = argTypes[1];
      if (m.kind !== "String") {
        throw new UnsupportedConstruct(
          `'assert' message must be a string literal in v1 ` +
            `(got ${typeToString(m)}); printf-style \`assert(cond, fmt, ...)\` is a followup`,
          span
        );
      }
    }

    // Compile-time fold.
    const v = exactDouble(cond);
    if (v !== undefined) {
      const truthy = v !== 0 && !Number.isNaN(v);
      if (!truthy) {
        const msgPart =
          argTypes.length === 2 && argTypes[1].kind === "String"
            ? `: ${argTypes[1].exact ?? "(empty)"}`
            : "";
        throw new TypeError(`'assert' is statically false${msgPart}`, span);
      }
      // truthy → emit nothing
    }

    return { kind: "Unknown" };
  },
  codegenC(argsC, argTypes) {
    // Compile-time-truthy case: the transfer step folds successfully
    // without throwing; we want no runtime check. The emit pipeline
    // expects an expression here, so emit a benign `(void)0`.
    const cond = argTypes[0];
    if (isNumeric(cond) && exactDouble(cond) !== undefined) {
      // The transfer would have thrown on falsy-exact; truthy-exact
      // reaches us — emit a no-op.
      return `((void)0)`;
    }
    const msgArg =
      argTypes.length === 2 && argTypes[1].kind === "String"
        ? JSON.stringify(argTypes[1].exact ?? "")
        : `(const char *)0`;
    return `mtoc2_assert_scalar((double)(${argsC[0]}), ${msgArg})`;
  },
  runtimeDeps: ["mtoc2_assert_scalar"],
};

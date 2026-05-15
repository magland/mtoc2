/**
 * Shared scaffold for the two short-circuit logical builtins
 * (`||` → `oror`, `&&` → `andand`).
 *
 * **Scope decision: scalar operands only.**
 *
 * MATLAB requires scalar operands for `||` and `&&`; numbl is more
 * permissive (routes both operands through `toBool` to accept
 * tensors — see `interpreter/interpreterExec.ts` lines 650–661,
 * `runtime/convert.ts:44`). mtoc2 v1 takes the MATLAB-strict path so
 * the result type stays a scalar logical and the codegen stays
 * trivial (`(a) || (b)` / `(a) && (b)` in C, which short-circuits
 * natively).
 *
 * Compile-time fold:
 *   - both operands exact → fold to scalar logical with concrete value.
 *   - LHS exact + truthy (for `||`) or falsy (for `&&`) → result is
 *     the LHS's logical value regardless of RHS. This honors
 *     short-circuit semantics at the type level so a runtime-only RHS
 *     doesn't pollute the result type. (mtoc2 always evaluates the
 *     RHS at the type-system layer, but the fold value still skips
 *     it.)
 *   - otherwise → scalar logical, no exact.
 *
 * **The runtime side already short-circuits** via C's `||` / `&&`
 * operators, independent of the fold rule.
 */

import { TypeError } from "../../errors.js";
import {
  isNumeric,
  isScalar,
  scalarLogical,
  typeToString,
} from "../../types.js";
import type { Builtin } from "../registry.js";
import { exactDouble, exactScalarAsComplex } from "../_shared.js";

export type ShortCircuitKind = "or" | "and";

function asScalarRealOrLogical(
  t: import("../../types.js").Type,
  what: string,
  surface: string,
  span: import("../../types.js").Span
): void {
  if (!isNumeric(t)) {
    throw new TypeError(
      `${what} must be a real or complex scalar (got ${typeToString(t)}); ` +
        `'${surface}' requires scalar operands (numbl accepts tensors via toBool, but mtoc2 follows MATLAB)`,
      span
    );
  }
  if (t.elem !== "double" && t.elem !== "logical") {
    throw new TypeError(
      `${what} must be a real double or logical (got ${t.elem})`,
      span
    );
  }
  if (!isScalar(t)) {
    throw new TypeError(
      `${what} must be a scalar (got ${typeToString(t)}); ` +
        `'${surface}' requires scalar operands (numbl accepts tensors via toBool, but mtoc2 follows MATLAB — use elementwise '|' / '&' when added)`,
      span
    );
  }
}

/** Truthy as numbl/MATLAB define it. Complex is truthy iff either
 *  part is non-zero. Returns `undefined` when the value isn't exact. */
function scalarTruthy(t: import("../../types.js").Type): boolean | undefined {
  if (!isNumeric(t)) return undefined;
  if (t.isComplex) {
    const cx = exactScalarAsComplex(t);
    if (cx === undefined) return undefined;
    return cx.re !== 0 || cx.im !== 0;
  }
  const v = exactDouble(t);
  if (v === undefined) return undefined;
  return v !== 0;
}

export function defineShortCircuit(
  name: string,
  surface: string,
  kind: ShortCircuitKind
): Builtin {
  const cOp = kind === "or" ? "||" : "&&";
  return {
    name,
    arity: 2,
    transfer(argTypes, span) {
      asScalarRealOrLogical(
        argTypes[0],
        `'${surface}' left operand`,
        surface,
        span
      );
      asScalarRealOrLogical(
        argTypes[1],
        `'${surface}' right operand`,
        surface,
        span
      );
      const at = scalarTruthy(argTypes[0]);
      const bt = scalarTruthy(argTypes[1]);
      if (kind === "or") {
        if (at === true) return scalarLogical(true);
        if (at !== undefined && bt !== undefined) return scalarLogical(bt);
        return scalarLogical();
      }
      // and: LHS exact + falsy short-circuits to false.
      if (at === false) return scalarLogical(false);
      if (at !== undefined && bt !== undefined) return scalarLogical(bt);
      return scalarLogical();
    },
    codegenC(argsC, argTypes) {
      const lhs = (argTypes[0] as import("../../types.js").NumericType)
        .isComplex
        ? `mtoc2_cnonzero(${argsC[0]})`
        : `(${argsC[0]})`;
      const rhs = (argTypes[1] as import("../../types.js").NumericType)
        .isComplex
        ? `mtoc2_cnonzero(${argsC[1]})`
        : `(${argsC[1]})`;
      // C's `||` / `&&` short-circuit and yield 0/1; cast to double
      // so the scalar slot matches the logical-as-double convention.
      return `((double)(${lhs} ${cOp} ${rhs}))`;
    },
    runtimeDeps: ["mtoc2_cscalar"],
  };
}

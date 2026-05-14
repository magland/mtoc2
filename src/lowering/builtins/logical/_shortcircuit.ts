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
import { exactDouble } from "../_shared.js";

export type ShortCircuitKind = "or" | "and";

function asScalarRealOrLogical(
  t: import("../../types.js").Type,
  what: string,
  surface: string,
  span: import("../../types.js").Span
): void {
  if (!isNumeric(t)) {
    throw new TypeError(
      `${what} must be a real scalar (got ${typeToString(t)}); ` +
        `'${surface}' requires scalar operands (numbl accepts tensors via toBool, but mtoc2 follows MATLAB)`,
      span
    );
  }
  if (t.isComplex) {
    throw new TypeError(
      `${what} must be a real scalar (got complex); '${surface}' on complex is not supported`,
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
      const ax = exactDouble(argTypes[0]);
      const bx = exactDouble(argTypes[1]);
      if (kind === "or") {
        // LHS exact + truthy short-circuits to true.
        if (ax !== undefined && ax !== 0) return scalarLogical(true);
        if (ax !== undefined && bx !== undefined)
          return scalarLogical(bx !== 0);
        return scalarLogical();
      }
      // and: LHS exact + falsy short-circuits to false.
      if (ax !== undefined && ax === 0) return scalarLogical(false);
      if (ax !== undefined && bx !== undefined) return scalarLogical(bx !== 0);
      return scalarLogical();
    },
    codegenC(argsC) {
      // C's `||` / `&&` short-circuit and yield 0/1; cast to double
      // so the scalar slot matches the logical-as-double convention.
      return `((double)((${argsC[0]}) ${cOp} (${argsC[1]})))`;
    },
  };
}

/**
 * Map a runtime value back into a Type. Used by the interpreter to
 * feed `argTypes` into a builtin's `transfer` (for validation) and
 * `call` (for type-dispatched implementations) — so that the three
 * hooks (`emitC`, `emitJs`, `call`) all branch on the same `argTypes`
 * shape rather than reinventing dispatch per-backend.
 */

import {
  scalarDouble,
  scalarLogical,
  signFromNumber,
  tensorDouble,
  UNKNOWN,
  type Type,
} from "../lowering/types.js";
import { isChar, isTensor, type RuntimeValue } from "./value.js";

export function inferTypeFromValue(v: RuntimeValue): Type {
  if (typeof v === "number") return scalarDouble(signFromNumber(v), v);
  if (typeof v === "boolean") return scalarLogical(v);
  if (typeof v === "string") return { kind: "String", exact: v };
  if (isChar(v)) return { kind: "Char", exact: v.value };
  if (isTensor(v)) {
    // Carry shape only — runtime values typically aren't statically
    // constant, and the interpreter doesn't need exact-array folding.
    return tensorDouble(v.shape.slice());
  }
  return UNKNOWN;
}

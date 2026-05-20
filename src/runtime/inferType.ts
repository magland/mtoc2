/**
 * Map a runtime value back into a Type. Used by the interpreter to
 * feed `argTypes` into a builtin's `transfer` (for validation) and
 * `call` (for type-dispatched implementations) — so that the three
 * hooks (`emitC`, `emitJs`, `call`) all branch on the same `argTypes`
 * shape rather than reinventing dispatch per-backend.
 */

import {
  EXACT_ARRAY_MAX_ELEMENTS,
  scalarDouble,
  scalarLogical,
  scalarComplex,
  signFromNumber,
  tensorDouble,
  UNKNOWN,
  type Type,
} from "../lowering/types.js";
import {
  isChar,
  isComplexValue,
  isTensor,
  type RuntimeValue,
} from "./value.js";

export function inferTypeFromValue(v: RuntimeValue): Type {
  if (typeof v === "number") return scalarDouble(signFromNumber(v), v);
  if (typeof v === "boolean") return scalarLogical(v);
  if (typeof v === "string") return { kind: "String", exact: v };
  if (isChar(v)) return { kind: "Char", exact: v.value };
  if (isTensor(v)) {
    // Carry the data as `exact` when it fits the lattice's cap so
    // dim-vector-consuming builtins (`zeros(size(xs))`,
    // `reshape(A, [r c])`, `sum(v, ...)` with a vector dim, …) can
    // read the runtime values via the same `exactRealArray` path
    // c-aot uses. Above the cap we fall back to shape-only.
    if (v.data.length <= EXACT_ARRAY_MAX_ELEMENTS) {
      return tensorDouble(v.shape.slice(), new Float64Array(v.data));
    }
    return tensorDouble(v.shape.slice());
  }
  if (isComplexValue(v)) {
    return scalarComplex({ re: v.re, im: v.im });
  }
  if (typeof v === "object" && v !== null) {
    // Struct: infer per-field types recursively. The interpreter
    // dispatches builtins by argType, so a struct value needs a
    // matching `Struct`-kind type for `disp(s)` / member loads to
    // route through the right paths.
    const fields: { name: string; ty: Type }[] = [];
    for (const k of Object.keys(v as Record<string, RuntimeValue>)) {
      fields.push({
        name: k,
        ty: inferTypeFromValue((v as Record<string, RuntimeValue>)[k]),
      });
    }
    return { kind: "Struct", fields };
  }
  return UNKNOWN;
}

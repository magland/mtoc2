/**
 * Builtins package. Each builtin lives in its own file and is registered
 * here via `registerBuiltin`. Public API:
 *
 *  - `getBuiltin(name)` / `allBuiltinNames()` for runtime lookup.
 *  - `binaryOpBuiltin(op)` / `unaryOpBuiltin(op)` to map AST operator
 *    enums to builtin names.
 *
 *  See `registry.ts` for the `Builtin` interface and the registry itself.
 */

import type { Span } from "../../parser/index.js";
import { BinaryOperation, UnaryOperation } from "../../parser/index.js";
import { UnsupportedConstruct } from "../errors.js";
import { registerBuiltin, getBuiltin } from "./registry.js";

import { plus } from "./arithmetic/plus.js";
import { minus } from "./arithmetic/minus.js";
import { times } from "./arithmetic/times.js";
import { rdivide } from "./arithmetic/rdivide.js";
import { mtimes } from "./arithmetic/mtimes.js";
import { mrdivide } from "./arithmetic/mrdivide.js";
import { uminus } from "./arithmetic/uminus.js";
import { eq } from "./compare/eq.js";
import { ne } from "./compare/ne.js";
import { lt } from "./compare/lt.js";
import { le } from "./compare/le.js";
import { gt } from "./compare/gt.js";
import { ge } from "./compare/ge.js";
import { disp } from "./io/disp.js";
import { length } from "./reduction/length.js";
import { numel } from "./reduction/numel.js";
import { sum } from "./reduction/sum.js";
import { zeros } from "./shape/zeros.js";
import { ones } from "./shape/ones.js";

for (const b of [
  plus,
  minus,
  times,
  rdivide,
  mtimes,
  mrdivide,
  uminus,
  eq,
  ne,
  lt,
  le,
  gt,
  ge,
  disp,
  length,
  numel,
  sum,
  zeros,
  ones,
]) {
  registerBuiltin(b);
}

export type { Builtin } from "./registry.js";
export { registerBuiltin, getBuiltin, allBuiltinNames } from "./registry.js";

export function binaryOpBuiltin(op: BinaryOperation): string {
  switch (op) {
    case BinaryOperation.Add:
      return "plus";
    case BinaryOperation.Sub:
      return "minus";
    case BinaryOperation.Mul:
      return "mtimes";
    case BinaryOperation.ElemMul:
      return "times";
    case BinaryOperation.Div:
      return "mrdivide";
    case BinaryOperation.ElemDiv:
      return "rdivide";
    case BinaryOperation.Equal:
      return "eq";
    case BinaryOperation.NotEqual:
      return "ne";
    case BinaryOperation.Less:
      return "lt";
    case BinaryOperation.LessEqual:
      return "le";
    case BinaryOperation.Greater:
      return "gt";
    case BinaryOperation.GreaterEqual:
      return "ge";
    default:
      throw new Error(`binaryOpBuiltin: unmapped op ${op}`);
  }
}

export function unaryOpBuiltin(op: UnaryOperation): string {
  switch (op) {
    case UnaryOperation.Minus:
      return "uminus";
    case UnaryOperation.Plus:
      return "uplus";
    default:
      throw new Error(`unaryOpBuiltin: unmapped op ${op}`);
  }
}

export function isOpBuiltinSupported(name: string, span: Span): void {
  if (getBuiltin(name) === undefined) {
    throw new UnsupportedConstruct(`builtin '${name}' not supported`, span);
  }
}

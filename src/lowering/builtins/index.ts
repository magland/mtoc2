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
import { tic } from "./system/tic.js";
import { toc } from "./system/toc.js";
import { cos } from "./math/cos.js";
import { sin } from "./math/sin.js";
import { tan } from "./math/tan.js";
import { atan } from "./math/atan.js";
import { exp } from "./math/exp.js";
import { abs } from "./math/abs.js";
import { signBuiltin } from "./math/sign.js";
import { floor } from "./math/floor.js";
import { ceil } from "./math/ceil.js";
import { round } from "./math/round.js";
import { fix } from "./math/fix.js";
import { sqrt } from "./math/sqrt.js";
import { log } from "./math/log.js";
import { log2 } from "./math/log2.js";
import { log10 } from "./math/log10.js";
import { mod } from "./math/mod.js";
import { rem } from "./math/rem.js";
import { atan2 } from "./math/atan2.js";
import { hypot } from "./math/hypot.js";
import { pi, eps, Inf, inf, NaNBuiltin, nan } from "./math/constants.js";

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
  tic,
  toc,
  cos,
  sin,
  tan,
  atan,
  exp,
  abs,
  signBuiltin,
  floor,
  ceil,
  round,
  fix,
  sqrt,
  log,
  log2,
  log10,
  mod,
  rem,
  atan2,
  hypot,
  pi,
  eps,
  Inf,
  inf,
  NaNBuiltin,
  nan,
]) {
  registerBuiltin(b);
}

export type { Builtin } from "./registry.js";
export { registerBuiltin, getBuiltin, allBuiltinNames } from "./registry.js";

/** Source-level surface form for a binary op. Used to phrase
 *  user-facing rejection messages so the unsupported construct is
 *  identified by what the user typed (`^`, `||`, etc.), not by the
 *  AST enum tag. */
function binaryOpSurface(op: BinaryOperation): string {
  switch (op) {
    case BinaryOperation.Pow:
      return "^";
    case BinaryOperation.ElemPow:
      return ".^";
    case BinaryOperation.LeftDiv:
      return "\\";
    case BinaryOperation.ElemLeftDiv:
      return ".\\";
    case BinaryOperation.OrOr:
      return "||";
    case BinaryOperation.AndAnd:
      return "&&";
    case BinaryOperation.BitOr:
      return "|";
    case BinaryOperation.BitAnd:
      return "&";
    default:
      return op;
  }
}

function unaryOpSurface(op: UnaryOperation): string {
  switch (op) {
    case UnaryOperation.Not:
      return "~";
    case UnaryOperation.Transpose:
      return "'";
    case UnaryOperation.NonConjugateTranspose:
      return ".'";
    default:
      return op;
  }
}

export function binaryOpBuiltin(op: BinaryOperation, span: Span): string {
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
      // The remaining BinaryOperation cases (Pow / ElemPow / LeftDiv /
      // ElemLeftDiv / OrOr / AndAnd / BitOr / BitAnd) are valid numbl
      // operators that mtoc2 doesn't yet support. Surface as a span-
      // attributed UnsupportedConstruct so the CLI prints the source
      // location of the offending operator instead of an internal
      // "unmapped op" error.
      throw new UnsupportedConstruct(
        `binary operator '${binaryOpSurface(op)}' is not yet supported`,
        span
      );
  }
}

export function unaryOpBuiltin(op: UnaryOperation, span: Span): string {
  switch (op) {
    case UnaryOperation.Minus:
      return "uminus";
    case UnaryOperation.Plus:
      return "uplus";
    default:
      throw new UnsupportedConstruct(
        `unary operator '${unaryOpSurface(op)}' is not yet supported`,
        span
      );
  }
}

export function isOpBuiltinSupported(name: string, span: Span): void {
  if (getBuiltin(name) === undefined) {
    throw new UnsupportedConstruct(`builtin '${name}' not supported`, span);
  }
}

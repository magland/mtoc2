/**
 * Shared infrastructure for scalar comparison builtins
 * (`eq`, `ne`, `lt`, `le`, `gt`, `ge`).
 *
 * Complex scalar handling (MATLAB rule):
 *   - `eq` / `ne` compare both real and imaginary parts.
 *   - `<` / `<=` / `>` / `>=` compare on the real part only; the
 *     imaginary part is dropped. (numbl matches.)
 */

import { isNumeric, isScalar, scalarLogical, type Type } from "../../types.js";
import type { Builtin } from "../registry.js";
import {
  requireScalarRealOrComplex,
  exactDouble,
  exactScalarAsComplex,
} from "../_shared.js";

export type CompareKind = "eq" | "ne" | "rel";

function isScalarComplex(t: Type): boolean {
  return isNumeric(t) && isScalar(t) && t.isComplex;
}

export function defineCompare(
  name: string,
  cOp: string,
  fold: (a: number, b: number) => boolean,
  kind: CompareKind = "rel"
): Builtin {
  return {
    name,
    arity: 2,
    transfer(argTypes, span) {
      requireScalarRealOrComplex(argTypes[0], `'${name}' arg 1`, span);
      requireScalarRealOrComplex(argTypes[1], `'${name}' arg 2`, span);
      if (isScalarComplex(argTypes[0]) || isScalarComplex(argTypes[1])) {
        const ax = exactScalarAsComplex(argTypes[0]);
        const bx = exactScalarAsComplex(argTypes[1]);
        if (ax !== undefined && bx !== undefined) {
          if (kind === "eq") {
            return scalarLogical(ax.re === bx.re && ax.im === bx.im);
          }
          if (kind === "ne") {
            return scalarLogical(ax.re !== bx.re || ax.im !== bx.im);
          }
          return scalarLogical(fold(ax.re, bx.re));
        }
        return scalarLogical();
      }
      const ax = exactDouble(argTypes[0]);
      const bx = exactDouble(argTypes[1]);
      if (ax !== undefined && bx !== undefined) {
        return scalarLogical(fold(ax, bx));
      }
      return scalarLogical();
    },
    codegenC(argsC, argTypes) {
      const aCx = isScalarComplex(argTypes[0]);
      const bCx = isScalarComplex(argTypes[1]);
      if (aCx || bCx) {
        // Materialize re/im for the operands; project a real-typed
        // operand to (re, 0) inline so the C expression doesn't have
        // to branch on which side is complex.
        const aReC = aCx ? `mtoc2_creal(${argsC[0]})` : `(${argsC[0]})`;
        const bReC = bCx ? `mtoc2_creal(${argsC[1]})` : `(${argsC[1]})`;
        if (kind === "eq") {
          const aImC = aCx ? `mtoc2_cimag(${argsC[0]})` : "0.0";
          const bImC = bCx ? `mtoc2_cimag(${argsC[1]})` : "0.0";
          return `((${aReC} == ${bReC} && ${aImC} == ${bImC}) ? 1.0 : 0.0)`;
        }
        if (kind === "ne") {
          const aImC = aCx ? `mtoc2_cimag(${argsC[0]})` : "0.0";
          const bImC = bCx ? `mtoc2_cimag(${argsC[1]})` : "0.0";
          return `((${aReC} != ${bReC} || ${aImC} != ${bImC}) ? 1.0 : 0.0)`;
        }
        return `((${aReC} ${cOp} ${bReC}) ? 1.0 : 0.0)`;
      }
      return `((${argsC[0]} ${cOp} ${argsC[1]}) ? 1.0 : 0.0)`;
    },
    runtimeDeps: ["mtoc2_cscalar"],
  };
}

/**
 * Shared infrastructure for scalar comparison builtins
 * (`eq`, `ne`, `lt`, `le`, `gt`, `ge`).
 *
 * Complex scalar handling (MATLAB rule):
 *   - `eq` / `ne` compare both real and imaginary parts.
 *   - `<` / `<=` / `>` / `>=` compare on the real part only; the
 *     imaginary part is dropped. (numbl matches.)
 */

import { TypeError, UnsupportedConstruct } from "../../../lowering/errors.js";
import { isNumeric, isScalar, scalarLogical, type Type } from "../../../lowering/types.js";
import type { Builtin } from "../../registry.js";
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
    transfer(argTypes, nargout) {
      if (argTypes.length !== 2) {
        throw new TypeError(
          `'${name}' expects 2 arg(s), got ${argTypes.length}`
        );
      }
      if (nargout !== 1) {
        throw new UnsupportedConstruct(
          `'${name}' does not support multi-output (nargout=${nargout})`
        );
      }
      requireScalarRealOrComplex(argTypes[0], `'${name}' arg 1`);
      requireScalarRealOrComplex(argTypes[1], `'${name}' arg 2`);
      if (isScalarComplex(argTypes[0]) || isScalarComplex(argTypes[1])) {
        const ax = exactScalarAsComplex(argTypes[0]);
        const bx = exactScalarAsComplex(argTypes[1]);
        if (ax !== undefined && bx !== undefined) {
          if (kind === "eq") {
            return [scalarLogical(ax.re === bx.re && ax.im === bx.im)];
          }
          if (kind === "ne") {
            return [scalarLogical(ax.re !== bx.re || ax.im !== bx.im)];
          }
          return [scalarLogical(fold(ax.re, bx.re))];
        }
        return [scalarLogical()];
      }
      const ax = exactDouble(argTypes[0]);
      const bx = exactDouble(argTypes[1]);
      if (ax !== undefined && bx !== undefined) {
        return [scalarLogical(fold(ax, bx))];
      }
      return [scalarLogical()];
    },
    emitC({ argsC, argTypes, useRuntime }) {
      const aCx = isScalarComplex(argTypes[0]);
      const bCx = isScalarComplex(argTypes[1]);
      if (aCx || bCx) {
        useRuntime("mtoc2_cscalar");
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
    // Logical result encoded as 1/0 to mirror MATLAB's
    // logical-as-double semantics (the C side does the same).
    emitJs({ argsJs, argTypes }) {
      const aCx = isScalarComplex(argTypes[0]);
      const bCx = isScalarComplex(argTypes[1]);
      if (aCx || bCx) {
        const aRe = aCx ? `${argsJs[0]}.re` : `${argsJs[0]}`;
        const bRe = bCx ? `${argsJs[1]}.re` : `${argsJs[1]}`;
        if (kind === "eq") {
          const aIm = aCx ? `${argsJs[0]}.im` : `0`;
          const bIm = bCx ? `${argsJs[1]}.im` : `0`;
          return `((${aRe} === ${bRe} && ${aIm} === ${bIm}) ? 1 : 0)`;
        }
        if (kind === "ne") {
          const aIm = aCx ? `${argsJs[0]}.im` : `0`;
          const bIm = bCx ? `${argsJs[1]}.im` : `0`;
          return `((${aRe} !== ${bRe} || ${aIm} !== ${bIm}) ? 1 : 0)`;
        }
        return `((${aRe} ${cOp} ${bRe}) ? 1 : 0)`;
      }
      return `((${argsJs[0]} ${cOp} ${argsJs[1]}) ? 1 : 0)`;
    },
    call({ args, argTypes }) {
      const aCx = isScalarComplex(argTypes[0]);
      const bCx = isScalarComplex(argTypes[1]);
      if (aCx || bCx) {
        const av = args[0];
        const bv = args[1];
        const aRe =
          typeof av === "number"
            ? av
            : (av as { re: number; im: number }).re;
        const aIm =
          typeof av === "number"
            ? 0
            : (av as { re: number; im: number }).im;
        const bRe =
          typeof bv === "number"
            ? bv
            : (bv as { re: number; im: number }).re;
        const bIm =
          typeof bv === "number"
            ? 0
            : (bv as { re: number; im: number }).im;
        if (kind === "eq") return [aRe === bRe && aIm === bIm ? 1 : 0];
        if (kind === "ne") return [aRe !== bRe || aIm !== bIm ? 1 : 0];
        return [fold(aRe, bRe) ? 1 : 0];
      }
      const av = typeof args[0] === "number" ? args[0] : Number(args[0]);
      const bv = typeof args[1] === "number" ? args[1] : Number(args[1]);
      return [fold(av, bv) ? 1 : 0];
    },
    elementwise: true,
  };
}

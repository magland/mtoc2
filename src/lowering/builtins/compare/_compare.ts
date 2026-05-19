/**
 * Shared infrastructure for scalar comparison builtins
 * (`eq`, `ne`, `lt`, `le`, `gt`, `ge`).
 *
 * Complex scalar handling (MATLAB rule):
 *   - `eq` / `ne` compare both real and imaginary parts.
 *   - `<` / `<=` / `>` / `>=` compare on the real part only; the
 *     imaginary part is dropped. (numbl matches.)
 */

import { TypeError, UnsupportedConstruct } from "../../errors.js";
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
    // Minimal scalar-real-only emitJs (Phase 2 smoke test). Logical
    // result encoded as 1.0/0.0 to match the C side's
    // `scalarLogical()` lattice (logical stored as a double).
    emitJs({ argsJs, argTypes }) {
      const aCx = isScalarComplex(argTypes[0]);
      const bCx = isScalarComplex(argTypes[1]);
      if (aCx || bCx) {
        throw new UnsupportedConstruct(
          `'${kind}' complex codegen is not yet wired in emitJs (Phase 5)`
        );
      }
      return `((${argsJs[0]} ${cOp} ${argsJs[1]}) ? 1 : 0)`;
    },
    // Minimal scalar-real call hook for the interpreter. Returns
    // 1/0 to mirror MATLAB's logical-as-double semantics.
    call({ args, argTypes }) {
      const aCx = isScalarComplex(argTypes[0]);
      const bCx = isScalarComplex(argTypes[1]);
      if (aCx || bCx) {
        throw new UnsupportedConstruct(
          `'${kind}' complex 'call' is not yet wired (Phase 5)`
        );
      }
      const av = typeof args[0] === "number" ? args[0] : Number(args[0]);
      const bv = typeof args[1] === "number" ? args[1] : Number(args[1]);
      return [fold(av, bv) ? 1 : 0];
    },
    elementwise: true,
  };
}

/**
 * Shared infrastructure for scalar comparison builtins
 * (`eq`, `ne`, `lt`, `le`, `gt`, `ge`).
 */

import { scalarLogical } from "../../types.js";
import type { Builtin } from "../registry.js";
import { requireScalarRealDouble, exactDouble } from "../_shared.js";

export function defineCompare(
  name: string,
  cOp: string,
  fold: (a: number, b: number) => boolean
): Builtin {
  return {
    name,
    arity: 2,
    transfer(argTypes, span) {
      requireScalarRealDouble(argTypes[0], `'${name}' arg 1`, span);
      requireScalarRealDouble(argTypes[1], `'${name}' arg 2`, span);
      const ax = exactDouble(argTypes[0]);
      const bx = exactDouble(argTypes[1]);
      if (ax !== undefined && bx !== undefined) {
        return scalarLogical(fold(ax, bx));
      }
      return scalarLogical();
    },
    codegenC(argsC) {
      return `((${argsC[0]} ${cOp} ${argsC[1]}) ? 1.0 : 0.0)`;
    },
  };
}

import { TypeError } from "../../errors.js";
import {
  scalarDouble,
  shapeNumel,
  signFromNumber,
  isNumeric,
  isScalar,
} from "../../types.js";
import type { Builtin } from "../registry.js";

export const numel: Builtin = {
  name: "numel",
  arity: 1,
  transfer(argTypes, span) {
    const t = argTypes[0];
    if (!isNumeric(t)) {
      throw new TypeError(`'numel' arg must be numeric (got ${t.kind})`, span);
    }
    if (t.shape === undefined) {
      // Shape unknown at compile time (e.g. a tensor stored on a
      // struct/class field). The runtime helper handles it.
      return scalarDouble("nonneg");
    }
    const v = shapeNumel(t.shape);
    return scalarDouble(signFromNumber(v), v);
  },
  codegenC(argsC, argTypes) {
    const t = argTypes[0];
    if (isNumeric(t) && isScalar(t)) {
      return `1.0`;
    }
    return `mtoc2_numel(${argsC[0]})`;
  },
  runtimeDeps: ["mtoc2_numel"],
};

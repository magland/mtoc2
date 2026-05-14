import { TypeError, UnsupportedConstruct } from "../../errors.js";
import {
  scalarDouble,
  signFromNumber,
  isNumeric,
  isScalar,
} from "../../types.js";
import type { Builtin } from "../registry.js";

export const length: Builtin = {
  name: "length",
  arity: 1,
  transfer(argTypes, span) {
    const t = argTypes[0];
    if (!isNumeric(t)) {
      throw new TypeError(`'length' arg must be numeric (got ${t.kind})`, span);
    }
    if (t.shape === undefined) {
      throw new UnsupportedConstruct(
        `'length' on a tensor of unknown shape not yet supported`,
        span
      );
    }
    // MATLAB's `length`: max of the dim sizes, or 0 if any axis is 0.
    let v = 0;
    if (t.shape.some(s => s === 0)) v = 0;
    else v = t.shape.reduce((a, b) => Math.max(a, b), 0);
    return scalarDouble(signFromNumber(v), v);
  },
  codegenC(argsC, argTypes) {
    const t = argTypes[0];
    if (isNumeric(t) && isScalar(t)) {
      // length of a scalar is 1 — the C arg is a bare `double`, not a
      // tensor, so the runtime helper doesn't apply.
      return `1.0`;
    }
    return `mtoc2_length(${argsC[0]})`;
  },
  runtimeDeps: ["mtoc2_length"],
};

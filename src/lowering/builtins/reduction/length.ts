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
  transfer(argTypes, nargout) {
    if (argTypes.length !== 1) {
      throw new TypeError(`'length' expects 1 arg(s), got ${argTypes.length}`);
    }
    if (nargout !== 1) {
      throw new UnsupportedConstruct(
        `'length' does not support multi-output (nargout=${nargout})`
      );
    }
    const t = argTypes[0];
    if (!isNumeric(t)) {
      throw new TypeError(`'length' arg must be numeric (got ${t.kind})`);
    }
    if (t.shape === undefined) {
      return [scalarDouble("nonneg")];
    }
    let v = 0;
    if (t.shape.some(s => s === 0)) v = 0;
    else v = t.shape.reduce((a, b) => Math.max(a, b), 0);
    return [scalarDouble(signFromNumber(v), v)];
  },
  emit({ argsC, argTypes, useRuntime }) {
    useRuntime("mtoc2_length");
    const t = argTypes[0];
    if (isNumeric(t) && isScalar(t)) {
      return `1.0`;
    }
    return `mtoc2_length(${argsC[0]})`;
  },
};

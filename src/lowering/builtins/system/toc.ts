/**
 * toc — read the elapsed wall-clock seconds since `tic`.
 */

import { TypeError, UnsupportedConstruct } from "../../errors.js";
import { isScalarRealNumeric, scalarDouble } from "../../types.js";
import type { Builtin } from "../registry.js";

export const toc: Builtin = {
  name: "toc",
  transfer(argTypes, nargout) {
    if (argTypes.length > 1) {
      throw new TypeError(`'toc' expects 0..1 arg(s), got ${argTypes.length}`);
    }
    if (nargout !== 1) {
      throw new UnsupportedConstruct(
        `'toc' does not support multi-output (nargout=${nargout})`
      );
    }
    if (argTypes.length === 1 && !isScalarRealNumeric(argTypes[0])) {
      throw new TypeError(
        `'toc' tic-handle argument must be a scalar real numeric ` +
          `(the value returned by 'tic'); got ${argTypes[0].kind}`
      );
    }
    return [scalarDouble("nonneg")];
  },
  emit({ argsC, useRuntime }) {
    useRuntime("mtoc2_tic_toc");
    if (argsC.length === 1) return `mtoc2_toc_handle(${argsC[0]})`;
    return "mtoc2_toc()";
  },
};

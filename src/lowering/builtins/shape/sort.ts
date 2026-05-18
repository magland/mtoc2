/**
 * `sort` — stable ascending sort.
 *
 * Two forms supported in v1:
 *   - `b = sort(a)`              → freshly-owned tensor of sorted values
 *                                   (same shape as `a`)
 *   - `[v, i] = sort(a)`         → values + 1-based original positions
 *                                   (same shape as `a` on both outputs)
 */

import { TypeError, UnsupportedConstruct } from "../../errors.js";
import {
  isDimOne,
  isMultiElement,
  tensorDoubleFromDims,
  type NumericType,
  type Type,
  typeToString,
} from "../../types.js";
import type { Builtin } from "../registry.js";
import { requireRealDouble } from "../_shared.js";

function requireVectorInput(a: Type): NumericType {
  requireRealDouble(a, "'sort' arg 1");
  const aN = a as NumericType;
  if (!isMultiElement(aN)) {
    throw new UnsupportedConstruct(
      `'sort' on a scalar is a no-op; pass a 1-D vector (1×N or N×1)`
    );
  }
  if (aN.dims.length !== 2) {
    throw new UnsupportedConstruct(
      `'sort' currently only supports 1-D vectors (got ${typeToString(aN)}); ` +
        `matrix and N-D forms (with explicit 'dim' arg) are not yet supported`
    );
  }
  const isRow = isDimOne(aN.dims[0]);
  const isCol = isDimOne(aN.dims[1]);
  if (!isRow && !isCol) {
    throw new UnsupportedConstruct(
      `'sort' currently only supports 1-D vectors (1×N or N×1); got ` +
        `${typeToString(aN)} — pass an explicit 'dim' (not yet supported) or ` +
        `reshape first`
    );
  }
  return aN;
}

export const sort: Builtin = {
  name: "sort",
  transfer(argTypes, nargout) {
    if (argTypes.length !== 1) {
      throw new TypeError(`'sort' expects 1 arg(s), got ${argTypes.length}`);
    }
    if (nargout < 1 || nargout > 2) {
      throw new UnsupportedConstruct(
        `'sort' supports 1..2 output(s); got nargout=${nargout}`
      );
    }
    const aN = requireVectorInput(argTypes[0]);
    const v = tensorDoubleFromDims(aN.dims.slice());
    if (nargout === 1) return [v];
    const idx = tensorDoubleFromDims(aN.dims.slice());
    idx.sign = "positive";
    return [v, idx];
  },
  emit({ argsC, nargout, outArgsC, useRuntime }) {
    useRuntime("mtoc2_sort_real");
    if (nargout === 1) {
      return `mtoc2_sort_real(${argsC[0]})`;
    }
    const outs = outArgsC ?? [];
    return `mtoc2_sort_real_2(${argsC[0]}, ${outs.join(", ")})`;
  },
};

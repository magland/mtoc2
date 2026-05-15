/**
 * `sort` — stable ascending sort.
 *
 * Two forms supported in v1:
 *   - `b = sort(a)`              → freshly-owned tensor of sorted values
 *                                   (same shape as `a`)
 *   - `[v, i] = sort(a)`         → values + 1-based original positions
 *                                   (same shape as `a` on both outputs)
 *
 * Restrictions (gated by the cross-runner):
 *   - `a` must be a real-double 1×N row vector or N×1 column vector.
 *     Matrix / N-D inputs are deferred — those need either a `dim`
 *     argument or the MATLAB-default "first non-singleton dim" axis
 *     walk, neither of which we plumb through the C helper today.
 *   - No `'descend'` / `'ascend'` flag, no `dim` arg, no
 *     `'ComparisonMethod'` / `'MissingPlacement'` name-value pairs.
 *
 * Tie-breaking matches MATLAB: stable, so equal values preserve their
 * original column-major order. NaNs sort to the end (qsort places them
 * past every finite double under `<` because comparisons with NaN are
 * unordered — the cmp function returns 0 for any NaN pair so qsort's
 * relative order is implementation-defined, but they end up clumped
 * past finite values).
 */

import type { Span } from "../../../parser/index.js";
import { UnsupportedConstruct } from "../../errors.js";
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

function requireVectorInput(a: Type, span: Span): NumericType {
  requireRealDouble(a, "'sort' arg 1", span);
  const aN = a as NumericType;
  if (!isMultiElement(aN)) {
    throw new UnsupportedConstruct(
      `'sort' on a scalar is a no-op; pass a 1-D vector (1×N or N×1)`,
      span
    );
  }
  if (aN.dims.length !== 2) {
    throw new UnsupportedConstruct(
      `'sort' currently only supports 1-D vectors (got ${typeToString(aN)}); ` +
        `matrix and N-D forms (with explicit 'dim' arg) are not yet supported`,
      span
    );
  }
  const isRow = isDimOne(aN.dims[0]);
  const isCol = isDimOne(aN.dims[1]);
  if (!isRow && !isCol) {
    throw new UnsupportedConstruct(
      `'sort' currently only supports 1-D vectors (1×N or N×1); got ` +
        `${typeToString(aN)} — pass an explicit 'dim' (not yet supported) or ` +
        `reshape first`,
      span
    );
  }
  return aN;
}

export const sort: Builtin = {
  name: "sort",
  arity: 1,
  transfer(argTypes, span) {
    const aN = requireVectorInput(argTypes[0], span);
    return tensorDoubleFromDims(aN.dims.slice());
  },
  codegenC(argsC) {
    return `mtoc2_sort_real(${argsC[0]})`;
  },
  multiOutput: {
    minNargout: 1,
    maxNargout: 2,
    transfer(argTypes, nargout, span) {
      const aN = requireVectorInput(argTypes[0], span);
      const v = tensorDoubleFromDims(aN.dims.slice());
      if (nargout === 1) return [v];
      const idx = tensorDoubleFromDims(aN.dims.slice());
      idx.sign = "positive";
      return [v, idx];
    },
    cName(_argTypes, nargout) {
      return nargout === 2 ? "mtoc2_sort_real_2" : "mtoc2_sort_real";
    },
  },
  runtimeDeps: ["mtoc2_sort_real"],
};

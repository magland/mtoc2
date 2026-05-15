/**
 * `meshgrid` — 2-D coordinate grid builder.
 *
 * Forms supported:
 *   - `[X, Y] = meshgrid(x, y)` — `x` length M, `y` length N.
 *                                  Returns X (N×M, each row = x) and
 *                                  Y (N×M, each column = y).
 *   - `[X, Y] = meshgrid(x)`    — shorthand for `meshgrid(x, x)`.
 *   - `Z = meshgrid(x, y)` / `Z = meshgrid(x)` — returns just X.
 *
 * Inputs must be real-double (or logical) 1-D vectors (1×N row or N×1
 * column). Scalar / complex / matrix / N-D inputs are rejected. The
 * 3-D `[X, Y, Z] = meshgrid(x, y, z)` form and complex variants are
 * deferred.
 *
 * The N×M shape (rows = length(y), columns = length(x)) matches MATLAB
 * and numbl. Data layout is column-major: `X.real[i + j*N] = x[j]`,
 * `Y.real[i + j*N] = y[i]`.
 *
 * The two-output form opts into the multi-output builtin ABI (same
 * pattern as `sort`): `multiOutput.{minNargout, maxNargout, transfer,
 * cName}` populated, `lowerMultiAssign` routes through a
 * `MultiAssignCall` IR node. cName picks `mtoc2_meshgrid` for the
 * 2-input form and `mtoc2_meshgrid_1arg` for the 1-input shorthand.
 */

import type { Span } from "../../../parser/index.js";
import { UnsupportedConstruct } from "../../errors.js";
import {
  EXACT_ARRAY_MAX_ELEMENTS,
  isDimOne,
  isMultiElement,
  tensorDouble,
  tensorDoubleFromDims,
  typeToString,
  type DimInfo,
  type NumericType,
  type Type,
} from "../../types.js";
import type { Builtin } from "../registry.js";
import { exactRealArray, requireRealDouble } from "../_shared.js";

function requireVecInput(t: Type, what: string, span: Span): NumericType {
  requireRealDouble(t, what, span);
  const tN = t as NumericType;
  if (!isMultiElement(tN)) {
    throw new UnsupportedConstruct(
      `${what} must be a 1-D vector (1×N or N×1); scalar inputs are not ` +
        `supported`,
      span
    );
  }
  if (tN.dims.length !== 2) {
    throw new UnsupportedConstruct(
      `${what} must be a 1-D vector (got ${typeToString(tN)})`,
      span
    );
  }
  const isRow = isDimOne(tN.dims[0]);
  const isCol = isDimOne(tN.dims[1]);
  if (!isRow && !isCol) {
    throw new UnsupportedConstruct(
      `${what} must be a 1-D vector (1×N or N×1); got ${typeToString(tN)}`,
      span
    );
  }
  return tN;
}

/** The non-singleton-axis `DimInfo` for a 1-D vector. */
function vecDim(t: NumericType): DimInfo {
  return isDimOne(t.dims[0]) ? t.dims[1] : t.dims[0];
}

function meshgridDataX(x: Float64Array, y: Float64Array): Float64Array {
  const M = x.length;
  const N = y.length;
  const out = new Float64Array(N * M);
  for (let j = 0; j < M; j++) {
    for (let i = 0; i < N; i++) {
      out[i + j * N] = x[j];
    }
  }
  return out;
}

function meshgridDataY(x: Float64Array, y: Float64Array): Float64Array {
  const M = x.length;
  const N = y.length;
  const out = new Float64Array(N * M);
  for (let j = 0; j < M; j++) {
    for (let i = 0; i < N; i++) {
      out[i + j * N] = y[i];
    }
  }
  return out;
}

function meshgridOutType(
  xN: NumericType,
  yN: NumericType,
  pick: "X" | "Y"
): NumericType {
  const xDim = vecDim(xN);
  const yDim = vecDim(yN);

  // Exact-fold path: both lengths known, both data known, total ≤ cap.
  const xArr = exactRealArray(xN);
  const yArr = exactRealArray(yN);
  if (
    xDim.kind === "exact" &&
    yDim.kind === "exact" &&
    xArr !== undefined &&
    yArr !== undefined &&
    xArr.length === xDim.value &&
    yArr.length === yDim.value
  ) {
    const total = xDim.value * yDim.value;
    if (total <= EXACT_ARRAY_MAX_ELEMENTS) {
      const data =
        pick === "X" ? meshgridDataX(xArr, yArr) : meshgridDataY(xArr, yArr);
      return tensorDouble([yDim.value, xDim.value], data);
    }
  }

  // Shape lattice: [N, M] = [length(y), length(x)].
  return tensorDoubleFromDims([yDim, xDim]);
}

export const meshgrid: Builtin = {
  name: "meshgrid",
  arity: { min: 1, max: 2 },
  transfer(argTypes, span) {
    const xN = requireVecInput(argTypes[0], "'meshgrid' arg 1", span);
    const yN =
      argTypes.length >= 2
        ? requireVecInput(argTypes[1], "'meshgrid' arg 2", span)
        : xN;
    return meshgridOutType(xN, yN, "X");
  },
  codegenC(argsC) {
    // Single-output form. Both 1-arg and 2-arg dispatch through the
    // same 2-input helper; for the 1-arg shorthand we pass arg 0 twice
    // (post-ANF the tensor arg is a bare Var read — duplicating the C
    // expression is safe because the runtime helper takes the tensor
    // struct by value, sharing the underlying buffer pointer, and
    // never frees its inputs).
    const x = argsC[0];
    const y = argsC.length >= 2 ? argsC[1] : argsC[0];
    return `mtoc2_meshgrid_x(${x}, ${y})`;
  },
  multiOutput: {
    // The standard MATLAB form is `[X, Y] = meshgrid(...)`. The
    // `[X] = meshgrid(...)` form would have ambiguous semantics with
    // the regular `X = meshgrid(...)` Assign anyway, so we restrict to
    // exactly 2 outputs and steer users with one output to the regular
    // Assign syntax.
    minNargout: 2,
    maxNargout: 2,
    transfer(argTypes, _nargout, span) {
      const xN = requireVecInput(argTypes[0], "'meshgrid' arg 1", span);
      const yN =
        argTypes.length >= 2
          ? requireVecInput(argTypes[1], "'meshgrid' arg 2", span)
          : xN;
      return [meshgridOutType(xN, yN, "X"), meshgridOutType(xN, yN, "Y")];
    },
    cName(argTypes) {
      return argTypes.length === 1 ? "mtoc2_meshgrid_1arg" : "mtoc2_meshgrid";
    },
  },
  runtimeDeps: ["mtoc2_meshgrid"],
};

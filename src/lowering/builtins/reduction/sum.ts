import { TypeError, UnsupportedConstruct } from "../../errors.js";
import {
  scalarDouble,
  signFromNumber,
  isNumeric,
  isScalar,
} from "../../types.js";
import type { Builtin } from "../registry.js";

export const sum: Builtin = {
  name: "sum",
  arity: 1,
  transfer(argTypes, span) {
    const t = argTypes[0];
    if (!isNumeric(t) || t.isComplex) {
      throw new TypeError(
        `'sum' arg must be a real numeric (got ${t.kind})`,
        span
      );
    }
    // Scalar input: sum is the identity.
    if (isScalar(t)) {
      if (typeof t.exact === "number") {
        return scalarDouble(signFromNumber(t.exact), t.exact);
      }
      return scalarDouble(t.sign);
    }
    // Tensor input. MATLAB's `sum` of a vector (1×N or N×1) returns a
    // scalar; of a matrix it sums each column, returning a row. We
    // handle the vector case for now (compile-time fold when exact;
    // mtoc2_sum at runtime otherwise) and reject the matrix case.
    if (t.shape !== undefined) {
      const isVector =
        t.shape.length === 2 && (t.shape[0] === 1 || t.shape[1] === 1);
      if (!isVector) {
        throw new UnsupportedConstruct(
          t.shape.length > 2
            ? `'sum' on rank-${t.shape.length} tensors is not yet supported`
            : `'sum' on a non-vector tensor (matrix → row-vector reduction) is not yet supported`,
          span
        );
      }
    } else {
      // Shape unknown at compile time. Accept ONLY if the dim signature
      // proves vector-ness (one of the axes is statically `one`).
      // Otherwise reject — `mtoc2_sum` collapses every element to one
      // scalar regardless of runtime shape, while numbl reduces a
      // matrix by columns to a row vector. Common trigger: a multi-
      // slot range slice like `M(:, 2:5)` produces dims `[notOne,
      // notOne]` with no `shape`, and silently summing it diverges
      // from numbl.
      const isProvenVector =
        t.dims.length === 2 &&
        (t.dims[0].kind === "one" || t.dims[1].kind === "one");
      if (!isProvenVector) {
        throw new UnsupportedConstruct(
          `'sum' on a non-vector tensor (matrix → row-vector reduction) is not yet supported`,
          span
        );
      }
    }
    if (t.exact instanceof Float64Array) {
      let acc = 0;
      for (let i = 0; i < t.exact.length; i++) acc += t.exact[i];
      return scalarDouble(signFromNumber(acc), acc);
    }
    return scalarDouble("unknown");
  },
  codegenC(argsC, argTypes) {
    const t = argTypes[0];
    if (!isNumeric(t) || isScalar(t)) {
      // Scalar fall-through (sum(x) === x). Should have folded; if it
      // reaches codegen the input had no exact, so emit identity.
      return argsC[0];
    }
    return `mtoc2_sum(${argsC[0]})`;
  },
  runtimeDeps: ["mtoc2_sum"],
};

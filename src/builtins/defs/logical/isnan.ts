/**
 * `isnan(x)` — elementwise test for NaN, returning logical 1 / 0.
 * Mirrors numbl's `isnan` for real input. (Complex input is not yet
 * supported; `requireRealDouble` rejects it with a span.)
 */
import { defineUnaryPred } from "./_unary_pred.js";

export const isnan = defineUnaryPred({
  name: "isnan",
  cScalar: arg => `(isnan(${arg}) ? 1.0 : 0.0)`,
  jsScalar: arg => `(Number.isNaN(${arg}) ? 1 : 0)`,
  jsFn: Number.isNaN,
  tensorHelper: "mtoc2_tensor_predicate",
});

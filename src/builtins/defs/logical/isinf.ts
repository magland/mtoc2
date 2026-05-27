/**
 * `isinf(x)` / `isfinite(x)` — elementwise tests returning logical
 * 1 / 0. Real input only (mirrors numbl for the real case). Built on
 * the shared real → logical predicate factory.
 */
import { defineUnaryPred } from "./_unary_pred.js";

export const isinf = defineUnaryPred({
  name: "isinf",
  cScalar: arg => `(isinf(${arg}) ? 1.0 : 0.0)`,
  jsScalar: arg => `(Math.abs(${arg}) === Infinity ? 1 : 0)`,
  jsFn: x => x === Infinity || x === -Infinity,
  tensorHelper: "mtoc2_tensor_predicate",
});

export const isfinite = defineUnaryPred({
  name: "isfinite",
  cScalar: arg => `(isfinite(${arg}) ? 1.0 : 0.0)`,
  jsScalar: arg => `(Number.isFinite(${arg}) ? 1 : 0)`,
  jsFn: Number.isFinite,
  tensorHelper: "mtoc2_tensor_predicate",
});

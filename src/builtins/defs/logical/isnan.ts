/**
 * `isnan(x)` — elementwise test for NaN, returning logical 1 / 0.
 * Real input: per-element `isnan`. Complex input: per-element
 * `isnan(re) || isnan(im)` (matches numbl / MATLAB).
 */
import { defineUnaryPred } from "./_unary_pred.js";

export const isnan = defineUnaryPred({
  name: "isnan",
  cScalar: arg => `(isnan(${arg}) ? 1.0 : 0.0)`,
  jsScalar: arg => `(Number.isNaN(${arg}) ? 1 : 0)`,
  jsFn: Number.isNaN,
  tensorHelper: "mtoc2_tensor_predicate",
  complex: {
    cScalarComplex: (re, im) => `isnan(${re}) || isnan(${im})`,
    jsScalarComplex: (re, im) => `Number.isNaN(${re}) || Number.isNaN(${im})`,
    jsFnComplex: (re, im) => Number.isNaN(re) || Number.isNaN(im),
    tensorHelperComplex: "mtoc2_tensor_isnan_complex",
  },
});

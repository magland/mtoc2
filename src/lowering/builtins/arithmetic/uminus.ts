import {
  type NumericType,
  scalarDouble,
  scalarComplex,
  tensorDouble,
  tensorDoubleFromDims,
  signFromNumber,
  flipSign,
  isMultiElement,
  isNumeric,
  isScalar,
} from "../../types.js";
import type { Builtin } from "../registry.js";
import { UnsupportedConstruct } from "../../errors.js";
import {
  requireRealOrComplex,
  exactDouble,
  exactRealArray,
  exactComplex,
} from "../_shared.js";

export const uminus: Builtin = {
  name: "uminus",
  arity: 1,
  transfer(argTypes, span) {
    requireRealOrComplex(argTypes[0], `'uminus' arg`, span);
    const a = argTypes[0] as NumericType;
    if (a.isComplex) {
      if (isMultiElement(a)) {
        throw new UnsupportedConstruct(
          `'uminus' on a complex tensor is not yet supported`,
          span
        );
      }
      const cx = exactComplex(a);
      if (cx !== undefined) {
        return scalarComplex({ re: -cx.re, im: -cx.im });
      }
      return scalarComplex();
    }
    if (isScalar(a)) {
      const ax = exactDouble(a);
      if (ax !== undefined) {
        const v = -ax;
        return scalarDouble(signFromNumber(v), v);
      }
      return scalarDouble(flipSign(a.sign));
    }
    // Tensor uminus: fold when exact, else runtime. The C helper
    // iterates `n = prod(dims)` regardless of whether shape is known
    // statically, so unknown-dim tensors are fine — we just can't
    // fold their values.
    const arr = exactRealArray(a);
    if (arr !== undefined && a.shape !== undefined) {
      const out = new Float64Array(arr.length);
      for (let i = 0; i < arr.length; i++) out[i] = -arr[i];
      return tensorDouble(a.shape, out);
    }
    const out = tensorDoubleFromDims(a.dims.slice());
    out.sign = flipSign(a.sign);
    return out;
  },
  codegenC(argsC, argTypes) {
    if (isMultiElement(argTypes[0])) {
      return `mtoc2_tensor_uminus(${argsC[0]})`;
    }
    if (isNumeric(argTypes[0]) && argTypes[0].isComplex) {
      return `mtoc2_cneg(${argsC[0]})`;
    }
    return `(-${argsC[0]})`;
  },
  // Both `mtoc2_tensor_uminus` (tensor path) and `mtoc2_cneg` (scalar
  // complex path) get pulled in unconditionally. The complex helper is
  // a `static inline` with no native cost when unused; activating it
  // here keeps the dispatch decision local to `codegenC` above.
  runtimeDeps: ["mtoc2_tensor_elemwise_real", "mtoc2_cscalar"],
};

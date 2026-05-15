import {
  type NumericType,
  scalarDouble,
  tensorDouble,
  tensorDoubleFromDims,
  signFromNumber,
  flipSign,
  isMultiElement,
  isScalar,
} from "../../types.js";
import type { Builtin } from "../registry.js";
import { requireRealDouble, exactDouble, exactRealArray } from "../_shared.js";

export const uminus: Builtin = {
  name: "uminus",
  arity: 1,
  transfer(argTypes, span) {
    requireRealDouble(argTypes[0], `'uminus' arg`, span);
    const a = argTypes[0] as NumericType;
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
    return `(-${argsC[0]})`;
  },
  runtimeDeps: ["mtoc2_tensor_elemwise_real"],
};

import { UnsupportedConstruct } from "../../errors.js";
import {
  type NumericType,
  scalarDouble,
  tensorDouble,
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
    // Tensor uminus: fold when exact, else runtime.
    const arr = exactRealArray(a);
    if (arr !== undefined && a.shape !== undefined) {
      const out = new Float64Array(arr.length);
      for (let i = 0; i < arr.length; i++) out[i] = -arr[i];
      return tensorDouble(a.shape, out);
    }
    if (a.shape === undefined) {
      throw new UnsupportedConstruct(
        `'uminus' on a tensor of unknown shape not yet supported`,
        span
      );
    }
    return tensorDouble(a.shape);
  },
  codegenC(argsC, argTypes) {
    if (isMultiElement(argTypes[0])) {
      return `mtoc2_tensor_uminus(${argsC[0]})`;
    }
    return `(-${argsC[0]})`;
  },
  runtimeDeps: ["mtoc2_tensor_elemwise_real"],
};

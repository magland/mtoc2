import { UnsupportedConstruct } from "../../errors.js";
import { isMultiElement } from "../../types.js";
import { type Builtin, getBuiltin } from "../registry.js";
import { requireRealOrComplex } from "../_shared.js";

// `mrdivide` (matrix /): mirrors `rdivide` when at least one arg is scalar;
// rejects the both-tensor case until matrix right-division is implemented.
export const mrdivide: Builtin = {
  name: "mrdivide",
  arity: 2,
  transfer(argTypes, span) {
    const a = argTypes[0];
    const b = argTypes[1];
    requireRealOrComplex(a, `'mrdivide' arg 1`, span);
    requireRealOrComplex(b, `'mrdivide' arg 2`, span);
    if (isMultiElement(a) && isMultiElement(b)) {
      throw new UnsupportedConstruct(
        `matrix right-division (a/b on two tensors) is not yet supported; use './' for elementwise`,
        span
      );
    }
    return getBuiltin("rdivide")!.transfer(argTypes, span);
  },
  codegenC(argsC, argTypes) {
    return getBuiltin("rdivide")!.codegenC(argsC, argTypes);
  },
  runtimeDeps: ["mtoc2_tensor_elemwise_real", "mtoc2_cdiv"],
};

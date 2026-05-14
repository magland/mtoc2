import { UnsupportedConstruct } from "../../errors.js";
import { isMultiElement } from "../../types.js";
import { type Builtin, getBuiltin } from "../registry.js";
import { requireRealDouble } from "../_shared.js";

// `mtimes` (matrix *): mirrors `times` when at least one arg is scalar;
// rejects the both-tensor case until matrix multiplication is implemented.
export const mtimes: Builtin = {
  name: "mtimes",
  arity: 2,
  transfer(argTypes, span) {
    const a = argTypes[0];
    const b = argTypes[1];
    requireRealDouble(a, `'mtimes' arg 1`, span);
    requireRealDouble(b, `'mtimes' arg 2`, span);
    if (isMultiElement(a) && isMultiElement(b)) {
      throw new UnsupportedConstruct(
        `matrix multiplication (a*b on two tensors) is not yet supported; use '.*' for elementwise`,
        span
      );
    }
    return getBuiltin("times")!.transfer(argTypes, span);
  },
  codegenC(argsC, argTypes) {
    return getBuiltin("times")!.codegenC(argsC, argTypes);
  },
  runtimeDeps: ["mtoc2_tensor_elemwise_real"],
};

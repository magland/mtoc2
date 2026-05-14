import { TypeError } from "../../errors.js";
import {
  isScalarRealNumeric,
  isNumeric,
  structTypedefName,
} from "../../types.js";
import type { Builtin } from "../registry.js";

export const disp: Builtin = {
  name: "disp",
  arity: 1,
  transfer(argTypes, span) {
    const t = argTypes[0];
    if (isScalarRealNumeric(t)) {
      // Scalar real (double or logical) — runtime call path.
      return { kind: "Unknown" };
    }
    if (
      isNumeric(t) &&
      !t.isComplex &&
      (t.elem === "double" || t.elem === "logical")
    ) {
      // Either an exact tensor (compile-time format) or a runtime
      // tensor with statically-known shape (mtoc2_disp_tensor call).
      return { kind: "Unknown" };
    }
    if (t.kind === "Struct") {
      // Per-shape `<typedef>_disp` is program-emitted; routing
      // happens in codegenC.
      return { kind: "Unknown" };
    }
    throw new TypeError(
      `'disp' arg must be a scalar real, a real tensor, or a struct ` +
        `(got ${t.kind})`,
      span
    );
  },
  codegenC(argsC, argTypes) {
    const t = argTypes[0];
    if (t.kind === "Struct") {
      // Program-emitted helper; no runtime-snippet dep needed.
      return `${structTypedefName(t)}_disp(${argsC[0]})`;
    }
    if (isNumeric(t) && !isScalarRealNumeric(t)) {
      // Runtime tensor — call the runtime disp helper. The arg is
      // passed by value (struct copy of the pointers); disp_tensor
      // reads but doesn't take ownership. Lifetime stays with the
      // caller's local.
      return `mtoc2_disp_tensor(${argsC[0]})`;
    }
    // Scalar runtime path.
    return `mtoc2_disp_double(${argsC[0]})`;
  },
  runtimeDeps: ["mtoc2_disp_double", "mtoc2_disp_tensor"],
};

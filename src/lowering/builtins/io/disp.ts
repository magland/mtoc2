import { TypeError, UnsupportedConstruct } from "../../errors.js";
import {
  isScalarRealNumeric,
  isNumeric,
  isScalar,
  isText,
  structTypedefName,
} from "../../types.js";
import type { Builtin } from "../registry.js";

export const disp: Builtin = {
  name: "disp",
  transfer(argTypes, nargout) {
    if (argTypes.length !== 1) {
      throw new TypeError(`'disp' expects 1 arg(s), got ${argTypes.length}`);
    }
    if (nargout !== 1) {
      throw new UnsupportedConstruct(
        `'disp' does not support multi-output (nargout=${nargout})`
      );
    }
    const t = argTypes[0];
    if (isScalarRealNumeric(t)) {
      return [{ kind: "Unknown" }];
    }
    if (isNumeric(t) && isScalar(t) && t.isComplex && t.elem === "double") {
      return [{ kind: "Unknown" }];
    }
    if (
      isNumeric(t) &&
      !t.isComplex &&
      (t.elem === "double" || t.elem === "logical")
    ) {
      return [{ kind: "Unknown" }];
    }
    if (isNumeric(t) && t.isComplex && !isScalar(t) && t.elem === "double") {
      return [{ kind: "Unknown" }];
    }
    if (isText(t)) {
      return [{ kind: "Unknown" }];
    }
    if (t.kind === "Struct") {
      return [{ kind: "Unknown" }];
    }
    throw new TypeError(
      `'disp' arg must be a scalar numeric, a real or complex tensor, text, or a struct ` +
        `(got ${t.kind})`
    );
  },
  emit({ argsC, argTypes, useRuntime }) {
    useRuntime("mtoc2_disp_double");
    useRuntime("mtoc2_disp_tensor");
    useRuntime("mtoc2_disp_text");
    useRuntime("mtoc2_disp_complex");
    useRuntime("mtoc2_disp_tensor_complex");
    const t = argTypes[0];
    if (t.kind === "Struct") {
      return `${structTypedefName(t)}_disp(${argsC[0]})`;
    }
    if (t.kind === "String") {
      return `mtoc2_disp_text(mtoc2_text_from_string(${argsC[0]}))`;
    }
    if (t.kind === "Char") {
      return `mtoc2_disp_text(mtoc2_text_from_char_tensor(${argsC[0]}))`;
    }
    if (isNumeric(t) && t.isComplex && isScalar(t)) {
      return `mtoc2_disp_complex(${argsC[0]})`;
    }
    if (isNumeric(t) && t.isComplex && !isScalar(t)) {
      return `mtoc2_disp_tensor_complex(${argsC[0]})`;
    }
    if (isNumeric(t) && !isScalarRealNumeric(t)) {
      return `mtoc2_disp_tensor(${argsC[0]})`;
    }
    return `mtoc2_disp_double(${argsC[0]})`;
  },
};

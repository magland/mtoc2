import { TypeError, UnsupportedConstruct } from "../../errors.js";
import {
  isScalarRealNumeric,
  isNumeric,
  isScalar,
  isText,
  structTypedefName,
} from "../../types.js";
import type { Builtin } from "../registry.js";
import { isChar, isTensor } from "../../../runtime/value.js";
import {
  mtoc2_disp_double,
  mtoc2_disp_tensor,
} from "../../../codegen/runtime/snippets.gen.js";

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
  emitC({ argsC, argTypes, useRuntime }) {
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
  // Minimal scalar-real call hook for the interpreter. Text /
  // tensor / complex paths land in Phase 5 alongside the JS-side
  // runtime helpers.
  emitJs({ argsJs, argTypes, useRuntime }) {
    const t = argTypes[0];
    if (isNumeric(t) && !t.isComplex && isScalar(t)) {
      useRuntime("mtoc2_disp_double");
      return `mtoc2_disp_double(${argsJs[0]})`;
    }
    if (isNumeric(t) && !t.isComplex && !isScalar(t)) {
      useRuntime("mtoc2_disp_tensor");
      return `mtoc2_disp_tensor(${argsJs[0]})`;
    }
    if (t.kind === "String") {
      // String runtime value is a JS string; print + newline.
      return `($write(${argsJs[0]} + "\\n"))`;
    }
    if (t.kind === "Char") {
      // Char runtime value is `{mtoc2Tag:"char",value}`; print value + newline.
      return `($write(${argsJs[0]}.value + "\\n"))`;
    }
    throw new UnsupportedConstruct(
      `'disp' emitJs for complex / struct args is not yet wired (Phase 5)`
    );
  },
  call({ args, ctx }) {
    const v = args[0];
    if (typeof v === "number") mtoc2_disp_double(v);
    else if (typeof v === "boolean") mtoc2_disp_double(v ? 1 : 0);
    else if (typeof v === "string") ctx.helpers.write(v + "\n");
    else if (isChar(v)) ctx.helpers.write(v.value + "\n");
    else if (isTensor(v)) {
      // The tensor disp snippet writes via `$write` (free var) — make
      // sure it's bound to the host's write before we call it. The
      // interpreter's constructor already does this, but a builtin
      // can also be called directly from a unit test.
      globalThis.$write = ctx.helpers.write;
      mtoc2_disp_tensor(v);
    } else {
      throw new UnsupportedConstruct(
        `'disp' 'call' got an unsupported value shape (got ${typeof v})`
      );
    }
    return [];
  },
};

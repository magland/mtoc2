/**
 * Per-shape struct/class typedef + owned-helper emission.
 *
 * Structs and class instances live as generated C `typedef struct
 * <name> { ... } <name>;` definitions, one per distinct canonical
 * shape. Each typedef ships with the four owned-kind helpers —
 * `_empty()`, `_assign()`, `_copy()`, `_free()` — so the existing
 * codegen pipeline (predeclare at function top, scope-exit free,
 * early-free, ANF) treats struct/class locals uniformly with tensors.
 *
 * Structs additionally get a `_disp()` helper used by `disp(s)`; v1
 * doesn't emit `_disp` for class instances.
 *
 * The renderer walks each field once and emits the right helper
 * pattern for that field:
 *   - scalar (Numeric / Handle / Unknown): plain C assignment / no
 *     free / no recursive copy.
 *   - owned (multi-element Numeric / nested Struct / nested Class):
 *     route through the field's own owned-kind helper family.
 *
 * Tensor fields call `mtoc2_tensor_*` directly; nested struct/class
 * fields call the corresponding `<inner-typedef>_*` helper, so a
 * topological order over the typedef-dependency graph guarantees each
 * helper is defined before the one that uses it.
 */

import {
  classTypedefName,
  isHandle,
  isMultiElement,
  structTypedefName,
  type ClassType,
  type StructType,
  type Type,
} from "../lowering/types.js";
import { handleTypedefName } from "../lowering/types.js";
import { useRuntimeByName, type RuntimeState } from "./runtime.js";

/** Catch-all C-type renderer that mirrors `cTypeFor` in emit.ts but
 *  also knows about structs and classes. Imported here as a small
 *  duplication to avoid a circular import with emit.ts. */
export function cTypeForField(t: Type): string {
  if (isMultiElement(t)) return "mtoc2_tensor_t";
  if (isHandle(t)) return handleTypedefName(t);
  if (t.kind === "Struct") return structTypedefName(t);
  if (t.kind === "Class") return classTypedefName(t);
  return "double";
}

/** Owned-helper family for a single field. Returns null for non-
 *  owned (POD) field types — those get plain assignment / no copy /
 *  no free. */
interface FieldOwnedOps {
  empty: string;
  assign: string;
  copy: string;
  free: string;
}

function ownedOpsFor(t: Type): FieldOwnedOps | null {
  if (isMultiElement(t)) {
    return {
      empty: "mtoc2_tensor_empty",
      assign: "mtoc2_tensor_assign",
      copy: "mtoc2_tensor_copy",
      free: "mtoc2_tensor_free",
    };
  }
  if (t.kind === "Struct") {
    const name = structTypedefName(t);
    return {
      empty: `${name}_empty`,
      assign: `${name}_assign`,
      copy: `${name}_copy`,
      free: `${name}_free`,
    };
  }
  if (t.kind === "Class") {
    const name = classTypedefName(t);
    return {
      empty: `${name}_empty`,
      assign: `${name}_assign`,
      copy: `${name}_copy`,
      free: `${name}_free`,
    };
  }
  return null;
}

export interface NamedTypedefSpec {
  /** Typedef name. The C output uses this as both the struct tag and
   *  the typedef alias. */
  name: string;
  /** Field list — canonical order (sorted by name). */
  fields: ReadonlyArray<{ name: string; ty: Type }>;
  /** Emit a `_disp(value)` helper (true for structs, false for
   *  classes in v1). */
  emitDisp: boolean;
  /** Source description for the function-leading comment (e.g.
   *  `struct{x:double,y:double}` or `class Foo`). */
  pretty: string;
}

/** Emit the typedef and its four (or five) owned-kind helpers as
 *  one block of C source. Activates any runtime snippets the helpers
 *  call into (e.g. `mtoc2_tensor_copy`). */
export function emitNamedTypedef(
  spec: NamedTypedefSpec,
  state: RuntimeState
): string {
  // Pull in field-level runtime helpers. Each owned tensor field
  // pulls the four tensor helpers. Nested struct/class fields don't
  // need runtime activation here — their helpers are program-emitted
  // and ordered by the typedef topological sort.
  for (const f of spec.fields) {
    if (isMultiElement(f.ty)) {
      useRuntimeByName(state, "mtoc2_tensor_empty");
      useRuntimeByName(state, "mtoc2_tensor_assign");
      useRuntimeByName(state, "mtoc2_tensor_copy");
      useRuntimeByName(state, "mtoc2_tensor_free");
    }
  }

  const lines: string[] = [];
  lines.push(`/* ${spec.pretty} */`);
  lines.push(`typedef struct ${spec.name} {`);
  for (const f of spec.fields) {
    lines.push(`  ${cTypeForField(f.ty)} ${f.name};`);
  }
  lines.push(`} ${spec.name};`);
  lines.push("");

  // _empty(): zero-initialize every field. Owned fields get their
  // field-type _empty() (NULL pointers for tensors; recursive empty
  // for nested struct/class). Scalars default to 0.0; handles use a
  // {0} compound literal.
  lines.push(`static ${spec.name} ${spec.name}_empty(void) {`);
  lines.push(`  ${spec.name} v;`);
  for (const f of spec.fields) {
    const ops = ownedOpsFor(f.ty);
    if (ops !== null) {
      lines.push(`  v.${f.name} = ${ops.empty}();`);
    } else if (isHandle(f.ty)) {
      lines.push(`  v.${f.name} = (${handleTypedefName(f.ty)}){0};`);
    } else {
      lines.push(`  v.${f.name} = 0.0;`);
    }
  }
  lines.push(`  return v;`);
  lines.push(`}`);
  lines.push("");

  // _free(): release every owned field. Scalars / handles are POD —
  // skip them.
  lines.push(`static void ${spec.name}_free(${spec.name} *p) {`);
  for (const f of spec.fields) {
    const ops = ownedOpsFor(f.ty);
    if (ops !== null) {
      lines.push(`  ${ops.free}(&p->${f.name});`);
    }
  }
  lines.push(`}`);
  lines.push("");

  // _copy(): deep copy every owned field via its _copy; scalars and
  // handles plain-assign.
  lines.push(`static ${spec.name} ${spec.name}_copy(${spec.name} v) {`);
  lines.push(`  ${spec.name} out;`);
  for (const f of spec.fields) {
    const ops = ownedOpsFor(f.ty);
    if (ops !== null) {
      lines.push(`  out.${f.name} = ${ops.copy}(v.${f.name});`);
    } else {
      lines.push(`  out.${f.name} = v.${f.name};`);
    }
  }
  lines.push(`  return out;`);
  lines.push(`}`);
  lines.push("");

  // _assign(): consume-replace. Free the prior owned slot, then move
  // the rhs into place. The rhs is expected to already be a freshly-
  // owned value (the calling convention is "consume the rhs").
  lines.push(
    `static void ${spec.name}_assign(${spec.name} *p, ${spec.name} rhs) {`
  );
  lines.push(`  ${spec.name}_free(p);`);
  lines.push(`  *p = rhs;`);
  lines.push(`}`);
  lines.push("");

  if (spec.emitDisp) {
    lines.push(...emitStructDisp(spec, state));
  }

  return lines.join("\n");
}

/** Emit `<name>_disp(v)` — prints a `key: value` line per field. The
 *  format is intentionally narrow: it matches what numbl's `disp` on
 *  a scalar struct produces for the common scalar / tensor field
 *  shapes (so the cross-runner stays byte-exact). Anything outside
 *  that subset would fail at lowering, not here. */
function emitStructDisp(spec: NamedTypedefSpec, state: RuntimeState): string[] {
  // Each `disp_double`/`disp_tensor` call pulls in its own snippet on
  // demand; nested struct/class disps recurse via the inner helper
  // (only structs emit disp — class fields are rejected at this
  // codegen site since v1 forbids class properties of class type).
  const lines: string[] = [];
  lines.push(`static void ${spec.name}_disp(${spec.name} v) {`);
  if (spec.fields.length === 0) {
    // numbl prints nothing for a zero-field struct; mirror that.
    lines.push(`  (void)v;`);
    lines.push(`}`);
    lines.push("");
    return lines;
  }
  // numbl's `disp(struct)` format is:
  //   `    <name>: <value>\n`
  // where the value is rendered the same way `disp(value)` would on
  // its own — so for a tensor the row data follows the colon on the
  // same line (with the tensor's leading whitespace intact) and
  // subsequent rows wrap to their own lines.
  for (const f of spec.fields) {
    lines.push(`  printf("    ${f.name}: ");`);
    if (isMultiElement(f.ty)) {
      useRuntimeByName(state, "mtoc2_disp_tensor");
      lines.push(`  mtoc2_disp_tensor(v.${f.name});`);
    } else if (f.ty.kind === "Struct") {
      const inner = structTypedefName(f.ty);
      // A nested struct's own _disp emits its own header/leading
      // newline; numbl prints a blank then the nested fields.
      lines.push(`  printf("\\n");`);
      lines.push(`  ${inner}_disp(v.${f.name});`);
    } else if (f.ty.kind === "Class") {
      // Class field disp not supported in v1; emit nothing rather
      // than failing — lowering rejects disp(class_instance) up
      // front, so this path is unreachable for well-formed input.
      lines.push(`  /* skipping class-typed field '${f.name}' in disp */`);
    } else {
      // Scalar real numeric. Use the existing scalar disp helper.
      useRuntimeByName(state, "mtoc2_disp_double");
      lines.push(`  mtoc2_disp_double(v.${f.name});`);
    }
  }
  lines.push(`}`);
  lines.push("");
  return lines;
}

/** Helper for emit.ts: build a `NamedTypedefSpec` for a `StructType`. */
export function specForStruct(t: StructType): NamedTypedefSpec {
  return {
    name: structTypedefName(t),
    fields: t.fields.map(f => ({ name: f.name, ty: f.ty })),
    emitDisp: true,
    pretty: `struct{${t.fields.map(f => f.name).join(", ")}}`,
  };
}

/** Helper for emit.ts: build a `NamedTypedefSpec` for a `ClassType`. */
export function specForClass(t: ClassType): NamedTypedefSpec {
  return {
    name: classTypedefName(t),
    fields: t.properties.map(p => ({ name: p.name, ty: p.ty })),
    emitDisp: false,
    pretty: `class ${t.className}`,
  };
}

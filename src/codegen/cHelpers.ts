/**
 * Shared C-type and owned-helper renderers used by both `emit.ts` and
 * `emitNamedTypedef.ts`. Lives in its own module so the two emitters
 * don't have to import each other (the previous arrangement had
 * `emitNamedTypedef.ts` duplicating these helpers to avoid a circular
 * import).
 */

import {
  classTypedefName,
  handleTypedefName,
  isHandle,
  isMultiElement,
  structTypedefName,
  type Type,
} from "../lowering/types.js";

/** C type for any mtoc2 IR-typed value: tensor / string / char →
 *  per-kind runtime struct; struct / class / handle → per-shape
 *  generated typedef; everything else (scalar real numeric) → `double`. */
export function cTypeFor(t: Type): string {
  if (isMultiElement(t)) return "mtoc2_tensor_t";
  if (isHandle(t)) return handleTypedefName(t);
  if (t.kind === "Struct") return structTypedefName(t);
  if (t.kind === "Class") return classTypedefName(t);
  if (t.kind === "String") return "mtoc2_string_t";
  if (t.kind === "Char") return "mtoc2_char_tensor_t";
  return "double";
}

/** Per-owned-kind helper-name family. Tensors / strings / chars use
 *  the global `mtoc2_*` runtime snippet names; structs, classes, and
 *  handles use their program-emitted `<typedef>_*` family. */
export interface OwnedHelpers {
  empty: string;
  assign: string;
  copy: string;
  free: string;
  /** When true, `empty`/`assign`/`copy`/`free` are loaded from the
   *  runtime snippet registry. When false, they're emitted directly
   *  into the generated C by `emitNamedTypedef` and need no
   *  `useRuntimeByName` activation. */
  isRuntime: boolean;
}

/** Owned-helper family for any type. Returns `null` for non-owned
 *  (POD) types — those get plain assignment / no copy / no free. */
export function ownedHelpersFor(t: Type): OwnedHelpers | null {
  if (isMultiElement(t)) {
    return {
      empty: "mtoc2_tensor_empty",
      assign: "mtoc2_tensor_assign",
      copy: "mtoc2_tensor_copy",
      free: "mtoc2_tensor_free",
      isRuntime: true,
    };
  }
  if (t.kind === "String") {
    return {
      empty: "mtoc2_string_empty",
      assign: "mtoc2_string_assign",
      copy: "mtoc2_string_copy",
      free: "mtoc2_string_free",
      isRuntime: true,
    };
  }
  if (t.kind === "Char") {
    return {
      empty: "mtoc2_char_tensor_empty",
      assign: "mtoc2_char_tensor_assign",
      copy: "mtoc2_char_tensor_copy",
      free: "mtoc2_char_tensor_free",
      isRuntime: true,
    };
  }
  if (t.kind === "Struct") {
    const name = structTypedefName(t);
    return {
      empty: `${name}_empty`,
      assign: `${name}_assign`,
      copy: `${name}_copy`,
      free: `${name}_free`,
      isRuntime: false,
    };
  }
  if (t.kind === "Class") {
    const name = classTypedefName(t);
    return {
      empty: `${name}_empty`,
      assign: `${name}_assign`,
      copy: `${name}_copy`,
      free: `${name}_free`,
      isRuntime: false,
    };
  }
  if (t.kind === "Handle") {
    const name = handleTypedefName(t);
    return {
      empty: `${name}_empty`,
      assign: `${name}_assign`,
      copy: `${name}_copy`,
      free: `${name}_free`,
      isRuntime: false,
    };
  }
  return null;
}

/** Asserting form: returns helpers for a type known to be owned, and
 *  throws if it isn't. Use this at sites where the caller has already
 *  proven the type is owned (e.g. via `isOwned(t)`) and the null check
 *  would be a redundant nuisance. */
export function requireOwnedHelpers(t: Type): OwnedHelpers {
  const h = ownedHelpersFor(t);
  if (h === null) {
    throw new Error(`requireOwnedHelpers: non-owned type ${t.kind}`);
  }
  return h;
}

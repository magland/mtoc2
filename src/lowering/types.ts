/**
 * mtoc2 type system. Built from scratch — not derived from numbl's
 * JitType. Designed to be the long-term home for static type info,
 * with "exact known value" tracking as a first-class feature on
 * every scalar (and eventually small arrays).
 *
 * MVP scope: scalar real double only. The full Type union and the
 * NumericType field layout already accommodate growth (complex,
 * arrays, strings, logicals, structs, classes) but the lowerer and
 * codegen reject anything outside scope with UnsupportedConstruct.
 */

import type { Span, Stmt } from "../parser/index.js";

type FunctionStmt = Extract<Stmt, { type: "Function" }>;

// ── Sign lattice ────────────────────────────────────────────────────────

export type Sign =
  | "positive" // > 0
  | "nonneg" // >= 0
  | "negative" // < 0
  | "nonpositive" // <= 0
  | "zero" // == 0
  | "nonzero" // != 0
  | "unknown";

export function signFromNumber(v: number): Sign {
  if (Number.isNaN(v)) return "unknown";
  if (v > 0) return "positive";
  if (v < 0) return "negative";
  return "zero";
}

/** Derive the sign of a tensor from its exact data. Returns the
 *  tightest lattice state that holds across every element:
 *  - all `>0` → `positive`
 *  - all `<0` → `negative`
 *  - all `===0` → `zero`
 *  - mix of `>0` and `==0` → `nonneg`
 *  - mix of `<0` and `==0` → `nonpositive`
 *  - mix of `>0` and `<0` (no zeros) → `nonzero`
 *  - any NaN, or mix of all three (positives, negatives, zeros) → `unknown`.
 *
 *  Empty data returns `unknown` (no elements to constrain). */
export function signFromExactArray(data: Float64Array): Sign {
  if (data.length === 0) return "unknown";
  let anyPos = false;
  let anyNeg = false;
  let anyZero = false;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (Number.isNaN(v)) return "unknown";
    if (v > 0) anyPos = true;
    else if (v < 0) anyNeg = true;
    else anyZero = true;
  }
  if (anyPos && anyNeg && anyZero) return "unknown";
  if (anyPos && anyNeg) return "nonzero";
  if (anyPos && anyZero) return "nonneg";
  if (anyNeg && anyZero) return "nonpositive";
  if (anyPos) return "positive";
  if (anyNeg) return "negative";
  return "zero";
}

export function unifySign(a: Sign, b: Sign): Sign {
  if (a === b) return a;
  const s = new Set([a, b]);
  if (s.has("positive") && s.has("zero")) return "nonneg";
  if (s.has("positive") && s.has("nonneg")) return "nonneg";
  if (s.has("negative") && s.has("zero")) return "nonpositive";
  if (s.has("negative") && s.has("nonpositive")) return "nonpositive";
  if (s.has("nonzero") && s.has("positive")) return "nonzero";
  if (s.has("nonzero") && s.has("negative")) return "nonzero";
  return "unknown";
}

export function flipSign(s: Sign): Sign {
  switch (s) {
    case "positive":
      return "negative";
    case "negative":
      return "positive";
    case "nonneg":
      return "nonpositive";
    case "nonpositive":
      return "nonneg";
    default:
      return s;
  }
}

// ── Dimensions ──────────────────────────────────────────────────────────

/** Per-axis dimension knowledge.
 *  - "one" : statically known to be 1 along this axis (i.e. scalar/row/col).
 *  - "notOne" : statically known to be > 1.
 *  - "unknown" : no info.
 */
export type DimInfo =
  | { kind: "one" }
  | { kind: "notOne" }
  | { kind: "unknown" };

export const DIM_ONE: DimInfo = { kind: "one" };

// ── Exact value (for scalars; arrays later, capped) ─────────────────────

/** Cap for how big an "exact array" we'll propagate through the type
 *  system. Anything larger drops to non-exact. */
export const EXACT_ARRAY_MAX_ELEMENTS = 256;

/** Exact-value variants.
 *  - `number`: scalar real.
 *  - `{re,im}`: scalar complex (reserved, not yet wired through).
 *  - `Float64Array`: dense real array, column-major (matches numbl's
 *    `RuntimeTensor.data`). Shape is carried by `dims` on `NumericType`.
 *  Complex-array variant comes later. */
export type NumericExact = number | { re: number; im: number } | Float64Array;

// ── Numeric scalar/tensor type ──────────────────────────────────────────

export type NumericElem = "double" | "logical" | "char";

export interface NumericType {
  kind: "Numeric";
  elem: NumericElem;
  isComplex: boolean;
  /** Abstract per-axis lattice: one / notOne / unknown. Always present.
   *  Length 2 for scalars (`[{one},{one}]`); same length as `shape`
   *  when `shape` is set. */
  dims: DimInfo[];
  /** Statically-known integer shape, when available (always set for
   *  exact tensors; usually set when `exact` is set on a scalar too).
   *  `shape[i] === 1` ↔ `dims[i].kind === "one"`. */
  shape?: number[];
  sign: Sign;
  exact?: NumericExact;
}

export interface StringType {
  kind: "String";
  exact?: string;
}

export interface UnknownType {
  kind: "Unknown";
}

// ── Function-handle type ────────────────────────────────────────────────

/** One captured variable in a `HandleType`. The `name` is both the
 *  enclosing-scope identifier the @-site snapshot reads from AND the
 *  synthesized function's tail-param name; the `ty` is the captured
 *  value's type at the @-site. Captures of owned types (tensors,
 *  structs, classes, other handles) are deep-copied into the handle's
 *  C struct at the `@(...)` site, matching MATLAB by-value capture
 *  semantics; the handle's per-shape `_free` helper releases each
 *  owned field at scope exit. */
export interface HandleCapture {
  name: string;
  ty: Type;
}

/** Function handle. mtoc2 supports only user-function targets
 *  (named `@user_func` and anonymous `@(p1,...,pN) <body>`); `@builtin`
 *  is rejected. Captures may be any non-Void / non-Unknown / non-String
 *  value type — scalar real numeric, tensor, struct, class instance, or
 *  another handle. The handle's C representation is a per-capture-shape
 *  typedef with `_empty / _copy / _assign / _free` helpers, matching
 *  the struct/class owned-value lifecycle. */
export interface HandleType {
  kind: "Handle";
  /** Source-level identifier for the target function. For named
   *  handles, this is the user's name (e.g. `sq`); for anonymous
   *  handles, the synthesized name (e.g. `anon_0`). Used as the
   *  source-name half of the specialization mangling. */
  targetName: string;
  /** Synthesized or pre-scanned `Function` AST handed to
   *  `specializeUserFunction` at every call site. The params list
   *  contains `[...userParams, ...captureNames]` (in that order); the
   *  body's references to a captured variable resolve naturally to the
   *  matching synthesized tail param. */
  ast: FunctionStmt;
  /** Variables captured from the enclosing scope at the `@(...)` site.
   *  Empty for named handles and for capture-free anonymous functions.
   *  Field order matches the synth function's tail params. */
  captures: ReadonlyArray<HandleCapture>;
}

/** "No value" — the type of a call to a user function with zero
 *  outputs. Valid only as the expression type of an `ExprStmt`. Every
 *  other lowering site (Assign RHS, sub-expression of a Binary / Unary
 *  / Call, tensor-literal element, if/while cond, for bounds) rejects
 *  Void with `UnsupportedConstruct`. */
export interface VoidType {
  kind: "Void";
}

/** A struct value. Field order is canonical (sorted by name) so two
 *  StructType values with the same shape are structurally identical
 *  regardless of source-level field-write order. Construct via
 *  `structType()` rather than the raw interface so the sort is
 *  applied. */
export interface StructType {
  kind: "Struct";
  fields: ReadonlyArray<{ name: string; ty: Type }>;
}

/** A class instance value. The `className` is the source-level class
 *  name (the `classdef Foo` identifier); `properties` is the full
 *  flattened-and-sorted property list with each property's type
 *  derived from its `properties` block default expression. v1
 *  forbids inheritance, so the property list is always exactly the
 *  one declared in the class body. */
export interface ClassType {
  kind: "Class";
  className: string;
  properties: ReadonlyArray<{ name: string; ty: Type }>;
}

export type Type =
  | NumericType
  | StringType
  | UnknownType
  | VoidType
  | HandleType
  | StructType
  | ClassType;

export const VOID: VoidType = { kind: "Void" };

// ── Factories ───────────────────────────────────────────────────────────

export function scalarDouble(
  sign: Sign = "unknown",
  exact?: number
): NumericType {
  const t: NumericType = {
    kind: "Numeric",
    elem: "double",
    isComplex: false,
    dims: [DIM_ONE, DIM_ONE],
    shape: [1, 1],
    sign,
  };
  if (exact !== undefined) t.exact = exact;
  return t;
}

export function scalarLogical(exact?: boolean): NumericType {
  const t: NumericType = {
    kind: "Numeric",
    elem: "logical",
    isComplex: false,
    dims: [DIM_ONE, DIM_ONE],
    shape: [1, 1],
    sign: exact === undefined ? "nonneg" : exact ? "positive" : "zero",
  };
  if (exact !== undefined) t.exact = exact ? 1 : 0;
  return t;
}

/** Real-double tensor built from a per-axis `dims` lattice. Used by
 *  slice-read result typing when the slot pattern leaves at least one
 *  axis with a runtime-only length (a `Range` slot whose count isn't a
 *  static literal). When every dim is statically known to be `1` or
 *  `>1`, callers should prefer `tensorDouble(shape)` (concrete shape)
 *  so downstream elementwise ops can use static shape matching.
 *
 *  Trailing singletons in `dims` are stripped subject to a 2-axis
 *  minimum, matching numbl's tensor shape-normalization rule. */
export function tensorDoubleFromDims(dims: DimInfo[]): NumericType {
  const trimmed = dims.slice();
  while (trimmed.length > 2 && trimmed[trimmed.length - 1].kind === "one") {
    trimmed.pop();
  }
  return {
    kind: "Numeric",
    elem: "double",
    isComplex: false,
    dims: trimmed,
    sign: "unknown",
  };
}

/** Real-double tensor with statically-known shape. `dims` is derived
 *  from `shape` (axis of length 1 → `{kind:"one"}`, else
 *  `{kind:"notOne"}`). When `exact` is provided, its length must equal
 *  the shape's product; the layout is column-major (matching numbl's
 *  `RuntimeTensor.data`).
 *
 *  When `exact` is provided, `sign` is derived from the actual values
 *  via `signFromExactArray`. This is what lets `sqrt([0 1 4 9])` pass
 *  the requireDomain check (without it the tensor would carry
 *  `sign:"unknown"`). For tensors without exact data the caller can
 *  set `sign` post-construction (e.g. `zeros`/`ones` know their fill
 *  value even when the result is too large to carry exact data). */
export function tensorDouble(
  shape: number[],
  exact?: Float64Array
): NumericType {
  const dims: DimInfo[] = shape.map(s =>
    s === 1 ? DIM_ONE : { kind: "notOne" }
  );
  const t: NumericType = {
    kind: "Numeric",
    elem: "double",
    isComplex: false,
    dims,
    shape: shape.slice(),
    sign: "unknown",
  };
  if (exact !== undefined) {
    const total = shape.reduce((a, b) => a * b, 1);
    if (exact.length !== total) {
      throw new Error(
        `tensorDouble: shape [${shape.join(",")}] requires ${total} elements, got ${exact.length}`
      );
    }
    t.exact = exact;
    t.sign = signFromExactArray(exact);
  }
  return t;
}

export const UNKNOWN: UnknownType = { kind: "Unknown" };

/** Constructor for a `@<user_func>` handle (named or anonymous). */
export function handleType(
  targetName: string,
  ast: FunctionStmt,
  captures: ReadonlyArray<HandleCapture> = []
): HandleType {
  return { kind: "Handle", targetName, ast, captures };
}

/** Construct a `StructType` with canonical (sorted-by-name) field
 *  order. Two structs built from the same fields end up structurally
 *  equal regardless of the order their fields were specified. */
export function structType(
  fields: ReadonlyArray<{ name: string; ty: Type }>
): StructType {
  const sorted = fields.slice().sort((a, b) => (a.name < b.name ? -1 : 1));
  return { kind: "Struct", fields: sorted };
}

/** Construct a `ClassType` with canonical (sorted-by-name) property
 *  order. */
export function classType(
  className: string,
  properties: ReadonlyArray<{ name: string; ty: Type }>
): ClassType {
  const sorted = properties.slice().sort((a, b) => (a.name < b.name ? -1 : 1));
  return { kind: "Class", className, properties: sorted };
}

// ── Predicates ──────────────────────────────────────────────────────────

export function isNumeric(t: Type): t is NumericType {
  return t.kind === "Numeric";
}

export function isVoid(t: Type): t is VoidType {
  return t.kind === "Void";
}

export function isHandle(t: Type): t is HandleType {
  return t.kind === "Handle";
}

export function isStruct(t: Type): t is StructType {
  return t.kind === "Struct";
}

export function isClass(t: Type): t is ClassType {
  return t.kind === "Class";
}

/** Find a field on a struct/class by name. Returns the field's type
 *  or undefined if the type isn't a struct/class or no such field
 *  exists. */
export function fieldType(t: Type, name: string): Type | undefined {
  if (t.kind === "Struct") {
    const f = t.fields.find(f => f.name === name);
    return f?.ty;
  }
  if (t.kind === "Class") {
    const p = t.properties.find(p => p.name === name);
    return p?.ty;
  }
  return undefined;
}

export function isScalar(t: Type): boolean {
  if (!isNumeric(t)) return false;
  return t.dims.every(d => d.kind === "one");
}

export function isScalarRealDouble(t: Type): boolean {
  return isNumeric(t) && isScalar(t) && t.elem === "double" && !t.isComplex;
}

/** Scalar real numeric: double or logical. Both are stored as `double`
 *  in emitted C, so anything operating on real values accepts either. */
export function isScalarRealNumeric(t: Type): boolean {
  return (
    isNumeric(t) &&
    isScalar(t) &&
    (t.elem === "double" || t.elem === "logical") &&
    !t.isComplex
  );
}

/** True when any axis is statically known to be > 1 (or unknown).
 *  Drives the scalar/tensor split in codegen: scalars compile to bare
 *  `double`; multi-element values compile to `mtoc2_tensor_t`. */
export function isMultiElement(t: Type): boolean {
  return isNumeric(t) && t.dims.some(d => d.kind !== "one");
}

/** Owned-heap-value types — i.e. types whose C representation holds a
 *  heap pointer the codegen must `free` at scope exit. Multi-element
 *  tensors are the original owned kind. Structs, class instances, and
 *  function handles all count as owned because their per-shape generated
 *  typedef carries the same `_empty()`/`_assign()`/`_copy()`/`_free()`
 *  lifecycle — a struct or handle with all-scalar fields would
 *  technically be POD, but tracking ownership uniformly keeps the
 *  codegen pipeline simple and lets struct fields and handle captures
 *  hold tensors transparently. */
export function isOwned(t: Type): boolean {
  if (isMultiElement(t)) return true;
  if (t.kind === "Struct") return true;
  if (t.kind === "Class") return true;
  if (t.kind === "Handle") return true;
  return false;
}

export function signIsNonneg(s: Sign): boolean {
  return s === "positive" || s === "nonneg" || s === "zero";
}

export function signIsPositive(s: Sign): boolean {
  return s === "positive";
}

// ── Exact helpers ───────────────────────────────────────────────────────

export function numericExactsEqual(
  a: NumericExact | undefined,
  b: NumericExact | undefined
): boolean {
  if (a === undefined || b === undefined) return false;
  if (typeof a === "number" && typeof b === "number") {
    return Object.is(a, b);
  }
  const aIsArr = a instanceof Float64Array;
  const bIsArr = b instanceof Float64Array;
  if (aIsArr && bIsArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!Object.is(a[i], b[i])) return false;
    }
    return true;
  }
  if (aIsArr || bIsArr) return false;
  // Both must be {re, im}.
  if (typeof a === "object" && typeof b === "object") {
    return Object.is(a.re, b.re) && Object.is(a.im, b.im);
  }
  return false;
}

/** Strip `exact` from every entry in `env` whose name is in `names`.
 *  Used by loop bodies — see lower.ts for rationale. For struct /
 *  class env entries we recurse via `withoutExact` so any precise
 *  field/property exact values introduced by a `struct(...)` literal
 *  or a constructor preSeed don't leak from iteration 1 into the rest
 *  of the loop's body. */
export function stripExactFromEnv(
  env: Map<string, { cName: string; ty: Type }>,
  names: Iterable<string>
): void {
  for (const n of names) {
    const e = env.get(n);
    if (e === undefined) continue;
    if (e.ty.kind === "Numeric" && e.ty.exact !== undefined) {
      env.set(n, {
        cName: e.cName,
        ty: { ...e.ty, exact: undefined },
      });
    } else if (e.ty.kind === "String" && e.ty.exact !== undefined) {
      env.set(n, { cName: e.cName, ty: { kind: "String" } });
    } else if (e.ty.kind === "Struct" || e.ty.kind === "Class") {
      env.set(n, { cName: e.cName, ty: withoutExact(e.ty) });
    }
  }
}

export function withoutExact(t: Type): Type {
  if (t.kind === "Numeric" && t.exact !== undefined) {
    const { exact: _e, ...rest } = t;
    void _e;
    return rest;
  }
  if (t.kind === "String" && t.exact !== undefined) {
    return { kind: "String" };
  }
  if (t.kind === "Struct") {
    return {
      kind: "Struct",
      fields: t.fields.map(f => ({ name: f.name, ty: withoutExact(f.ty) })),
    };
  }
  if (t.kind === "Class") {
    return {
      kind: "Class",
      className: t.className,
      properties: t.properties.map(p => ({
        name: p.name,
        ty: withoutExact(p.ty),
      })),
    };
  }
  return t;
}

// ── Unify (control-flow merge) ──────────────────────────────────────────

/** Merge two types at a join point. Drops exact unless both sides agree.
 *  Sign widens via `unifySign`. For MVP, both sides should be scalar real
 *  double — mismatches return `UNKNOWN`. */
export function unify(a: Type, b: Type): Type {
  if (a.kind === "Unknown" || b.kind === "Unknown") return UNKNOWN;
  if (a.kind === "Void" || b.kind === "Void") return UNKNOWN;
  if (a.kind === "Numeric" && b.kind === "Numeric") {
    if (a.elem !== b.elem) return UNKNOWN;
    if (a.isComplex !== b.isComplex) return UNKNOWN;
    if (a.dims.length !== b.dims.length) return UNKNOWN;
    const dims = a.dims.map((d, i) => unifyDim(d, b.dims[i]));
    const sign = unifySign(a.sign, b.sign);
    // Shape survives only when both sides agree exactly; otherwise drop.
    let shape: number[] | undefined;
    if (
      a.shape !== undefined &&
      b.shape !== undefined &&
      a.shape.length === b.shape.length &&
      a.shape.every((s, i) => s === b.shape![i])
    ) {
      shape = a.shape.slice();
    }
    const out: NumericType = {
      kind: "Numeric",
      elem: a.elem,
      isComplex: a.isComplex,
      dims,
      sign,
    };
    if (shape !== undefined) out.shape = shape;
    // Exact survives when bit-identical AND shape matched (so tensor
    // shapes can't unify if the data layout differs).
    if (numericExactsEqual(a.exact, b.exact) && shape !== undefined) {
      out.exact = a.exact;
    }
    return out;
  }
  if (a.kind === "String" && b.kind === "String") {
    if (a.exact !== undefined && b.exact !== undefined && a.exact === b.exact) {
      return { kind: "String", exact: a.exact };
    }
    return { kind: "String" };
  }
  if (a.kind === "Handle" && b.kind === "Handle") {
    if (canonicalizeType(a) === canonicalizeType(b)) return a;
    return UNKNOWN;
  }
  if (a.kind === "Struct" && b.kind === "Struct") {
    // Union of field names; per shared field, unify the types. Fields
    // present only on one side carry through unchanged — useful when a
    // conditional branch only writes a subset of the eventual fields.
    const names = new Set<string>();
    for (const f of a.fields) names.add(f.name);
    for (const f of b.fields) names.add(f.name);
    const out: { name: string; ty: Type }[] = [];
    for (const name of names) {
      const fa = a.fields.find(f => f.name === name);
      const fb = b.fields.find(f => f.name === name);
      if (fa && fb) out.push({ name, ty: unify(fa.ty, fb.ty) });
      else if (fa) out.push({ name, ty: fa.ty });
      else if (fb) out.push({ name, ty: fb.ty });
    }
    return structType(out);
  }
  if (a.kind === "Class" && b.kind === "Class") {
    if (a.className !== b.className) return UNKNOWN;
    // Same class: per-property unify. Property sets must already
    // match (defined by the classdef body, which is global).
    if (a.properties.length !== b.properties.length) return UNKNOWN;
    const props: { name: string; ty: Type }[] = [];
    for (const pa of a.properties) {
      const pb = b.properties.find(p => p.name === pa.name);
      if (!pb) return UNKNOWN;
      props.push({ name: pa.name, ty: unify(pa.ty, pb.ty) });
    }
    return classType(a.className, props);
  }
  return UNKNOWN;
}

function unifyDim(a: DimInfo, b: DimInfo): DimInfo {
  if (a.kind === b.kind) return a;
  return { kind: "unknown" };
}

// ── Pretty-print (for diagnostics) ──────────────────────────────────────

export function typeToString(t: Type): string {
  switch (t.kind) {
    case "Unknown":
      return "unknown";
    case "Void":
      return "void";
    case "String":
      return t.exact !== undefined ? `string="${t.exact}"` : "string";
    case "Numeric": {
      let s: string = t.elem;
      if (t.isComplex) s = `complex(${s})`;
      const dimsStr =
        t.shape !== undefined
          ? t.shape.join("×")
          : t.dims
              .map(d =>
                d.kind === "one" ? "1" : d.kind === "notOne" ? ">1" : "?"
              )
              .join("×");
      s += `[${dimsStr}]`;
      if (t.sign !== "unknown") s += `:${t.sign}`;
      if (t.exact !== undefined) s += `=${formatExactForType(t.exact)}`;
      return s;
    }
    case "Handle": {
      const caps =
        t.captures.length === 0
          ? ""
          : `{${t.captures.map(c => `${c.name}:${typeToString(c.ty)}`).join(",")}}`;
      return `@${t.targetName}${caps}`;
    }
    case "Struct": {
      const inner = t.fields
        .map(f => `${f.name}:${typeToString(f.ty)}`)
        .join(", ");
      return `struct{${inner}}`;
    }
    case "Class": {
      const inner = t.properties
        .map(p => `${p.name}:${typeToString(p.ty)}`)
        .join(", ");
      return `class ${t.className}{${inner}}`;
    }
  }
}

function formatExactForType(e: NumericExact): string {
  if (typeof e === "number") return JSON.stringify(e);
  if (e instanceof Float64Array) {
    const cap = 8;
    const preview = Array.from(e.slice(0, cap)).map(v => v.toString());
    if (e.length > cap) preview.push("…");
    return `[${preview.join(", ")}]`;
  }
  return `(${e.re}+${e.im}i)`;
}

// ── Canonicalize + hash (for function specialization keys) ──────────────

/** Stable string key used for the specialization-key hash. Includes
 *  exact when set, so each unique exact-value gets its own spec. */
export function canonicalizeType(t: Type): string {
  return JSON.stringify(canon(t));
}

/** True iff two types have the same canonical form. Convenience
 *  wrapper around `canonicalizeType` for callers that don't need the
 *  string key. */
export function canonicalEq(a: Type, b: Type): boolean {
  return canonicalizeType(a) === canonicalizeType(b);
}

/** Storage compatibility: do two types occupy the same C-level slot?
 *  This is COARSER than canonical equality — every multi-element
 *  tensor shares the same `mtoc2_tensor_t` storage regardless of
 *  shape, every scalar real numeric maps to `double`, and every
 *  struct/class needs its canonical typedef to match.
 *
 *  Used by `MemberStore` to validate that a write doesn't try to
 *  cram a tensor into a scalar slot (or vice versa) — the typedef
 *  hash is built from storage shapes, so changing the underlying
 *  representation would break the C side. Shape, sign, and exact
 *  differences are fine: the slot still holds an `mtoc2_tensor_t`. */
export function storageEquivalent(a: Type, b: Type): boolean {
  // Two types occupy the same C slot iff they reduce to the same
  // C-type string. `cFieldTypeStr` already collapses everything that
  // doesn't matter at the C level (sign, exact, tensor shape, the
  // distinction between same-class instances), so this is one line.
  try {
    return cFieldTypeStr(a) === cFieldTypeStr(b);
  } catch {
    // One side is a String/Void/Unknown (or similar non-field-typed
    // value). Those never share a slot with anything legitimate.
    return false;
  }
}

function canon(t: Type): unknown {
  switch (t.kind) {
    case "Unknown":
      return { k: "U" };
    case "Void":
      return { k: "V" };
    case "String":
      return t.exact !== undefined ? { k: "S", x: t.exact } : { k: "S" };
    case "Numeric": {
      const out: Record<string, unknown> = {
        k: "N",
        e: t.elem,
        c: t.isComplex,
        d: t.dims.map(d => d.kind),
        s: t.sign,
      };
      if (t.shape !== undefined) out.sh = t.shape;
      if (t.exact !== undefined) {
        if (t.exact instanceof Float64Array) {
          out.x = Array.from(t.exact);
        } else {
          out.x = t.exact;
        }
      }
      return out;
    }
    case "Handle":
      // The AST is intentionally NOT serialized — it would bloat the
      // canonical string and isn't part of the type's observable
      // shape. Two handles with the same targetName + captures (by
      // name and canonical type) share a specialization key.
      return {
        k: "H",
        n: t.targetName,
        c: t.captures.map(c => [c.name, canon(c.ty)]),
      };
    case "Struct":
      return {
        k: "St",
        f: t.fields.map(f => [f.name, canon(f.ty)]),
      };
    case "Class":
      return {
        k: "C",
        n: t.className,
        p: t.properties.map(p => [p.name, canon(p.ty)]),
      };
  }
}

/** FNV-1a 32-bit; matches the mangling scheme used in current mtoc. */
export function hashType(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function specializationKey(argTypes: Type[]): string {
  return hashType(argTypes.map(canonicalizeType).join("|"));
}

/** Mangled C typedef name for a handle's capture shape. All no-capture
 *  handles share `mtoc2_handle_empty_t` regardless of target identity
 *  (the function dispatch is static — the struct is just a carrier).
 *  Handles with captures get a per-shape `mtoc2_handle__<8hex>` typedef
 *  whose hash covers the `(name, cFieldTypeStr)` tuple of each capture
 *  in order. Matches the struct/class precedent: the typedef hash sees
 *  only the C-level type of each capture, so two handle types that
 *  differ only in lattice precision (sign, exact, tensor shape) share
 *  one typedef and one set of owned-helpers. */
export function handleTypedefName(t: HandleType): string {
  if (t.captures.length === 0) return "mtoc2_handle_empty_t";
  const canonical = JSON.stringify(
    t.captures.map(c => [c.name, cFieldTypeStr(c.ty)])
  );
  return `mtoc2_handle__${hashType(canonical)}`;
}

/** C-level type string for a struct/class field or function-handle
 *  capture. This is the load-bearing identity for typedef hashing:
 *  the typedef hash depends only on `cFieldTypeStr` per field, so
 *  two structs whose internal field types differ only in lattice
 *  precision (sign, exact, tensor shape) collapse to the SAME C
 *  typedef. The internal `StructType.fields[*].ty` is free to keep
 *  full precision — that precision drives function specialization
 *  keys and builtin transfer functions but does NOT shard the C
 *  typedef.
 *
 *  - Scalar real numeric (any sign/exact)   → "double"
 *  - Multi-element tensor (any shape/exact) → "mtoc2_tensor_t"
 *  - Handle                                  → handleTypedefName(t)
 *  - Struct (recurse on fields)              → structTypedefName(t)
 *  - Class (recurse on properties)           → classTypedefName(t)
 *
 *  String / Void / Unknown are not valid struct/class field types
 *  in v1 — the lowerer rejects them at construction sites. */
export function cFieldTypeStr(t: Type): string {
  if (t.kind === "Numeric") {
    if (isMultiElement(t)) return "mtoc2_tensor_t";
    return "double";
  }
  if (t.kind === "Handle") return handleTypedefName(t);
  if (t.kind === "Struct") return structTypedefName(t);
  if (t.kind === "Class") return classTypedefName(t);
  throw new Error(
    `cFieldTypeStr: type '${t.kind}' is not a valid struct/class field type`
  );
}

/** Mangled C typedef name for a struct's shape. Keyed only on the
 *  C-level type of each field (`cFieldTypeStr`), so two struct
 *  values whose fields' internal types differ only in lattice
 *  precision share one typedef. The internal `StructType.fields[*].ty`
 *  is still carried at full precision for spec keying + transfer-fn
 *  use — but it's separate from the typedef identity. */
export function structTypedefName(t: StructType): string {
  const canonical = JSON.stringify(
    t.fields.map(f => [f.name, cFieldTypeStr(f.ty)])
  );
  return `mtoc2_struct__${hashType(canonical)}`;
}

/** Sanitize a class name to a C-identifier-safe form (replace any
 *  non-`[A-Za-z0-9_]` char with `_`). v1 only accepts unqualified
 *  class names so this is a passthrough for typical inputs. */
function safeClassNameForC(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

/** Mangled C typedef name for a class instance. Same C-level
 *  contract as `structTypedefName` — the hash sees only the C-level
 *  type of each property — but salted with `className` so two
 *  distinct classes with the same C-level property shape still pick
 *  distinct typedefs. */
export function classTypedefName(t: ClassType): string {
  const canonical = JSON.stringify({
    n: t.className,
    p: t.properties.map(p => [p.name, cFieldTypeStr(p.ty)]),
  });
  return `mtoc2_class_${safeClassNameForC(t.className)}__${hashType(canonical)}`;
}

/** Class-method specialization-name source. Becomes the input to
 *  `mangleClassMethodName` along with arg-type canonicalization. */
export function classMethodSpecSource(
  className: string,
  methodName: string
): string {
  return `${className}__${methodName}`;
}

// ── Span re-export for convenience ──────────────────────────────────────

export type { Span };

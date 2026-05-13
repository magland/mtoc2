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

import type { Span } from "../parser/index.js";

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

export type Type = NumericType | StringType | UnknownType;

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

/** Real-double tensor with statically-known shape. `dims` is derived
 *  from `shape` (axis of length 1 → `{kind:"one"}`, else
 *  `{kind:"notOne"}`). When `exact` is provided, its length must equal
 *  the shape's product; the layout is column-major (matching numbl's
 *  `RuntimeTensor.data`). */
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
  }
  return t;
}

export const UNKNOWN: UnknownType = { kind: "Unknown" };

// ── Predicates ──────────────────────────────────────────────────────────

export function isNumeric(t: Type): t is NumericType {
  return t.kind === "Numeric";
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
 *  Used by loop bodies — see lower.ts for rationale. */
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
  return t;
}

// ── Unify (control-flow merge) ──────────────────────────────────────────

/** Merge two types at a join point. Drops exact unless both sides agree.
 *  Sign widens via `unifySign`. For MVP, both sides should be scalar real
 *  double — mismatches return `UNKNOWN`. */
export function unify(a: Type, b: Type): Type {
  if (a.kind === "Unknown" || b.kind === "Unknown") return UNKNOWN;
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

function canon(t: Type): unknown {
  switch (t.kind) {
    case "Unknown":
      return { k: "U" };
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

// ── Span re-export for convenience ──────────────────────────────────────

export type { Span };

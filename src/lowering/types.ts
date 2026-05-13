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
 *  system. Anything larger drops to non-exact. Unused at MVP.
 */
export const EXACT_ARRAY_MAX_ELEMENTS = 256;

/** Exact-value variants. MVP uses only `number`.
 *  Future: `{re,im}` for scalar complex, then array-shaped variants. */
export type NumericExact = number | { re: number; im: number };

// ── Numeric scalar/tensor type ──────────────────────────────────────────

export type NumericElem = "double" | "logical" | "char";

export interface NumericType {
  kind: "Numeric";
  elem: NumericElem;
  isComplex: boolean;
  /** One DimInfo per axis. Length 2 for MVP (everything is [1×1] scalar). */
  dims: DimInfo[];
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
    sign: exact === undefined ? "nonneg" : exact ? "positive" : "zero",
  };
  if (exact !== undefined) t.exact = exact ? 1 : 0;
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
    const out: NumericType = {
      kind: "Numeric",
      elem: a.elem,
      isComplex: a.isComplex,
      dims,
      sign,
    };
    if (numericExactsEqual(a.exact, b.exact) && isAllOne(dims)) {
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

function isAllOne(dims: DimInfo[]): boolean {
  return dims.every(d => d.kind === "one");
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
      const dimsStr = t.dims
        .map(d => (d.kind === "one" ? "1" : d.kind === "notOne" ? ">1" : "?"))
        .join("×");
      s += `[${dimsStr}]`;
      if (t.sign !== "unknown") s += `:${t.sign}`;
      if (t.exact !== undefined) s += `=${JSON.stringify(t.exact)}`;
      return s;
    }
  }
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
      if (t.exact !== undefined) out.x = t.exact;
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

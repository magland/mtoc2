/**
 * Helpers shared across multiple builtin files.
 */

import type { Span } from "../../parser/index.js";
import { TypeError } from "../errors.js";
import { type Type, isScalarRealDouble, isNumeric } from "../types.js";

export function requireScalarRealDouble(
  t: Type,
  what: string,
  span: Span
): void {
  if (!isScalarRealDouble(t)) {
    throw new TypeError(
      `${what} must be a scalar real double (got ${t.kind})`,
      span
    );
  }
}

/** Like `requireScalarRealDouble` but accepts non-scalar real doubles
 *  (the elemwise path). Logical also accepted (stored as double in C). */
export function requireRealDouble(t: Type, what: string, span: Span): void {
  if (!isNumeric(t) || t.isComplex) {
    throw new TypeError(`${what} must be a real numeric (got ${t.kind})`, span);
  }
  if (t.elem !== "double" && t.elem !== "logical") {
    throw new TypeError(
      `${what} must be double or logical (got ${t.elem})`,
      span
    );
  }
}

export function exactDouble(t: Type): number | undefined {
  if (!isNumeric(t)) return undefined;
  if (t.exact === undefined) return undefined;
  if (typeof t.exact === "number") return t.exact;
  return undefined;
}

export function exactRealArray(t: Type): Float64Array | undefined {
  if (!isNumeric(t)) return undefined;
  if (t.exact instanceof Float64Array) return t.exact;
  return undefined;
}

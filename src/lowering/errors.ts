/**
 * mtoc2 lowering errors. All errors carry a `Span` so the CLI can
 * point at the offending source location.
 */

import type { Span } from "../parser.js";

export class UnsupportedConstruct extends Error {
  span: Span;
  constructor(message: string, span: Span) {
    super(message);
    this.name = "UnsupportedConstruct";
    this.span = span;
  }
}

export class TypeError extends Error {
  span: Span;
  constructor(message: string, span: Span) {
    super(message);
    this.name = "TypeError";
    this.span = span;
  }
}

export function formatError(
  e: UnsupportedConstruct | TypeError,
  source: string
): string {
  const { line, col } = offsetToLineCol(source, e.span.start);
  return `${e.span.file}:${line}:${col}: ${e.name}: ${e.message}`;
}

function offsetToLineCol(
  source: string,
  offset: number
): { line: number; col: number } {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}

import type { CToken } from "./lexer.js";

export function parse(tokens: CToken[], filename?: string): unknown;

export interface CToken {
  type: string;
  value: unknown;
  line: number;
  col: number;
  isFloat?: boolean;
  text?: string;
}

export function tokenize(src: string, filename?: string): CToken[];
export function stripComments(src: string): string;
export const KEYWORDS: Set<string>;

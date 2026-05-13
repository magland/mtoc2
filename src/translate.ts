/**
 * Single entry point for translating numbl source into C. Used by both
 * the CLI (`src/cli/index.ts`) and the web IDE
 * (`src/components/IDEWorkspace.tsx`).
 *
 * MVP scope is single-file: the named active file is parsed, lowered,
 * and emitted. Other files in `files` are recorded but their function
 * defs are not yet visible to the active file (mtoc1's workspace
 * resolution will come back online in a later milestone).
 *
 * Errors are normalized into a single shape and returned (never thrown);
 * callers can render them inline without a try/catch dance.
 */
import { parseMFile, SyntaxError as ParseSyntaxError } from "./parser/index.js";
import { UnsupportedConstruct, TypeError } from "./lowering/errors.js";
import { Lowerer } from "./lowering/lower.js";
import { emitProgram } from "./codegen/emit.js";

export interface SourceFile {
  /** File name used in error attribution. */
  name: string;
  source: string;
}

export interface TranslateError {
  kind: "SyntaxError" | "UnsupportedConstruct" | "TypeError";
  message: string;
  fileName?: string;
  startOffset?: number;
  endOffset?: number;
}

export interface TranslateResult {
  c?: string;
  error?: TranslateError;
}

export interface TranslateOptions {
  /** Reserved for future use; mtoc2 always inlines runtime helpers. */
  includeRuntime?: boolean;
  /** Reserved for future use. */
  searchPaths?: ReadonlyArray<string>;
  /** Reserved for future use. */
  enableTempInlining?: boolean;
  /** Reserved for future use. */
  threads?: number | "auto";
}

export function translateProject(
  files: SourceFile[],
  activeName: string,
  opts: TranslateOptions = {}
): TranslateResult {
  const includeRuntime = opts.includeRuntime ?? true;
  const active = files.find(f => f.name === activeName);
  if (!active) {
    return {
      error: {
        kind: "UnsupportedConstruct",
        message: `active file '${activeName}' is not in the project`,
      },
    };
  }

  let ast;
  try {
    ast = parseMFile(active.source, active.name);
  } catch (e) {
    if (e instanceof ParseSyntaxError) {
      return { error: normalizeSyntaxError(e, files) };
    }
    throw e;
  }

  try {
    const lowerer = new Lowerer();
    const prog = lowerer.lowerProgram(ast);
    return { c: emitProgram(prog, { includeRuntime }) };
  } catch (e) {
    if (e instanceof UnsupportedConstruct || e instanceof TypeError) {
      return {
        error: {
          kind: e.name as "UnsupportedConstruct" | "TypeError",
          message: e.message,
          fileName: e.span?.file ?? activeName,
          startOffset: e.span?.start,
          endOffset: e.span?.end,
        },
      };
    }
    throw e;
  }
}

function normalizeSyntaxError(
  e: ParseSyntaxError,
  files: SourceFile[]
): TranslateError {
  const fileName = e.file ?? undefined;
  const file = fileName ? files.find(f => f.name === fileName) : undefined;
  const len = file?.source.length;
  let start = e.position;
  let end = e.position + 1;
  if (typeof len === "number") {
    if (start > len) start = len;
    if (end > len) end = len;
  }
  return {
    kind: "SyntaxError",
    message: e.message,
    fileName,
    startOffset: start,
    endOffset: end,
  };
}

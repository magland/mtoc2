/**
 * Single entry point for translating numbl source into C. Used by both
 * the CLI (`src/cli.ts`) and the web IDE
 * (`src/components/IDEWorkspace.tsx`).
 *
 * Multi-file projects: every file in `files` is parsed and registered
 * with the `Workspace`. The active file is the entry — its top-level
 * script body is lowered. Sibling files become workspace functions
 * (callable by their bare filename) and class definitions; numbl's
 * `resolveFunction` (vendored via sibling-relative import) decides
 * which file each call site resolves to, honoring MATLAB's full
 * precedence ladder.
 *
 * Errors are normalized into a single shape and returned (never thrown);
 * callers can render them inline without a try/catch dance.
 */
import { SyntaxError as ParseSyntaxError } from "./parser/index.js";
import { UnsupportedConstruct, TypeError } from "./lowering/errors.js";
import { Lowerer } from "./lowering/lower.js";
import { emitProgram } from "./codegen/emit.js";
import { inlinePass } from "./codegen/inlinePass.js";
import { Workspace, parseFiles } from "./workspace/workspace.js";

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
  /** When false, the emitter omits the activated runtime helpers
   *  (replaced by a placeholder comment) — used by the IDE's "runtime
   *  helpers" toggle to show user-level code in isolation. The result
   *  is not compilable in that mode. Defaults to true. */
  includeRuntime?: boolean;
  /** Reserved for future use. */
  searchPaths?: ReadonlyArray<string>;
  /** Max-threads OpenMP setting. Affects codegen only when set to a
   *  numeric value `>= 2`: in that case `<omp.h>` is included and the
   *  emitted `main()` calls `omp_set_num_threads(N)` once at startup.
   *  `"auto"` and `1` (default) emit no OMP-specific code; the
   *  `_Pragma("omp parallel for …")` lines in the elementwise runtime
   *  macros activate purely via `-fopenmp` defining `_OPENMP`. */
  threads?: number | "auto";
  /** Run the IR-level temp-inlining pass before codegen. Substitutes
   *  every single-use multi-element tensor Assign's RHS into its
   *  unique consumer, eliminating intermediates that the un-inlined
   *  ANF form materializes. See `src/codegen/inlinePass.ts`. */
  enableTempInlining?: boolean;
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

  // Parse every file in the project up-front. Workspace files
  // (siblings of the active file) need to be parsed so numbl's
  // resolver can index their subfunctions / classdefs even if the
  // active file never calls into them. Parser errors are reported
  // for whichever file failed.
  let workspaceFiles;
  try {
    workspaceFiles = parseFiles(files);
  } catch (e) {
    if (e instanceof ParseSyntaxError) {
      return { error: normalizeSyntaxError(e, files) };
    }
    throw e;
  }
  const activeWsFile = workspaceFiles.find(f => f.name === activeName);
  if (!activeWsFile?.ast) {
    return {
      error: {
        kind: "UnsupportedConstruct",
        message: `active file '${activeName}' produced no AST`,
      },
    };
  }

  const workspace = new Workspace(activeName, opts.searchPaths ?? []);
  for (const f of workspaceFiles) {
    workspace.addFile(f);
  }

  try {
    const lowerer = new Lowerer(workspace);
    const prog = lowerer.lowerProgram(activeWsFile.ast);
    if (opts.enableTempInlining) inlinePass(prog);
    return {
      c: emitProgram(prog, {
        includeRuntime,
        threads: opts.threads,
        workspace,
      }),
    };
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

/**
 * Workspace + cross-file function dispatch.
 *
 * Thin adapter over numbl's vendored `LoweringContext` (see
 * [../parser/index.ts](../parser/index.ts) for how mtoc2 imports
 * numbl directly via sibling-relative paths). Numbl's
 * `resolveFunction` is the source of truth for "which function does
 * `foo(...)` refer to from this call site"; it implements MATLAB's
 * precedence rules (local > workspace > builtin, plus class-method
 * dispatch on `obj.method(args)` and `ClassName.method(args)`).
 * mtoc2 translates the result back into its own narrow
 * `ResolvedTarget` shape and fences off everything outside v1
 * (private/, +pkg/ namespaces, .numbl.js, imports) with a clean
 * `UnsupportedConstruct`.
 *
 * mtoc2's `MType → ItemType` adapter is intentionally lossy: the
 * resolver inspects `kind === "ClassInstance"` (and only the
 * `className` there); every other shape collapses to `Unknown`.
 * That's all the resolver needs to apply class-method precedence.
 */

import type { AbstractSyntaxTree, Stmt, Span } from "../parser/index.js";
import { parseMFile } from "../parser/index.js";
import { LoweringContext } from "../../../numbl/src/numbl-core/lowering/loweringContext.js";
import { resolveFunction } from "../../../numbl/src/numbl-core/functionResolve.js";
import type { CallSite } from "../../../numbl/src/numbl-core/runtime/runtimeHelpers.js";
import type { ItemType } from "../../../numbl/src/numbl-core/lowering/itemTypes.js";
import type { ClassInfo } from "../../../numbl/src/numbl-core/lowering/classInfo.js";

import { UnsupportedConstruct } from "../lowering/errors.js";
import type { Type } from "../lowering/types.js";
import {
  registerClassDef,
  type ClassRegistration,
} from "../lowering/classDefs.js";
import type { Builtin } from "../lowering/builtins/registry.js";
import { loadMtoc2UserFunction } from "./mtoc2UserFunctionLoader.js";

type FuncStmt = Extract<Stmt, { type: "Function" }>;
type ClassDefStmt = Extract<Stmt, { type: "ClassDef" }>;

export interface WorkspaceFile {
  /** Absolute (or web-IDE-flat) file name used in error attribution
   *  and in numbl's resolver. Numbl uses `fileToFuncName` to derive
   *  bare workspace-function names from this. */
  name: string;
  source: string;
  /** Pre-parsed AST. Set by `Workspace.addFile`; callers populate
   *  it via `parseMFile` before registration. */
  ast?: AbstractSyntaxTree;
}

/** Narrow shape mtoc2 cares about. The resolver may return additional
 *  kinds (private, JS user functions, ...) — those are fenced off
 *  here with `UnsupportedConstruct` so the diagnostic gets a span at
 *  the call site. */
export type ResolvedTarget =
  | {
      kind: "userFunction";
      /** Source-level name (as written at the call site). */
      name: string;
      /** AST of the function definition. */
      ast: FuncStmt;
      /** Source file the function lives in. Used to salt
       *  specialization mangling so two files defining a subfunction
       *  with the same name get distinct C names. */
      file: string;
    }
  | {
      /** Numbl says this name resolves to a builtin. mtoc2 still
       *  validates it against its own builtin registry. */
      kind: "builtin";
      name: string;
    }
  | {
      /** A `.mtoc2.js` user function discovered in the workspace.
       *  The evaluated `Builtin` lives in `Workspace.userBuiltins` —
       *  fetch via `getUserBuiltin(name)` for both lowering and
       *  codegen. The resolved-target carries the source-level name
       *  (which the lowerer also uses as the emitted C call name). */
      kind: "mtoc2UserFunction";
      name: string;
      file: string;
    }
  | {
      /** `Foo(args)` — class constructor call. The class is looked
       *  up in `Workspace.classes`. */
      kind: "classConstructor";
      className: string;
    }
  | {
      /** Class method dispatch — covers `obj.method(args)`,
       *  `method(obj, args)`, and `ClassName.staticMethod(args)`. */
      kind: "classMethod";
      className: string;
      methodName: string;
      /** When true the receiver is NOT passed as a C arg (a static
       *  method called via `ClassName.method(args)` or via instance-
       *  style `obj.staticMethod(args)`). When false the receiver is
       *  the implicit first C arg. */
      stripInstance: boolean;
    };

export class Workspace {
  /** File source + AST, keyed by file name. The AST cache is also
   *  mirrored into the vendored LoweringContext, but this side map
   *  keeps `source` retrievable for diagnostics
   *  (`offsetToLineCol`). */
  readonly files: Map<string, WorkspaceFile> = new Map();
  /** The entry file (active file) — bare-name calls from sibling
   *  files don't see its local functions. */
  readonly mainFile: string;
  /** Search paths used by the vendored resolver to compute relative
   *  paths (and hence workspace-function names). For the CLI,
   *  `[dirname(absoluteEntry)]`. For the web IDE (flat file names),
   *  empty — the resolver treats every name as already-relative. */
  readonly searchPaths: ReadonlyArray<string>;

  /** Numbl resolution context. Holds the workspace registry
   *  (`filesByFuncName`, `classesByName`, `localClassesByName`) and
   *  the `FunctionIndex` used by `resolveFunction`. */
  readonly ctx: LoweringContext;

  /** Resolved class registry — populated by `finalize()` by walking
   *  every classdef numbl knows about (workspace + local) and
   *  applying mtoc2's validation/property-type inference. */
  classes: Map<string, ClassRegistration> = new Map();

  /** Workspace-scoped `Builtin` objects loaded from `.mtoc2.js` files.
   *  Keyed by source-level function name (matches numbl's
   *  `mtoc2UserFunctionsByName` keys). Populated lazily by `finalize`. */
  private userBuiltins: Map<string, Builtin> = new Map();

  private finalized = false;

  constructor(mainFile: string, searchPaths: ReadonlyArray<string> = []) {
    this.mainFile = mainFile;
    this.searchPaths = searchPaths;
    this.ctx = new LoweringContext("", mainFile);
    this.ctx.registry.searchPaths = [...searchPaths];
  }

  /** Register a file by name.
   *
   *  - `.m` files require a pre-parsed `ast` (from `parseMFile`) so
   *    numbl's resolver and mtoc2's lowerer share one cached AST per
   *    file.
   *  - `.mtoc2.js` files carry source text only; the workspace passes
   *    the source to numbl's registry under the function's basename
   *    and (later) evaluates the JS via `loadMtoc2UserFunctions`. No
   *    AST is required. */
  addFile(file: WorkspaceFile): void {
    if (file.name.endsWith(".mtoc2.js")) {
      this.files.set(file.name, file);
      return;
    }
    if (!file.ast) {
      throw new Error(
        `Workspace.addFile: '${file.name}' must be pre-parsed (ast missing)`
      );
    }
    this.files.set(file.name, file);
    this.ctx.fileASTCache.set(file.name, file.ast);
  }

  /** Build the function index + class registry. Call once after
   *  every file has been added. Subsequent calls are no-ops. */
  finalize(): void {
    if (this.finalized) return;

    // Register top-level functions and classdefs from the MAIN file.
    // These have a different visibility rule (local-to-main, not
    // callable from siblings) than workspace files. Workspace files
    // are registered en masse below — `registerWorkspaceFiles`
    // detects classdef-headed files via a source-text sniff.
    const mainEntry = this.files.get(this.mainFile);
    if (mainEntry?.ast) {
      for (const s of mainEntry.ast.body) {
        if (s.type === "Function") {
          this.ctx.registerLocalFunctionAST(s);
        } else if (s.type === "ClassDef") {
          this.ctx.registerLocalClass(s);
        }
      }
    }

    // Workspace files = everything except the main file.
    const wsFiles = [...this.files.values()]
      .filter(f => f.name !== this.mainFile)
      .map(f => ({ name: f.name, source: f.source }));
    this.ctx.registerWorkspaceFiles(wsFiles);
    this.ctx.buildFunctionIndex();

    // Build the mtoc2-shaped class registry from every classdef
    // numbl knows about. We re-walk the parsed AST (numbl's ClassInfo
    // has the AST attached) to apply mtoc2's stricter validation —
    // class attributes / inheritance / events / etc. all reject at
    // this point, before any constructor specialization runs.
    //
    // `@ClassName/<methodName>.m` external method files are already
    // discovered and parsed by numbl during `registerWorkspaceFiles`
    // (they live in `info.externalMethodFiles`, with their ASTs in
    // `ctx.fileASTCache`). We pluck out each file's primary Function
    // statement and feed them into `registerClassDef` so they join
    // the same validation pipeline as in-body methods.
    for (const [name, info] of this.ctx.registry.classesByName) {
      this.classes.set(
        name,
        registerClassDef(
          info.ast,
          info.fileName,
          this.collectExternalMethods(info)
        )
      );
    }
    for (const [name, info] of this.ctx.registry.localClassesByName) {
      if (this.classes.has(name)) {
        // A workspace file already registered this name as a class;
        // a local class with the same name is a conflict.
        throw new UnsupportedConstruct(
          `class '${name}' is defined both locally and as a workspace class`,
          info.ast.span
        );
      }
      this.classes.set(name, registerClassDef(info.ast, info.fileName));
    }

    // Reject classes that shadow a registered workspace function or
    // a builtin: call-site dispatch routes by name, so disambiguation
    // would be ambiguous.
    const fi = this.ctx.functionIndex;
    for (const [cName, reg] of this.classes) {
      if (fi.builtins.has(cName)) {
        throw new UnsupportedConstruct(
          `class '${cName}' shadows a builtin with the same name`,
          reg.constructor?.span ?? this.spanFromClassFile(reg)
        );
      }
    }

    // Evaluate every `.mtoc2.js` user function numbl discovered. Each
    // file's source runs through `new Function` once here; errors
    // (parse, throw at top-level, missing fields, cBody-eval failure)
    // surface as UnsupportedConstruct at workspace-init time, NOT
    // lazily at first call site — so a broken user file fails fast
    // with a clear file attribution rather than confusingly later.
    //
    // The workspace-relative path is used as the prefix-hash input so
    // two `.mtoc2.js` files with the same function name in different
    // directories (or different packages) get distinct C-namespace
    // prefixes for their private helpers.
    for (const [funcName, entry] of this.ctx.registry
      .mtoc2UserFunctionsByName) {
      const relPath = this.workspaceRelativePath(entry.fileName);
      const b = loadMtoc2UserFunction(
        entry.fileName,
        entry.source,
        funcName,
        relPath
      );
      this.userBuiltins.set(funcName, b);
    }

    this.finalized = true;
  }

  /** Compute the workspace-relative path for `absPath`. Used to hash
   *  per-file C-namespace prefixes for `.mtoc2.js` user functions so
   *  the same hash falls out regardless of where the project lives
   *  on disk. Falls back to the bare basename when no search path
   *  contains the file (web IDE, ad-hoc absolute path outside the
   *  entry's directory). */
  private workspaceRelativePath(absPath: string): string {
    let best = "";
    for (const sp of this.searchPaths) {
      const prefix = sp.endsWith("/") ? sp : sp + "/";
      if (absPath.startsWith(prefix) && prefix.length > best.length) {
        best = prefix;
      }
    }
    if (best) return absPath.slice(best.length);
    // No search path matched (e.g. web IDE flat layout). Fall back to
    // the basename — stable enough since names within a workspace
    // are unique anyway.
    const i = absPath.lastIndexOf("/");
    return i >= 0 ? absPath.slice(i + 1) : absPath;
  }

  /** Look up an evaluated `.mtoc2.js` user function by source-level
   *  name. Returns `undefined` if no such workspace user function
   *  exists. Both the lowerer and codegen consult this — the former
   *  to call `transfer`, the latter to call `emit`. */
  getUserBuiltin(name: string): Builtin | undefined {
    this.finalize();
    return this.userBuiltins.get(name);
  }

  /** Pull the primary Function AST from each `@ClassName/<methodName>.m`
   *  external method file that numbl registered for `info`. Methods that
   *  declare local helper functions in the same file are not yet
   *  supported by mtoc2 (numbl's `withMethodScope` swaps them in at
   *  lowering time; mtoc2 has no equivalent). Returns `undefined` when
   *  the class has no external methods, so the call site keeps the
   *  pre-existing register signature unchanged. */
  private collectExternalMethods(
    info: ClassInfo
  ): Map<string, FuncStmt> | undefined {
    if (info.externalMethodFiles.size === 0) return undefined;
    const out = new Map<string, FuncStmt>();
    for (const [methodName, mf] of info.externalMethodFiles) {
      const ast = this.ctx.fileASTCache.get(mf.fileName);
      if (!ast) {
        throw new UnsupportedConstruct(
          `internal: external method file '${mf.fileName}' for ` +
            `'${info.qualifiedName}.${methodName}' was not parsed`,
          info.ast.span
        );
      }
      let primary: FuncStmt | null = null;
      let helperCount = 0;
      for (const stmt of ast.body) {
        if (stmt.type !== "Function") continue;
        if (stmt.name === methodName) {
          primary = stmt;
        } else {
          helperCount++;
        }
      }
      if (!primary) {
        throw new UnsupportedConstruct(
          `external method file '${mf.fileName}' has no function named ` +
            `'${methodName}'`,
          info.ast.span
        );
      }
      if (helperCount > 0) {
        throw new UnsupportedConstruct(
          `external method file '${mf.fileName}' declares local helper ` +
            `functions; per-method helper scope is not yet supported by mtoc2`,
          primary.span
        );
      }
      out.set(methodName, primary);
    }
    return out;
  }

  private spanFromClassFile(reg: ClassRegistration): Span {
    // Fallback span for classes without a constructor (no FuncStmt to
    // borrow a span from). Find the ClassDef stmt in the file's AST.
    const fileEntry = this.files.get(reg.file);
    if (fileEntry?.ast) {
      for (const s of fileEntry.ast.body) {
        if (s.type === "ClassDef" && s.name === reg.className) {
          return s.span;
        }
      }
    }
    // Last-ditch: a zero-length span at the start of the file.
    return { file: reg.file, start: 0, end: 0 };
  }

  /** Is `name` a registered class (workspace or local)? Used by the
   *  lowerer to route `Foo(args)` to the constructor path and to
   *  detect `ClassName.staticMethod(args)` against an Ident base. */
  isClass(name: string): boolean {
    return this.classes.has(name);
  }

  /** Resolve a call site to a single target. Wraps numbl's
   *  `resolveFunction`, applies mtoc2-narrow validation, and routes
   *  classMethod verdicts (instance + static) through one shape. */
  resolve(
    name: string,
    argTypes: ReadonlyArray<Type>,
    callSite: CallSite,
    span: Span
  ): ResolvedTarget | null {
    this.finalize();
    const itemTypes = argTypes.map(mtypeToItemType);
    const target = resolveFunction(
      name,
      itemTypes,
      callSite,
      this.ctx.functionIndex
    );
    if (!target) return null;
    switch (target.kind) {
      case "builtin":
        return { kind: "builtin", name: target.name };
      case "workspaceFunction": {
        const entry = this.ctx.registry.filesByFuncName.get(target.name);
        if (!entry) {
          throw new UnsupportedConstruct(
            `internal: resolver claimed '${target.name}' is a workspace ` +
              `function but no file is registered`,
            span
          );
        }
        const ast = firstFunctionInFile(
          this.ctx.fileASTCache.get(entry.fileName)
        );
        if (!ast) {
          throw new UnsupportedConstruct(
            `'${entry.fileName}' has no function definitions; mtoc2 cannot ` +
              `use it as a workspace function`,
            span
          );
        }
        return { kind: "userFunction", name, ast, file: entry.fileName };
      }
      case "localFunction": {
        if (target.source.from === "main") {
          const ast = findFunctionInBody(
            this.files.get(this.mainFile)?.ast?.body,
            name
          );
          if (!ast) {
            throw new UnsupportedConstruct(
              `internal: resolver claimed '${name}' is a main-file local ` +
                `function but no AST is registered`,
              span
            );
          }
          return { kind: "userFunction", name, ast, file: this.mainFile };
        }
        if (target.source.from === "workspaceFile") {
          const wsName = target.source.wsName;
          const entry = this.ctx.registry.filesByFuncName.get(wsName);
          if (!entry) {
            throw new UnsupportedConstruct(
              `internal: resolver claimed '${name}' is a subfunction of ` +
                `workspace file '${wsName}' but no file is registered`,
              span
            );
          }
          const ast = findFunctionInBody(
            this.ctx.fileASTCache.get(entry.fileName)?.body,
            name
          );
          if (!ast) {
            throw new UnsupportedConstruct(
              `internal: resolver claimed '${name}' is a subfunction of ` +
                `'${entry.fileName}' but no matching Function stmt was found`,
              span
            );
          }
          return { kind: "userFunction", name, ast, file: entry.fileName };
        }
        throw new UnsupportedConstruct(
          `function '${name}' resolves to a subfunction of a ` +
            (target.source.from === "classFile"
              ? `class file (not yet supported by mtoc2)`
              : `private file (private/ directories are not yet supported by mtoc2)`),
          span
        );
      }
      case "classMethod":
        return {
          kind: "classMethod",
          className: target.className,
          methodName: target.methodName,
          stripInstance: target.stripInstance,
        };
      case "workspaceClassConstructor":
        return { kind: "classConstructor", className: target.className };
      case "privateFunction":
        throw new UnsupportedConstruct(
          `private functions (under a 'private/' directory) are not yet ` +
            `supported by mtoc2`,
          span
        );
      case "jsUserFunction":
        throw new UnsupportedConstruct(
          `JS user functions (.numbl.js) are not yet supported by mtoc2`,
          span
        );
      case "mtoc2UserFunction": {
        const entry = this.ctx.registry.mtoc2UserFunctionsByName.get(
          target.name
        );
        if (!entry) {
          throw new UnsupportedConstruct(
            `internal: resolver claimed '${target.name}' is a .mtoc2.js ` +
              `user function but no entry is registered`,
            span
          );
        }
        // The evaluated `Builtin` is already in `userBuiltins` (loaded
        // during `finalize`). The lowerer / codegen pull it via
        // `getUserBuiltin`; the resolved-target carries enough for
        // diagnostics.
        return {
          kind: "mtoc2UserFunction",
          name: target.name,
          file: entry.fileName,
        };
      }
      default: {
        const _exhaustive: never = target;
        void _exhaustive;
        throw new UnsupportedConstruct(
          `internal: unhandled resolved-target kind`,
          span
        );
      }
    }
  }

  /** Look up the source text of a file by its name. Used by the
   *  lowerer's `printtype` directive to map a span offset to a
   *  line/column in the right file. */
  sourceOf(file: string): string | undefined {
    return this.files.get(file)?.source;
  }
}

/** Pre-parse a list of source files into `WorkspaceFile`s. Parser
 *  errors are propagated; the caller normalizes them.
 *
 *  Files ending in `.mtoc2.js` skip MATLAB parsing — they're plain
 *  JavaScript text that the workspace will hand to the mtoc2 user-
 *  function loader later. Their `ast` field stays undefined. */
export function parseFiles(
  files: ReadonlyArray<{ name: string; source: string }>
): WorkspaceFile[] {
  return files.map(f => {
    if (f.name.endsWith(".mtoc2.js")) {
      return { name: f.name, source: f.source };
    }
    return {
      name: f.name,
      source: f.source,
      ast: parseMFile(f.source, f.name),
    };
  });
}

/** Adapter from mtoc2's `Type` to numbl's `ItemType`. The resolver
 *  only reads `kind === "ClassInstance"` and `className` from there;
 *  every other shape collapses to `Unknown`. */
export function mtypeToItemType(t: Type): ItemType {
  if (t.kind === "Class")
    return { kind: "ClassInstance", className: t.className };
  return { kind: "Unknown" };
}

function firstFunctionInFile(
  ast: AbstractSyntaxTree | undefined
): FuncStmt | null {
  if (!ast) return null;
  for (const s of ast.body) {
    if (s.type === "Function") return s;
  }
  return null;
}

function findFunctionInBody(
  body: Stmt[] | undefined,
  name: string
): FuncStmt | null {
  if (!body) return null;
  for (const s of body) {
    if (s.type === "Function" && s.name === name) return s;
  }
  return null;
}

// Re-export for callers that need the ClassDef AST type without
// importing it from elsewhere.
export type { ClassDefStmt };

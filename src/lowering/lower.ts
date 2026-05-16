/**
 * mtoc2 lowerer. Walks the numbl AST, threads a type env (with exact-
 * value tracking), and produces typed IR. The same pass:
 *   - resolves every function-call site through the shared
 *     `Workspace` (which delegates to numbl's `resolveFunction`),
 *     so MATLAB precedence rules (local > workspace > builtin, plus
 *     class-method dispatch on `obj.method(args)` and
 *     `ClassName.method(args)`) are inherited from numbl wholesale;
 *   - allocates per-call function specializations (mangled by the
 *     FNV-1a hash of the canonicalized arg-type tuple, salted by
 *     the defining file so two files defining a subfunction with
 *     the same name get distinct C names);
 *   - merges types across control-flow joins;
 *   - widens variables assigned inside loop bodies (strips exact)
 *     before lowering the body, so the one-pass lowering doesn't
 *     bake the entry-state value into the emitted code.
 *
 * Exact-value tracking threads through the type system (builtin
 * transfer fns still compute exact results), but the only place the
 * lowerer substitutes a literal for a computation is the `if` /
 * `elseif` condition — when the cond's type has a `number` exact, the
 * branch is statically taken or dropped. Arithmetic, comparisons,
 * builtin calls, and Ident reads all emit runtime IR even when their
 * exact value is known.
 *
 * MVP scope: scalar real double + arithmetic + comparisons + disp +
 * if/while/for + user functions (0 or 1 outputs; 0-output calls return
 * `Void` and are only valid as the expression of an `ExprStmt`) +
 * classes (instance methods, static methods, constructors), with
 * resolution against sibling `.m` files in the workspace via numbl's
 * vendored resolver. Anything outside that throws
 * `UnsupportedConstruct` with a span.
 */

import type {
  AbstractSyntaxTree,
  Expr,
  LValue,
  Stmt,
  Span,
} from "../parser/index.js";
import { BinaryOperation, UnaryOperation } from "../parser/index.js";
import { offsetToLineCol } from "../parser/sourceLoc.js";
import { UnsupportedConstruct, TypeError } from "./errors.js";
import {
  type Type,
  type Sign,
  type NumericType,
  type HandleType,
  type HandleCapture,
  type ClassType,
  type DimInfo,
  DIM_ONE,
  EXACT_ARRAY_MAX_ELEMENTS,
  scalarDouble,
  scalarComplex,
  tensorDouble,
  tensorComplex,
  tensorDoubleFromDims,
  classType,
  signFromExactArray,
  signFromNumber,
  unifySign,
  isScalarRealNumeric,
  isMultiOutputSlotType,
  isMultiElement,
  isNumeric,
  isVoid,
  isHandle,
  isOwned,
  isClass,
  fieldType,
  handleType,
  structType,
  typeToString,
  VOID,
  hashType,
  unify,
  storageEquivalent,
  stripExactFromEnv,
  widenAfterIndexedWrite,
  withoutExact,
  canonicalizeType,
  classMethodSpecSource,
  sanitizeCIdent,
} from "./types.js";
import { exactDouble, exactScalarAsComplex } from "./builtins/_shared.js";
import type { ClassRegistration } from "./classDefs.js";
import type { Workspace } from "../workspace/workspace.js";
import type { CallSite } from "../../../numbl/src/numbl-core/runtime/runtimeHelpers.js";

/** Hook for the `%!numbl:printtype` directive's compile-time output.
 *  Defaults to `console.error` (so emitted lines go to stderr and
 *  don't mix with the cross-runner's stdout comparison). Tests
 *  replace this with a capturing function. */
export let printTypeSink: (line: string) => void = line => console.error(line);
export function setPrintTypeSink(sink: (line: string) => void): void {
  printTypeSink = sink;
}
export function resetPrintTypeSink(): void {
  printTypeSink = line => console.error(line);
}
import { type IRExpr, type IRStmt, type IRFunc, type IRProgram } from "./ir.js";
import {
  getBuiltin,
  binaryOpBuiltin,
  unaryOpBuiltin,
} from "./builtins/index.js";
import {
  arityAccepts,
  arityDescribe,
  type Builtin,
} from "./builtins/registry.js";
import { isSliceArg } from "./indexResolve.js";
import { lowerIndexLoad } from "./lowerIndexLoad.js";
import { lowerIndexStore } from "./lowerIndexStore.js";
import { lowerIndexSlice } from "./lowerIndexSlice.js";
import { lowerIndexSliceStore } from "./lowerIndexSliceStore.js";

interface EnvEntry {
  cName: string;
  ty: Type;
}

type FuncStmt = Extract<Stmt, { type: "Function" }>;

export class Lowerer {
  private env: Map<string, EnvEntry> = new Map();
  private specializations: Map<string, IRFunc> = new Map();
  /** Stack of contexts for resolving the `end` keyword inside an
   *  index slot. Pushed by the index-lowering helpers (lowerIndexLoad
   *  / lowerIndexStore / lowerIndexSlice / lowerIndexSliceStore)
   *  around each slot they lower; consumed by the `EndKeyword` arm of
   *  `lowerExpr`. `axis === "linear"` flags the single-slot form
   *  whose `end` resolves to `numel(base)`. Outside an index slot the
   *  stack is empty and `end` raises `UnsupportedConstruct`. */
  endStack: Array<{
    baseCName: string;
    baseTy: NumericType;
    axis: number | "linear";
  }> = [];
  /** Monotonic counter for synthesizing `_mtoc2_t1`, `_mtoc2_t2`, ...
   *  hoist-temp names. Reset per function specialization. */
  private tempCounter: number = 0;
  /** Expression-level hoist statements queued by sub-lowerings that
   *  can't pass a `hoists` array up the IR-expression return chain.
   *  Used today by member-rooted indexing (`obj.field(args)`) to push a
   *  fresh `Assign(temp = MemberLoad)` so the downstream `IndexLoad` /
   *  `IndexSlice` has a real `Var` to anchor `end`-keyword resolution
   *  on. `lowerStmt` drains this list around every statement boundary
   *  and prepends the hoists to whatever the inner lowering emitted. */
  private pendingExprHoists: IRStmt[] = [];
  /** Monotonic counter for synthesizing anonymous-function names
   *  (`anon_0`, `anon_1`, ...). Shared across the whole program so two
   *  textually distinct `@(...)` expressions get distinct identities. */
  private anonCounter: number = 0;
  /** Source file the lowerer is currently inside. Defaults to the
   *  workspace's main file at construction; pushed/popped by
   *  `specializeUserFunction` so a call from inside `helper.m`'s
   *  subfunction reports the right file in its `CallSite`. */
  private currentFile: string;
  /** Per-specialization `nargin` / `nargout` values. Pushed by
   *  `specializeUserFunction` before lowering a function body; popped
   *  after. Read by the matching identifier arms of `lowerIdent`. Empty
   *  at top level — MATLAB rejects `nargin` / `nargout` outside a
   *  function body, which we mirror by leaving the reference
   *  unresolved (which falls through to the "undefined" error). */
  private callFrameStack: { nargin: number; nargout: number }[] = [];

  constructor(private workspace: Workspace) {
    this.currentFile = workspace.mainFile;
  }

  /** Built `CallSite` for the vendored numbl resolver. New
   *  resolver-relevant fields added later (`className`, `methodName`,
   *  ...) only need to be threaded here. */
  private callSite(): CallSite {
    return { file: this.currentFile };
  }

  /** Public env lookup used by the index-lowering helpers. Returns
   *  the env entry (cName + ty) if a binding exists in the current
   *  scope, or undefined otherwise. */
  envLookup(name: string): EnvEntry | undefined {
    return this.env.get(name);
  }

  /** Look up a registered class (workspace or local) by name. */
  private classReg(name: string): ClassRegistration | undefined {
    return this.workspace.classes.get(name);
  }

  lowerProgram(ast: AbstractSyntaxTree): IRProgram {
    // Build numbl's function index + mtoc2's class registry. The
    // Workspace has already had every file added; `finalize()` is
    // idempotent so a double-call from a caller that explicitly
    // finalized first is harmless.
    this.workspace.finalize();
    // Lower top-level statements (Function / ClassDef stmts return
    // null and are filtered out). The active file's top-level body
    // is the script entry; sibling-file bodies (workspace functions)
    // are lowered lazily by `specializeUserFunction` from call sites.
    const topLevelStmts = this.lowerStmts(ast.body);
    return { topLevelStmts, functions: this.specializations };
  }

  // ── Statement lowering ────────────────────────────────────────────────

  private lowerStmts(stmts: Stmt[]): IRStmt[] {
    const out: IRStmt[] = [];
    for (const s of stmts) {
      const lowered = this.lowerStmt(s);
      if (lowered === null) continue;
      if (Array.isArray(lowered)) out.push(...lowered);
      else out.push(lowered);
      const tail = out[out.length - 1];
      if (
        tail !== undefined &&
        (tail.kind === "ReturnFromFunction" ||
          tail.kind === "Break" ||
          tail.kind === "Continue")
      ) {
        break;
      }
    }
    return out;
  }

  private lowerStmt(s: Stmt): IRStmt | IRStmt[] | null {
    const hoistMark = this.pendingExprHoists.length;
    const inner = this.lowerStmtInner(s);
    if (this.pendingExprHoists.length === hoistMark) return inner;
    const drained = this.pendingExprHoists.splice(hoistMark);
    if (inner === null) return drained;
    if (Array.isArray(inner)) return [...drained, ...inner];
    return [...drained, inner];
  }

  private lowerStmtInner(s: Stmt): IRStmt | IRStmt[] | null {
    switch (s.type) {
      case "Function":
        return null; // pre-scanned, specialized on demand at call sites
      case "ClassDef":
        return null; // pre-scanned into classDefs registry
      case "ExprStmt":
        return this.lowerExprStmt(s);
      case "Assign":
        return this.lowerAssign(s);
      case "AssignLValue":
        return this.lowerAssignLValue(s);
      case "MultiAssign":
        return this.lowerMultiAssign(s);
      case "If":
        return this.lowerIf(s);
      case "While":
        return this.lowerWhile(s);
      case "For":
        return this.lowerFor(s);
      case "Return":
        return { kind: "ReturnFromFunction", span: s.span };
      case "Break":
        return { kind: "Break", span: s.span };
      case "Continue":
        return { kind: "Continue", span: s.span };
      case "Directive":
        return this.lowerDirective(s);
      default:
        throw new UnsupportedConstruct(
          `statement type '${s.type}' not supported`,
          s.span
        );
    }
  }

  /** Numbl directives (`%!numbl:<name> <args>`). Numbl interprets a
   *  small set (e.g. `assert_jit`) and ignores the rest. Mtoc2 reuses
   *  the same parsed-directive AST node to host translator-side hints
   *  that numbl silently passes over:
   *
   *  - `%!numbl:opaque <var> [<var>...]` — strip `exact` from each
   *    named variable in the current env. Used in test scripts to
   *    force the runtime codegen path on values mtoc2 would otherwise
   *    fold at compile time.
   *  - `%!numbl:showtype <var> [<var>...]` — snapshot each variable's
   *    type and emit a `/_ type ... _/` comment in the generated C
   *    at this position. Debug aid; no runtime effect.
   *  - `%!numbl:printtype <var> [<var>...]` — same snapshot, but
   *    written to stderr (via `printTypeSink`) at compile time. Fires
   *    once per function specialization. No IR node, no codegen
   *    interaction.
   *
   *  Numbl ignores all three directives, so cross-runner output is
   *  unaffected. */
  private lowerDirective(
    s: Extract<Stmt, { type: "Directive" }>
  ): IRStmt | null {
    if (s.directive === "opaque") {
      for (const name of s.args) {
        const entry = this.env.get(name);
        if (entry === undefined) {
          throw new UnsupportedConstruct(
            `'%!numbl:opaque' references unknown variable '${name}'`,
            s.span
          );
        }
        // Strip exact from the env. The variable's prior Assign
        // already materialized in C (always-materialize), so the
        // runtime path can read its current buffer contents — no
        // synthetic re-assignment needed here.
        if (entry.ty.kind === "Numeric" && entry.ty.exact !== undefined) {
          const { exact: _e, ...rest } = entry.ty;
          void _e;
          this.env.set(name, { cName: entry.cName, ty: rest });
        } else if (entry.ty.kind === "String" && entry.ty.exact !== undefined) {
          this.env.set(name, {
            cName: entry.cName,
            ty: { kind: "String" },
          });
        }
      }
      return null;
    }
    if (s.directive === "showtype") {
      const entries = this.snapshotTypeEntries(s.args, s.span, "showtype");
      return { kind: "TypeComment", entries, span: s.span };
    }
    if (s.directive === "printtype") {
      const entries = this.snapshotTypeEntries(s.args, s.span, "printtype");
      const fileSource = this.workspace.sourceOf(s.span.file) ?? "";
      const { line, column } = offsetToLineCol(fileSource, s.span.start);
      for (const e of entries) {
        printTypeSink(
          `${s.span.file}:${line}:${column}: type ${e.name} :: ${typeToString(e.ty)}`
        );
      }
      return null;
    }
    // Unknown directives are silently ignored — keeps mtoc2 forward-
    // compatible with numbl directives that don't translate (e.g.
    // `assert_jit`).
    return null;
  }

  /** Look up each name in `args` in the current env, snapshotting its
   *  `cName` and current `Type`. Throws `UnsupportedConstruct` with
   *  the directive's span on the first unknown name. Used by the
   *  `showtype` and `printtype` directive branches. */
  private snapshotTypeEntries(
    args: string[],
    span: Span,
    directiveName: string
  ): { name: string; cName: string; ty: Type }[] {
    const entries: { name: string; cName: string; ty: Type }[] = [];
    for (const name of args) {
      const entry = this.env.get(name);
      if (entry === undefined) {
        throw new UnsupportedConstruct(
          `'%!numbl:${directiveName}' references unknown variable '${name}'`,
          span
        );
      }
      entries.push({ name, cName: entry.cName, ty: entry.ty });
    }
    return entries;
  }

  private lowerExprStmt(
    s: Extract<Stmt, { type: "ExprStmt" }>
  ): IRStmt | IRStmt[] | null {
    // Special case: bare `toc;` / `toc();` / `toc(t0);` ExprStmt routes
    // to the printing form of toc. Numbl uses `nargout === 0` as the
    // discriminator; mtoc2 uses "this Call is the sole expression of
    // an ExprStmt". The shadow checks ensure a user `toc = 5; toc;`
    // (reading a local) or a `classdef toc` (constructor call) doesn't
    // get hijacked. We synthesize a Void-typed Call to the runtime
    // helper directly so we don't go through builtin codegen at all.
    if (this.env.get("toc") === undefined && !this.workspace.isClass("toc")) {
      if (s.expr.type === "Ident" && s.expr.name === "toc") {
        return {
          kind: "ExprStmt",
          expr: {
            kind: "Call",
            cName: "mtoc2_toc_print",
            name: "toc_print",
            args: [],
            ty: VOID,
            span: s.expr.span,
          },
          span: s.span,
        };
      }
      if (s.expr.type === "FuncCall" && s.expr.name === "toc") {
        if (s.expr.args.length === 0) {
          return {
            kind: "ExprStmt",
            expr: {
              kind: "Call",
              cName: "mtoc2_toc_print",
              name: "toc_print",
              args: [],
              ty: VOID,
              span: s.expr.span,
            },
            span: s.span,
          };
        }
        if (s.expr.args.length === 1) {
          const arg = this.lowerExpr(s.expr.args[0]);
          if (!isScalarRealNumeric(arg.ty)) {
            throw new TypeError(
              `'toc' tic-handle argument must be a scalar real numeric ` +
                `(the value returned by 'tic'); got ${arg.ty.kind}`,
              s.expr.args[0].span
            );
          }
          return {
            kind: "ExprStmt",
            expr: {
              kind: "Call",
              cName: "mtoc2_toc_handle_print",
              name: "toc_handle_print",
              args: [arg],
              ty: VOID,
              span: s.expr.span,
            },
            span: s.span,
          };
        }
      }
    }
    // Multi-output user-function bare-statement form: `foo(x);` where
    // `foo` returns N≥2 outputs. The expression-position lowering of
    // a multi-output user function is rejected (the C ABI is `void` +
    // out-pointers, no return value to consume), so we peek at the
    // resolver and route to `lowerMultiAssign` with zero lvalues —
    // "drop every output" semantics, matching numbl. We use the
    // empty-args resolver call (no arg types yet) since for a bare
    // name the verdict doesn't depend on arg types.
    if (s.expr.type === "FuncCall") {
      const fc = s.expr;
      const envEntry = this.env.get(fc.name);
      if (envEntry === undefined && !this.workspace.isClass(fc.name)) {
        const target = this.workspace.resolve(
          fc.name,
          [],
          this.callSite(),
          fc.span
        );
        if (target?.kind === "userFunction" && target.ast.outputs.length >= 2) {
          return this.lowerMultiAssign({
            type: "MultiAssign",
            lvalues: [],
            expr: fc,
            suppressed: s.suppressed,
            span: s.span,
          });
        }
      }
    }
    // Same drop-all peek for a bare `pkg.foo(x);` whose target is an
    // N≥2-output packaged user function. Without this, `lowerExpr`
    // routes through `lowerMethodCall`, which throws on `>= 2`
    // outputs because there is no value to consume.
    if (s.expr.type === "MethodCall") {
      const mc = s.expr;
      const dottedBase = tryExtractDottedName(mc.base);
      if (dottedBase && !this.env.has(dottedBase.split(".")[0])) {
        const qname = `${dottedBase}.${mc.name}`;
        if (!this.workspace.isClass(qname)) {
          const target = this.workspace.resolve(
            qname,
            [],
            this.callSite(),
            mc.span
          );
          if (
            target?.kind === "userFunction" &&
            target.ast.outputs.length >= 2
          ) {
            return this.lowerMultiAssign({
              type: "MultiAssign",
              lvalues: [],
              expr: mc,
              suppressed: s.suppressed,
              span: s.span,
            });
          }
        }
      }
    }
    const expr = this.lowerExpr(s.expr);
    // If the expression is a folded literal with no side effect, drop it.
    if (expr.kind === "NumLit" || expr.kind === "ImagLit") return null;
    // Void-typed call (zero-output user function, fprintf-style
    // side-effecting builtin): the top-level expression itself can't
    // be hoisted (Void has no value), but its OWN-producing
    // sub-expressions still need ANF so they land in named locals
    // that codegen can take the address of / scope-exit free.
    if (isVoid(expr.ty)) {
      const hoists: IRStmt[] = [];
      const hoisted = this.anfChildren(expr, hoists);
      if (hoists.length > 0) {
        return [...hoists, { kind: "ExprStmt", expr: hoisted, span: s.span }];
      }
      return { kind: "ExprStmt", expr, span: s.span };
    }
    // A-normalize: hoist every owned-producing non-Var sub-expression
    // to a fresh temp Assign. After ANF, owned-producing expressions
    // appear only as Assign RHSs (so codegen has a single uniform
    // consume site), and every freshly-allocated tensor's lifetime is
    // tied to a named local that the scope-exit free walk releases.
    const hoists: IRStmt[] = [];
    const hoisted = this.anfRequireScalarOrVar(expr, hoists);
    if (hoists.length > 0) {
      return [...hoists, { kind: "ExprStmt", expr: hoisted, span: s.span }];
    }
    return { kind: "ExprStmt", expr, span: s.span };
  }

  /** Reject Void in a value-consuming context with a clear span. The
   *  Void type tags a call to a zero-output user function; it has no
   *  representation as a value and is only valid as the direct
   *  expression of an `ExprStmt`. */
  private requireValueType(e: IRExpr, what: string): void {
    if (isVoid(e.ty)) {
      throw new UnsupportedConstruct(
        `${what}: cannot use the result of a zero-output function as a value`,
        e.span
      );
    }
  }

  // ── ANF (owned-producing-expression hoisting) ─────────────────────────

  /** Recursively rewrite sub-expressions of `e`, hoisting any owned-
   *  producing non-Var sub-expression to a fresh temp Assign. The
   *  top-level `e` itself is NOT hoisted by this function — the caller
   *  decides what context `e` sits in (Assign RHS at an owned consume
   *  site can keep an owned producer; everywhere else requires
   *  `anfRequireScalarOrVar`). */
  private anfChildren(e: IRExpr, hoists: IRStmt[]): IRExpr {
    switch (e.kind) {
      case "NumLit":
      case "ImagLit":
      case "StringLit":
      case "Var":
      case "HandleLit":
      case "HandleCaptureLoad":
      case "EndRef":
        return e;
      case "TensorBuild":
        return {
          ...e,
          elements: e.elements.map(el =>
            this.anfRequireScalarOrVar(el, hoists)
          ),
        };
      case "TensorConcat":
        return {
          ...e,
          cells: e.cells.map(row =>
            row.map(cell => this.anfRequireScalarOrVar(cell, hoists))
          ),
        };
      case "Binary":
        return {
          ...e,
          left: this.anfRequireScalarOrVar(e.left, hoists),
          right: this.anfRequireScalarOrVar(e.right, hoists),
        };
      case "Unary":
        return {
          ...e,
          operand: this.anfRequireScalarOrVar(e.operand, hoists),
        };
      case "Call":
        return {
          ...e,
          args: e.args.map(a => this.anfRequireScalarOrVar(a, hoists)),
        };
      case "StructLit":
        return {
          ...e,
          fields: e.fields.map(f => ({
            name: f.name,
            value: isOwned(f.value.ty)
              ? // Owned field values land inside a designated initializer
                // — they must be fresh producers. Recurse through ANF on
                // their children but leave the top-level producer in
                // place (it's at a direct consume site, just like an
                // owned Assign RHS).
                this.anfChildren(f.value, hoists)
              : this.anfRequireScalarOrVar(f.value, hoists),
          })),
        };
      case "MemberLoad":
        return {
          ...e,
          base: this.anfRequireScalarOrVar(e.base, hoists),
        };
      case "IndexLoad":
        // The base is usually a `Var` (resolveIndexBase returns one for
        // bare-name indexing) but can be a `MemberLoad` when the source
        // form is `obj.field(i)`. ANF the base too so the post-ANF IR
        // always has a Var here. Each scalar index slot also ANFs.
        return {
          ...e,
          base: this.anfRequireScalarOrVar(e.base, hoists),
          indices: e.indices.map(i => this.anfRequireScalarOrVar(i, hoists)),
        };
      case "IndexSlice":
        // Slice slots' sub-expressions are scalar (start/step/end of a
        // Range, or the Scalar slot's expr). Run them through scalar-
        // or-Var ANF to keep them simple — they evaluate per loop
        // iteration in codegen. The base mirrors IndexLoad: usually a
        // `Var`, but may be a `MemberLoad` in the property-rooted
        // `obj.field(args)` form, which ANF then hoists.
        return {
          ...e,
          base: this.anfRequireScalarOrVar(e.base, hoists),
          index: e.index.map(slot => {
            if (slot.kind === "Range") {
              return {
                ...slot,
                start: this.anfRequireScalarOrVar(slot.start, hoists),
                step: this.anfRequireScalarOrVar(slot.step, hoists),
                end: this.anfRequireScalarOrVar(slot.end, hoists),
              };
            }
            if (slot.kind === "Scalar") {
              return {
                ...slot,
                expr: this.anfRequireScalarOrVar(slot.expr, hoists),
              };
            }
            if (slot.kind === "IndexVec") {
              return {
                ...slot,
                expr: this.anfRequireScalarOrVar(slot.expr, hoists),
              };
            }
            if (slot.kind === "LogicalMask") {
              return {
                ...slot,
                expr: this.anfRequireScalarOrVar(slot.expr, hoists),
              };
            }
            return slot;
          }),
        };
      case "MakeRange":
        return {
          ...e,
          start: this.anfRequireScalarOrVar(e.start, hoists),
          step: this.anfRequireScalarOrVar(e.step, hoists),
          end: this.anfRequireScalarOrVar(e.end, hoists),
        };
    }
  }

  /** Walk `e` and ensure the returned expression is either scalar or a
   *  Var. Recursively ANFs children; if `e` itself is owned-producing
   *  (multi-element non-Var), hoist it. */
  anfRequireScalarOrVar(e: IRExpr, hoists: IRStmt[]): IRExpr {
    const rewritten = this.anfChildren(e, hoists);
    if (isMultiElement(rewritten.ty) && rewritten.kind !== "Var") {
      return this.hoistToTemp(rewritten, hoists);
    }
    return rewritten;
  }

  private hoistToTemp(e: IRExpr, hoists: IRStmt[]): IRExpr {
    const tempName = this.freshTempName();
    this.env.set(tempName, { cName: tempName, ty: e.ty });
    hoists.push({
      kind: "Assign",
      name: tempName,
      cName: tempName,
      ty: e.ty,
      expr: e,
      span: e.span,
    });
    return {
      kind: "Var",
      name: tempName,
      cName: tempName,
      ty: e.ty,
      span: e.span,
    };
  }

  private freshTempName(): string {
    this.tempCounter += 1;
    return `_mtoc2_t${this.tempCounter}`;
  }

  private lowerAssign(s: Extract<Stmt, { type: "Assign" }>): IRStmt | IRStmt[] {
    const expr = this.lowerExpr(s.expr);
    this.requireValueType(expr, `assigning to '${s.name}'`);
    // ANF the RHS. When the RHS is itself owned-producing and the
    // LHS is also owned, the RHS is at a direct consume site — recurse
    // into its CHILDREN only (the top stays as the Assign's RHS).
    // Otherwise the RHS lands at a non-consume site (scalar Assign,
    // mismatched ownership) and the top-level itself may need hoisting.
    const hoists: IRStmt[] = [];
    const lhsOwned = isMultiElement(expr.ty);
    const rhsOwnedDirectProducer = lhsOwned && expr.kind !== "Var";
    const newExpr = rhsOwnedDirectProducer
      ? this.anfChildren(expr, hoists)
      : this.anfRequireScalarOrVar(expr, hoists);
    const main = this.recordAssignment(s.name, newExpr, s.span);
    if (hoists.length === 0) return main;
    return [...hoists, main];
  }

  /** `s.f = rhs` or chained `s.inner.f = rhs`. Lowers to a single
   *  `MemberStore` IR node with the root `Var` as `base` and the
   *  field chain in `fieldPath`. v1 requires the root variable to be
   *  already in env (no implicit struct introduction — use
   *  `s = struct('f', v, ...)` or a class constructor). Every step
   *  of the chain must already exist on the corresponding nested
   *  struct/class type.
   *
   *  Type discipline: the rhs and the field must occupy the same
   *  C-level slot — checked by `storageEquivalent`, which calls
   *  `cFieldTypeStr` on both. Scalar↔tensor, different elem, or
   *  different struct/class typedef name → rejected. Otherwise the
   *  write is accepted and env is updated so subsequent reads of
   *  the field report the rhs's full internal type (the C typedef
   *  is unaffected — the typedef hash sees only the C-level type
   *  via `cFieldTypeStr`, not the internal lattice precision). */
  private lowerAssignLValue(
    s: Extract<Stmt, { type: "AssignLValue" }>
  ): IRStmt | IRStmt[] {
    const lv = s.lvalue;
    if (lv.type === "Index") {
      const result = lv.indices.some(isSliceArg)
        ? lowerIndexSliceStore.call(this, lv, s.expr, s.span)
        : lowerIndexStore.call(this, lv, s.expr, s.span);
      // The runtime tensor was mutated in place, but the env entry
      // for the base variable still carries the pre-write `exact`
      // and `sign` (set by e.g. `zeros(N,M)` at construction).
      // Subsequent transfer fns (sum, etc.), domain checks (sqrt /
      // log), and the if-cond folder would read those stale fields
      // and silently mis-emit. Drop `exact` and widen `sign` toward
      // the rhs sign so the env reflects the post-write reality.
      // Both lower helpers above require lv.base to be an Ident, so
      // pulling its name here is safe.
      if (lv.base.type === "Ident") {
        // Try to refresh the exact Float64Array in place when the
        // store's indices and rhs are both compile-time-known and the
        // base already carries exact data. This keeps downstream
        // builtin transfers (`zeros(sz)` after `sz(1) = ...`) able to
        // see the post-write shape. If any precondition fails, fall
        // back to the default widening (strip exact).
        const refreshed = tryRefreshExactAfterIndexedWrite(
          this.env,
          lv.base.name,
          result
        );
        if (!refreshed) {
          const rhsSign = rhsSignFromStoreResult(result);
          widenAfterIndexedWrite(this.env, lv.base.name, rhsSign);
        }
      }
      return result;
    }
    if (lv.type !== "Member") {
      throw new UnsupportedConstruct(
        `assignment lvalue '${lv.type}' is not supported`,
        s.span
      );
    }

    // Walk the Member chain to find the root Ident and the field
    // path (outermost → innermost). Reject any non-Ident root or
    // `MemberDynamic` step.
    const fieldPath: string[] = [];
    let cur: Expr = lv.base;
    fieldPath.unshift(lv.name);
    while (cur.type === "Member") {
      fieldPath.unshift(cur.name);
      cur = cur.base;
    }
    if (cur.type !== "Ident") {
      throw new UnsupportedConstruct(
        `assignment lvalue must be rooted at a named variable`,
        s.span
      );
    }
    const rootName = cur.name;
    const rootEntry = this.env.get(rootName);
    if (rootEntry === undefined) {
      throw new UnsupportedConstruct(
        `assignment to '${rootName}.${fieldPath.join(".")}' but '${rootName}' is not yet defined ` +
          `(struct variables must first be introduced via 'struct(...)' or a class constructor call)`,
        s.span
      );
    }

    // Walk the field path, checking that each step exists. Track the
    // leaf type the rhs is going to overwrite.
    let stepTy: Type = rootEntry.ty;
    for (let i = 0; i < fieldPath.length; i++) {
      const fname = fieldPath[i];
      const ft = fieldType(stepTy, fname);
      if (ft === undefined) {
        throw new TypeError(
          `'${rootName}.${fieldPath.slice(0, i + 1).join(".")}': no such ` +
            `field on type ${typeToString(stepTy)}`,
          s.span
        );
      }
      stepTy = ft;
    }
    const leafTy = stepTy;

    // Lower the rhs. Then ANF the rhs the same way Assign does — owned
    // direct producers can stay; everything else hoists to a temp.
    const rhsRaw = this.lowerExpr(s.expr);
    this.requireValueType(
      rhsRaw,
      `assignment to '${rootName}.${fieldPath.join(".")}'`
    );

    // Storage compatibility: the rhs and leaf must occupy the same
    // C-level slot. `storageEquivalent` reduces both sides via
    // `cFieldTypeStr` — so all `mtoc2_tensor_t` slots accept any
    // multi-element tensor, all `double` slots accept any scalar
    // real numeric, and struct/class slots only accept values with
    // the same typedef name. Internal lattice precision (sign,
    // exact, tensor shape) is preserved on the field afterward —
    // the typedef hash already ignores it.
    if (!storageEquivalent(rhsRaw.ty, leafTy)) {
      throw new TypeError(
        `assignment to '${rootName}.${fieldPath.join(".")}': field has ` +
          `C type ${typeToString(leafTy)} but rhs has ` +
          `type ${typeToString(rhsRaw.ty)}`,
        s.span
      );
    }

    // ANF the rhs.
    const hoists: IRStmt[] = [];
    const leafOwned = isOwned(leafTy);
    const rhsOwnedDirectProducer = leafOwned && rhsRaw.kind !== "Var";
    const rhs = rhsOwnedDirectProducer
      ? this.anfChildren(rhsRaw, hoists)
      : this.anfRequireScalarOrVar(rhsRaw, hoists);

    const baseVar: Extract<IRExpr, { kind: "Var" }> = {
      kind: "Var",
      name: rootName,
      cName: rootEntry.cName,
      ty: rootEntry.ty,
      span: s.span,
    };
    const store: IRStmt = {
      kind: "MemberStore",
      base: baseVar,
      fieldPath,
      leafTy: rhsRaw.ty,
      rhs,
      span: s.span,
    };

    // Update env so subsequent reads of the touched field see the
    // post-write rhs type — not the construction-site type. The
    // typedef hash uses `cFieldTypeStr` (one C-type string per
    // field), so the C typedef name stays the same regardless of
    // how the field's internal precision evolves through writes.
    // CFG-join `unify` widens further when different branches
    // assign different types to the same path.
    const updatedRootTy = withPathTypeUpdated(
      rootEntry.ty,
      fieldPath,
      rhsRaw.ty
    );
    this.env.set(rootName, { cName: rootEntry.cName, ty: updatedRootTy });

    if (hoists.length === 0) return store;
    return [...hoists, store];
  }

  /** `[a, b, ~] = foo(x);` — multi-output statement form. Also reached
   *  from `lowerExprStmt` (with empty lvalues) for the drop-all bare
   *  statement `foo(x);` where `foo` returns N≥2 outputs. Restrictions
   *  for v1:
   *
   *    - RHS must be a `FuncCall` resolving to a user function (no
   *      builtins, no handle dispatch — those don't have a multi-output
   *      ABI in mtoc2 yet).
   *    - Each lvalue must be a `Var` or `~` ignore.
   *    - `lvalues.length <= callee.outputs.length`.
   *    - For an N≥2-output callee, every output slot must be scalar
   *      real numeric (the only type mtoc2 currently emits sret writes
   *      for; tensor / struct / class / handle outputs are deferred).
   *
   *  When the callee has exactly 1 output the result routes to a plain
   *  `Assign` (named lvalue) or `ExprStmt(Call)` (drop / ignore) — the
   *  return-by-value ABI stays in play. Otherwise the result is a
   *  `MultiAssignCall` IR node and the C ABI uses out-pointers. */
  private lowerMultiAssign(
    s: Extract<Stmt, { type: "MultiAssign" }>
  ): IRStmt | IRStmt[] {
    // Allow two AST shapes on the RHS:
    //   - `FuncCall` for plain `foo(...)` / `helper(...)`
    //   - `MethodCall` whose base is a dotted name with a non-in-scope
    //     leftmost segment — i.e. a package-function call like
    //     `lege.exps(...)`. Same routing as `lowerMethodCall`'s package
    //     branch. (Instance methods stay 1-output-only; multi-output
    //     method dispatch is a separate followup.)
    let callName: string;
    let argExprs: Expr[];
    let callSpan: { file: string; start: number; end: number };
    let specSource: string | undefined;
    if (s.expr.type === "FuncCall") {
      callName = s.expr.name;
      argExprs = s.expr.args;
      callSpan = s.expr.span;
      specSource = undefined; // default: decl.name
    } else if (s.expr.type === "MethodCall") {
      const dottedBase = tryExtractDottedName(s.expr.base);
      if (dottedBase === null || this.env.has(dottedBase.split(".")[0])) {
        throw new UnsupportedConstruct(
          `multi-assign right-hand side must be a user-function or ` +
            `package-function call (got instance-method dispatch, not ` +
            `yet supported in '[...] = ...')`,
          s.span
        );
      }
      callName = `${dottedBase}.${s.expr.name}`;
      argExprs = s.expr.args;
      callSpan = s.expr.span;
      // Salt the spec key with the qualified name so a packaged `foo`
      // doesn't share its specialization slot with a workspace-level
      // `foo` of the same shape.
      specSource = callName;
    } else {
      throw new UnsupportedConstruct(
        `multi-assign right-hand side must be a user-function call`,
        s.span
      );
    }
    const fc = { name: callName, args: argExprs, span: callSpan };
    // Validate lvalues up-front.
    for (const lv of s.lvalues) {
      if (lv.type !== "Var" && lv.type !== "Ignore") {
        throw new UnsupportedConstruct(
          `multi-assign lvalue must be a simple identifier or '~' ignore ` +
            `(got '${lv.type}')`,
          s.span
        );
      }
    }
    // Reject in-scope variable names and class names — only user
    // functions can sit on the right of `[...] = ...` in v1.
    if (this.env.get(callName) !== undefined) {
      throw new UnsupportedConstruct(
        `multi-assign of '${callName}': name resolves to an in-scope ` +
          `variable, not a function`,
        s.span
      );
    }
    if (this.workspace.isClass(callName)) {
      throw new UnsupportedConstruct(
        `multi-assign of '${callName}': class constructors have a single ` +
          `output`,
        s.span
      );
    }
    // Lower the args. Same pattern as `lowerFuncCall`.
    const args = fc.args.map(a => this.lowerExpr(a));
    for (const a of args) {
      this.requireValueType(a, `argument to '${callName}'`);
    }
    const argTypes = args.map(a => a.ty);
    // ANF each arg to scalar-or-Var — same discipline as `anfChildren`
    // for a regular `Call` node. Without this, an owned-producing arg
    // like `times_ts(ones_nd(...), 2.0)` would leave the inner `ones_nd`
    // unfreed (the outer helper doesn't consume its tensor arg). For
    // a user-function call (Call or MultiAssignCall), the callee owns
    // each arg, so the OUTER producer is fine — only the grandchild
    // needs hoisting — but mirroring Call's discipline (hoist top-
    // level owned non-Vars too) is simpler and the temp gets early-
    // freed after the call so cost is nil.
    const argHoists: IRStmt[] = [];
    const anfArgs = args.map(a => this.anfRequireScalarOrVar(a, argHoists));
    const target = this.workspace.resolve(
      callName,
      argTypes,
      this.callSite(),
      fc.span
    );

    // Builtin multi-output path. A builtin opts into `[...] = f(x)` by
    // populating the `multiOutput` field on its registry entry. Numbl's
    // resolver returns `kind: "builtin"` for the call; we re-fetch from
    // mtoc2's own registry (the source of truth for `multiOutput`) and
    // route through the same `MultiAssignCall` IR shape user functions
    // use. Single-output `b = f(x)` still flows through `lowerFuncCall`
    // → `transfer`/`codegenC` — this hook only fires for true multi-
    // output uses.
    if (target?.kind === "builtin") {
      const builtin = getBuiltin(callName);
      if (builtin?.multiOutput !== undefined) {
        return this.buildBuiltinMultiAssign(
          callName,
          builtin,
          builtin.multiOutput,
          args,
          anfArgs,
          argTypes,
          argHoists,
          s
        );
      }
    }

    if (target?.kind !== "userFunction") {
      throw new UnsupportedConstruct(
        `multi-assign of '${callName}': only user-defined functions can ` +
          `appear on the right of '[...] = ...' (or as a bare multi-output ` +
          `statement)`,
        s.span
      );
    }
    const fnAst = target.ast;
    const fnFile = target.file;
    if (s.lvalues.length > fnAst.outputs.length) {
      throw new UnsupportedConstruct(
        `function '${callName}' returns ${fnAst.outputs.length} output(s) ` +
          `but ${s.lvalues.length} were requested`,
        s.span
      );
    }
    if (fnAst.outputs.length === 0 && s.lvalues.length > 0) {
      throw new UnsupportedConstruct(
        `function '${callName}' has no outputs and cannot be assigned`,
        s.span
      );
    }
    // Caller's requested `nargout`: count of lvalues (0 for the
    // bare-drop-all path that `lowerExprStmt` routes here).
    const callNargout = s.lvalues.length;
    const spec = this.specializeUserFunction(
      fnAst,
      argTypes,
      specSource,
      fnFile,
      undefined,
      callNargout
    );

    // 1-output spec: route to the classic single-output ABI (return-
    // by-value) so we don't introduce a redundant sret path. Note
    // this is `spec.outputTypes.length`, not `fnAst.outputs.length`
    // — a multi-output declared callee specialized with nargout=1
    // (because the call site only requested one output) truncates
    // its spec to a single output and emits the return-by-value
    // shape, even though `fnAst.outputs.length > 1`.
    if (spec.outputTypes.length === 1) {
      const callExpr: IRExpr = {
        kind: "Call",
        cName: spec.cName,
        name: callName,
        args: anfArgs,
        ty: spec.outputTypes[0] ?? { kind: "Unknown" },
        span: s.span,
      };
      // 0 or 1 lvalues: lvalues.length === 0 → drop-all reached
      // via the ExprStmt routing (caller passed empty lvalues for
      // a bare 1-output call); lvalues.length === 1 → either named
      // or `~`.
      const lv = s.lvalues[0];
      if (lv === undefined || lv.type !== "Var") {
        const stmt: IRStmt = { kind: "ExprStmt", expr: callExpr, span: s.span };
        return argHoists.length === 0 ? stmt : [...argHoists, stmt];
      }
      const stmt = this.recordAssignment(lv.name, callExpr, s.span);
      return argHoists.length === 0 ? stmt : [...argHoists, stmt];
    }

    // 0-output spec with no lvalues: bare-statement routing path
    // (`f(...);` with f declared 0-output, or a multi-output declared
    // f called bare which truncates the spec to 0 outputs and emits
    // a void function). Pass through as ExprStmt(Call) with Void
    // type — the same shape `lowerFuncCall` would produce for any
    // 0-output bare call.
    if (spec.outputTypes.length === 0) {
      const callExpr: IRExpr = {
        kind: "Call",
        cName: spec.cName,
        name: callName,
        args: anfArgs,
        ty: VOID,
        span: s.span,
      };
      const stmt: IRStmt = { kind: "ExprStmt", expr: callExpr, span: s.span };
      return argHoists.length === 0 ? stmt : [...argHoists, stmt];
    }

    // N≥2 outputs. Build a MultiAssignCall. Output slots have one of
    // two shapes: named binding (routed through `recordAssignment` to
    // register the env entry and cName) or `null` for ignored /
    // trailing-omitted slots.
    const outputs: {
      ty: Type;
      binding: { name: string; cName: string } | null;
    }[] = [];
    for (let i = 0; i < spec.outputTypes.length; i++) {
      const slotTy = spec.outputTypes[i] ?? { kind: "Unknown" };
      // Accept scalar real numeric or any owned type (tensor / struct /
      // class / handle). Owned slots transfer ownership via the kind's
      // `_assign` helper at the callee's sret write site; scalar slots
      // use a bare struct copy. Void / Unknown / String stay rejected
      // — no C representation that fits the sret slot.
      if (!isMultiOutputSlotType(slotTy)) {
        throw new UnsupportedConstruct(
          `multi-output function '${callName}': output ` +
            `'${fnAst.outputs[i]}' has type ${typeToString(slotTy)}; ` +
            `this type isn't supported in a multi-output slot`,
          s.span
        );
      }
      const lv: LValue | undefined = s.lvalues[i];
      if (lv === undefined || lv.type !== "Var") {
        outputs.push({ ty: slotTy, binding: null });
        continue;
      }
      // Named slot. We reuse `recordAssignment` for its side effects
      // (env update, cName allocation). The synthetic Var expression
      // it builds the Assign around is discarded — we only consume the
      // returned cName.
      const synthRhs: IRExpr = {
        kind: "Var",
        name: lv.name,
        cName: "<placeholder>",
        ty: slotTy,
        span: s.span,
      };
      const rec = this.recordAssignment(lv.name, synthRhs, s.span);
      if (rec.kind !== "Assign") {
        throw new Error("internal: recordAssignment returned non-Assign");
      }
      outputs.push({
        ty: slotTy,
        binding: { name: lv.name, cName: rec.cName },
      });
    }
    const mac: IRStmt = {
      kind: "MultiAssignCall",
      cName: spec.cName,
      name: callName,
      args: anfArgs,
      outputs,
      span: s.span,
    };
    return argHoists.length === 0 ? mac : [...argHoists, mac];
  }

  /** Routes a `[v, i, ...] = builtin(args)` call through `MultiAssignCall`,
   *  using the builtin's `multiOutput` hook for the output-type tuple and
   *  the C helper name. Reuses the same output-slot bookkeeping as the
   *  user-function path (named slots go through `recordAssignment` for
   *  env / cName setup; `~` / trailing-omitted slots become discard temps
   *  in the emitter). */
  private buildBuiltinMultiAssign(
    callName: string,
    builtin: Builtin,
    multiOutput: NonNullable<Builtin["multiOutput"]>,
    args: IRExpr[],
    anfArgs: IRExpr[],
    argTypes: Type[],
    argHoists: IRStmt[],
    s: Extract<Stmt, { type: "MultiAssign" }>
  ): IRStmt | IRStmt[] {
    void args;
    if (!arityAccepts(builtin.arity, anfArgs.length)) {
      throw new TypeError(
        `'${callName}' expects ${arityDescribe(builtin.arity)} arg(s), ` +
          `got ${anfArgs.length}`,
        s.span
      );
    }
    const nargout = s.lvalues.length;
    if (nargout < multiOutput.minNargout || nargout > multiOutput.maxNargout) {
      throw new UnsupportedConstruct(
        `'${callName}' supports ${multiOutput.minNargout}..` +
          `${multiOutput.maxNargout} output(s) in '[...] = ${callName}(...)' ` +
          `form; got ${nargout}`,
        s.span
      );
    }
    const outTys = multiOutput.transfer(argTypes, nargout, s.span);
    if (outTys.length !== nargout) {
      throw new Error(
        `internal: builtin '${callName}' multiOutput.transfer returned ` +
          `${outTys.length} types for nargout=${nargout}`
      );
    }
    const outputs: {
      ty: Type;
      binding: { name: string; cName: string } | null;
    }[] = [];
    for (let i = 0; i < outTys.length; i++) {
      const slotTy = outTys[i];
      if (!isMultiOutputSlotType(slotTy)) {
        throw new UnsupportedConstruct(
          `multi-output builtin '${callName}': output slot ${i + 1} has ` +
            `type ${typeToString(slotTy)}; this type isn't supported in a ` +
            `multi-output slot`,
          s.span
        );
      }
      const lv: LValue | undefined = s.lvalues[i];
      if (lv === undefined || lv.type !== "Var") {
        outputs.push({ ty: slotTy, binding: null });
        continue;
      }
      const synthRhs: IRExpr = {
        kind: "Var",
        name: lv.name,
        cName: "<placeholder>",
        ty: slotTy,
        span: s.span,
      };
      const rec = this.recordAssignment(lv.name, synthRhs, s.span);
      if (rec.kind !== "Assign") {
        throw new Error("internal: recordAssignment returned non-Assign");
      }
      outputs.push({
        ty: slotTy,
        binding: { name: lv.name, cName: rec.cName },
      });
    }
    const cName = multiOutput.cName(argTypes, nargout);
    const mac: IRStmt = {
      kind: "MultiAssignCall",
      cName,
      name: callName,
      args: anfArgs,
      outputs,
      span: s.span,
    };
    return argHoists.length === 0 ? mac : [...argHoists, mac];
  }

  private recordAssignment(name: string, expr: IRExpr, span: Span): IRStmt {
    const existing = this.env.get(name);
    // Type-compat check: catch reassignments that would invalidate the
    // C-side declaration. The function-top `collectOwnedLocals` walk
    // records only the FIRST seen owned typedef per cName, so a later
    // owned-typed reassignment of `name` with a different storage shape
    // (different struct field set, different class, different handle
    // capture-shape, scalar↔tensor, etc.) would emit a call to a
    // `_assign` helper whose signature doesn't match the pre-declared
    // local — i.e. a C compile error rather than a clean span-attributed
    // translate-time error. `storageEquivalent` is the same predicate
    // used for `MemberStore` writes — it compares `cFieldTypeStr` so
    // it catches every C-level slot mismatch.
    if (existing && !storageEquivalent(existing.ty, expr.ty)) {
      if (isMultiElement(existing.ty) !== isMultiElement(expr.ty)) {
        throw new UnsupportedConstruct(
          `cannot reassign '${name}' across scalar/tensor boundary`,
          span
        );
      }
      throw new UnsupportedConstruct(
        `cannot reassign '${name}': new value's C storage ` +
          `(${typeToString(expr.ty)}) is incompatible with the ` +
          `existing binding (${typeToString(existing.ty)})`,
        span
      );
    }
    const cName = existing?.cName ?? cIdentForUserName(name);
    this.env.set(name, { cName, ty: expr.ty });
    return {
      kind: "Assign",
      name,
      cName,
      ty: expr.ty,
      expr,
      span,
    };
  }

  private lowerIf(s: Extract<Stmt, { type: "If" }>): IRStmt | IRStmt[] {
    const cond = this.lowerExpr(s.cond);
    this.requireScalarCondType(cond.ty, "if condition", s.span);

    // If-fold: when the top cond is exact, take/drop the then-arm and
    // recurse on the remaining elseif chain. The cond's COMPUTATION is
    // still emitted (as an `ExprStmt` prefix) so any side effects in
    // the cond — e.g. a `log_then_5() > 0` where the user function's
    // body has a `disp` and its spec returns an exact 5 — still run at
    // runtime. Only the BRANCH decision is folded out. `condIsPure`
    // skips the prefix when no side effect is reachable from cond
    // (NumLit / Var / EndRef / pure arithmetic on those) so the
    // common literal-cond case stays clean.
    const folded = condToBool(cond);
    const condPrefix: IRStmt[] = condIsPure(cond)
      ? []
      : [{ kind: "ExprStmt", expr: cond, span: s.cond.span }];
    if (folded === true) return [...condPrefix, ...this.lowerStmts(s.thenBody)];
    if (folded === false) {
      if (s.elseifBlocks.length === 0) {
        return [
          ...condPrefix,
          ...(s.elseBody ? this.lowerStmts(s.elseBody) : []),
        ];
      }
      const [first, ...rest] = s.elseifBlocks;
      // Reshape: `elseif first ... rest else B` becomes a fresh If.
      const synthetic: Extract<Stmt, { type: "If" }> = {
        type: "If",
        cond: first.cond,
        thenBody: first.body,
        elseifBlocks: rest,
        elseBody: s.elseBody,
        span: first.cond.span,
      };
      const inner = this.lowerIf(synthetic);
      return [...condPrefix, ...(Array.isArray(inner) ? inner : [inner])];
    }

    // Non-folded path.
    const envBefore = new Map(this.env);
    const branchEnvs: Map<string, EnvEntry>[] = [];

    // Then-branch.
    this.env = new Map(envBefore);
    const thenBody = this.lowerStmts(s.thenBody);
    branchEnvs.push(this.env);

    // Else chain.
    this.env = new Map(envBefore);
    const elseBody = this.lowerElseChain(
      s.elseifBlocks,
      s.elseBody,
      envBefore,
      branchEnvs
    );

    // Merge.
    this.env = this.mergeBranchEnvs(branchEnvs);
    return {
      kind: "If",
      cond,
      thenBody,
      elseBody,
      span: s.span,
    };
  }

  private lowerElseChain(
    elseifs: { cond: Expr; body: Stmt[] }[],
    elseBody: Stmt[] | null,
    envBefore: Map<string, EnvEntry>,
    branchEnvs: Map<string, EnvEntry>[]
  ): IRStmt[] {
    if (elseifs.length === 0) {
      if (elseBody === null) {
        branchEnvs.push(new Map(envBefore));
        return [];
      }
      this.env = new Map(envBefore);
      const b = this.lowerStmts(elseBody);
      branchEnvs.push(this.env);
      return b;
    }
    const [first, ...rest] = elseifs;
    this.env = new Map(envBefore);
    const ec = this.lowerExpr(first.cond);
    this.requireScalarCondType(ec.ty, "elseif condition", first.cond.span);
    const beforeBody = new Map(this.env);

    this.env = beforeBody;
    const thenBody = this.lowerStmts(first.body);
    branchEnvs.push(this.env);

    this.env = new Map(envBefore);
    const innerElse = this.lowerElseChain(
      rest,
      elseBody,
      envBefore,
      branchEnvs
    );

    return [
      {
        kind: "If",
        cond: ec,
        thenBody,
        elseBody: innerElse,
        span: first.cond.span,
      },
    ];
  }

  private lowerWhile(s: Extract<Stmt, { type: "While" }>): IRStmt {
    const envBefore = new Map(this.env);
    // Strip exact for body-mutated vars BEFORE lowering cond — the body
    // might re-enter the cond after a back-edge, so even the cond sees
    // post-loop values.
    stripExactFromEnv(this.env, collectAssignedNames(s.body));
    const cond = this.lowerExpr(s.cond);
    this.requireScalarCondType(cond.ty, "while condition", s.span);
    const body = this.lowerStmts(s.body);
    this.env = this.mergeBranchEnvs([envBefore, this.env]);
    return { kind: "While", cond, body, span: s.span };
  }

  private lowerFor(s: Extract<Stmt, { type: "For" }>): IRStmt {
    if (s.expr.type !== "Range") {
      throw new UnsupportedConstruct(
        `for-loop iterables other than ranges are not yet supported`,
        s.span
      );
    }
    const start = this.lowerExpr(s.expr.start);
    const end = this.lowerExpr(s.expr.end);
    this.requireScalarReal(start.ty, "for-loop start", s.expr.start.span);
    this.requireScalarReal(end.ty, "for-loop end", s.expr.end.span);

    let step = 1;
    if (s.expr.step) {
      const stepExpr = this.lowerExpr(s.expr.step);
      this.requireScalarReal(stepExpr.ty, "for-loop step", s.expr.step.span);
      // Step must be a compile-time-known scalar — read its exact from
      // the type (no IR-level fold runs anymore, but the transfer fns
      // still propagate exact through e.g. unary-minus on a literal).
      const stepVal =
        isNumeric(stepExpr.ty) && typeof stepExpr.ty.exact === "number"
          ? stepExpr.ty.exact
          : undefined;
      if (stepVal === undefined) {
        throw new UnsupportedConstruct(
          `for-loop step must be a compile-time-known numeric literal`,
          s.expr.step.span
        );
      }
      if (stepVal === 0) {
        throw new UnsupportedConstruct(
          `for-loop step must be non-zero`,
          s.expr.step.span
        );
      }
      step = stepVal;
    }

    const envBefore = new Map(this.env);
    // Loop var sign: the values are start, start+step, ..., end, so the
    // sign lattice must cover every value in [min(start,end),
    // max(start,end)]. Unifying startSign and endSign captures that —
    // it correctly classifies a descending loop with positive bounds
    // (`10:-1:1`) as "positive", an ascending loop with negative
    // bounds as "negative", and a range spanning zero as "unknown".
    const startSign = isNumeric(start.ty) ? start.ty.sign : "unknown";
    const endSign = isNumeric(end.ty) ? end.ty.sign : "unknown";
    const kSign: NumericType["sign"] = unifySign(startSign, endSign);

    const cVar = cIdentForUserName(s.varName);
    this.env.set(s.varName, {
      cName: cVar,
      ty: scalarDouble(kSign),
    });

    stripExactFromEnv(this.env, collectAssignedNames(s.body));

    const body = this.lowerStmts(s.body);
    this.env = this.mergeBranchEnvs([envBefore, this.env]);
    return {
      kind: "For",
      varName: s.varName,
      cVar,
      start,
      step,
      end,
      body,
      span: s.span,
    };
  }

  // ── Expression lowering ───────────────────────────────────────────────

  lowerExpr(e: Expr): IRExpr {
    switch (e.type) {
      case "Number": {
        const v = Number(e.value);
        if (!Number.isFinite(v)) {
          throw new UnsupportedConstruct(
            `non-finite numeric literal '${e.value}'`,
            e.span
          );
        }
        return {
          kind: "NumLit",
          value: v,
          ty: scalarDouble(signFromNumber(v), v),
          span: e.span,
        };
      }
      case "ImagUnit":
        // Bare `i` / `j` postfixed onto a Number turns into
        // `Mul(Number, ImagUnit)` by the parser; that's caught by
        // the collapse in `lowerBinary`. A standalone `ImagUnit`
        // (rare — e.g. `1i / 2` after parser binding) lowers here.
        return {
          kind: "ImagLit",
          value: 1,
          ty: scalarComplex({ re: 0, im: 1 }),
          span: e.span,
        };
      case "Ident":
        return this.lowerIdent(e);
      case "Binary":
        return this.lowerBinary(e);
      case "Unary":
        return this.lowerUnary(e);
      case "FuncCall":
        return this.lowerFuncCall(e);
      case "Tensor":
        return this.lowerTensorLit(e);
      case "FuncHandle":
        return this.lowerFuncHandle(e);
      case "AnonFunc":
        return this.lowerAnonFunc(e);
      case "Member":
        return this.lowerMember(e);
      case "MethodCall":
        return this.lowerMethodCall(e);
      case "EndKeyword":
        return this.lowerEndKeyword(e);
      case "Range":
        return this.lowerRangeAsValue(e);
      case "Char": {
        // Single-quoted MATLAB char literal — lexeme keeps the
        // surrounding `'` delimiters and doubled-quote escapes.
        // Strip them so the type's `exact` mirrors numbl's runtime
        // string. v1 only consumes these inside reducer builtins
        // (`sum(A, 'all')`, etc.); every other site rejects via
        // the builtin's transfer or `requireValueType`-adjacent check.
        const raw = e.value;
        const inner = raw.slice(1, raw.length - 1).replaceAll("''", "'");
        return {
          kind: "StringLit",
          value: inner,
          ty: { kind: "Char", exact: inner },
          span: e.span,
        };
      }
      case "String": {
        // Double-quoted MATLAB string literal — scalar string handle
        // (`length("hi") == 1`); codegen emits via
        // `mtoc2_string_from_literal`. Same stripping rule as Char but
        // with `""` as the in-literal escape.
        const raw = e.value;
        const inner = raw.slice(1, raw.length - 1).replaceAll('""', '"');
        return {
          kind: "StringLit",
          value: inner,
          ty: { kind: "String", exact: inner },
          span: e.span,
        };
      }
      case "Colon":
        throw new UnsupportedConstruct(
          `bare ':' is only valid inside an index expression`,
          e.span
        );
      default:
        throw new UnsupportedConstruct(
          `expression type '${e.type}' not supported`,
          e.span
        );
    }
  }

  /** `end` keyword inside an index slot — resolves through the top of
   *  `endStack`. Outside an index slot it raises with a span. When the
   *  axis size is statically known, emit a `NumLit`; otherwise emit
   *  an `EndRef` IR node and let codegen render the runtime axis-size
   *  read. */
  private lowerEndKeyword(e: Extract<Expr, { type: "EndKeyword" }>): IRExpr {
    if (this.endStack.length === 0) {
      throw new UnsupportedConstruct(
        `'end' is only valid inside an index expression`,
        e.span
      );
    }
    const top = this.endStack[this.endStack.length - 1];
    // Try a static value first.
    if (top.axis === "linear") {
      if (top.baseTy.shape !== undefined) {
        const n = top.baseTy.shape.reduce((a, b) => a * b, 1);
        return {
          kind: "NumLit",
          value: n,
          ty: scalarDouble(n > 0 ? "positive" : "nonneg", n),
          span: e.span,
        };
      }
    } else {
      const axis = top.axis;
      if (top.baseTy.shape !== undefined && axis < top.baseTy.shape.length) {
        const n = top.baseTy.shape[axis];
        return {
          kind: "NumLit",
          value: n,
          ty: scalarDouble(n > 0 ? "positive" : "nonneg", n),
          span: e.span,
        };
      }
    }
    return {
      kind: "EndRef",
      baseCName: top.baseCName,
      baseTy: top.baseTy,
      axis: top.axis,
      ty: scalarDouble("nonneg"),
      span: e.span,
    };
  }

  /** `a : b` or `a : s : b` used as a value (outside an index slot
   *  and outside a for-loop iterable). Emits a `MakeRange` IR node
   *  whose result is a freshly-allocated row vector. */
  private lowerRangeAsValue(e: Extract<Expr, { type: "Range" }>): IRExpr {
    const start = this.lowerExpr(e.start);
    const end = this.lowerExpr(e.end);
    let step: IRExpr;
    if (e.step === null) {
      step = {
        kind: "NumLit",
        value: 1,
        ty: scalarDouble("positive", 1),
        span: e.span,
      };
    } else {
      step = this.lowerExpr(e.step);
    }
    this.requireScalarReal(start.ty, "range start", e.start.span);
    this.requireScalarReal(end.ty, "range end", e.end.span);
    this.requireScalarReal(step.ty, "range step", e.step?.span ?? e.span);

    // Static-shape detection: when start / step / end are all exact
    // and step is finite-nonzero, compute the count at compile time.
    let resultTy: Type;
    const sExact =
      isNumeric(start.ty) && typeof start.ty.exact === "number"
        ? start.ty.exact
        : undefined;
    const tExact =
      isNumeric(step.ty) && typeof step.ty.exact === "number"
        ? step.ty.exact
        : undefined;
    const eExact =
      isNumeric(end.ty) && typeof end.ty.exact === "number"
        ? end.ty.exact
        : undefined;
    if (
      sExact !== undefined &&
      tExact !== undefined &&
      eExact !== undefined &&
      tExact !== 0 &&
      Number.isFinite(sExact) &&
      Number.isFinite(tExact) &&
      Number.isFinite(eExact)
    ) {
      // Mirrors numbl's `makeRangeTensor` count formula. The naive
      // `floor((e-s)/step) + 1` underflows by one for ranges like
      // `0:0.1:0.3` because `(0.3-0)/0.1` evaluates to 2.99999...; the
      // `+ 1e-10` cushion absorbs that ulp without affecting genuinely
      // non-integer quotients. Must match `mtoc2_loop_count` so the
      // statically-known shape and the runtime-allocated buffer agree.
      const raw = Math.floor((eExact - sExact) / tExact + 1 + 1e-10);
      const n = raw > 0 ? raw : 0;
      // Length-1 collapse: a `1:1`-style range is a single-element
      // tensor with dims [1, 1]. The type system classifies that as
      // scalar (both dims `one`), so the LHS would be declared
      // `double` — but the IR is `MakeRange`, which always emits a
      // tensor-returning helper. Returning `start` directly resolves
      // the type/IR mismatch and matches MATLAB / numbl, which both
      // treat `1:1` as the scalar `1`. Side effects in `start` are
      // preserved (it's the returned IR); side effects in `step` /
      // `end` are dropped — accepted limitation since both must have
      // exact values for us to know the length statically, and
      // exact-bearing IR is overwhelmingly NumLit / Var / pure
      // arithmetic in practice.
      if (n === 1) return start;
      resultTy = tensorDouble([1, n]);
    } else {
      // Build a dim-only type when length is runtime.
      resultTy = {
        kind: "Numeric",
        elem: "double",
        isComplex: false,
        dims: [{ kind: "exact", value: 1 }, { kind: "unknown" }],
        sign: "unknown",
      };
    }

    return {
      kind: "MakeRange",
      start,
      step,
      end,
      ty: resultTy,
      span: e.span,
    };
  }

  /** `s.f` or chained `s.inner.f`. Lowers each nesting level into a
   *  fresh `MemberLoad` whose `base` is the inner load. The leaf
   *  type is the field's static type on the immediate container. */
  private lowerMember(e: Extract<Expr, { type: "Member" }>): IRExpr {
    const base = this.lowerExpr(e.base);
    this.requireValueType(base, `field access '.${e.name}'`);
    const ft = fieldType(base.ty, e.name);
    if (ft === undefined) {
      throw new TypeError(
        `no field '${e.name}' on type ${typeToString(base.ty)}`,
        e.span
      );
    }
    return {
      kind: "MemberLoad",
      base,
      field: e.name,
      ty: ft,
      span: e.span,
    };
  }

  /** Class method dispatch. Covers four call shapes:
   *    - `obj.method(args)` — instance method.
   *    - `obj.staticMethod(args)` — instance-style call to a static
   *      method; numbl's resolver flips `stripInstance=true` so the
   *      receiver is NOT passed at the C level.
   *    - `ClassName.method(args)` — static method called by class
   *      name; we detect this by inspecting the AST base before
   *      lowering, set `targetClassName` on the call site, and let
   *      the resolver pick the right method (also stripInstance).
   *    - `pkg.foo(args)` / `pkg.sub.foo(args)` — package function
   *      call. The whole dotted chain (`pkg.sub.foo`) is the
   *      qualified workspace-function name. Same rule as numbl's
   *      interpreter: only treated as a package ref when the
   *      leftmost segment is not an in-scope variable. Packaged
   *      classes (`+pkg/@Foo/Foo.m` → `pkg.Foo`) and packaged
   *      static methods (`pkg.Foo.staticMethod(...)`) route through
   *      the same path.
   *
   *  v1 only supports methods with 0 or 1 outputs. */
  private lowerMethodCall(e: Extract<Expr, { type: "MethodCall" }>): IRExpr {
    // Package function / qualified class call. The base is a chain
    // of Ident/Member (no calls, no index) whose leftmost segment
    // is not an in-scope variable.
    const dottedBase = tryExtractDottedName(e.base);
    if (dottedBase && !this.env.has(dottedBase.split(".")[0])) {
      const qname = `${dottedBase}.${e.name}`;
      // `pkg.Foo(args)` — packaged class constructor.
      if (this.workspace.isClass(qname)) {
        const reg = this.workspace.classes.get(qname)!;
        return this.lowerClassConstructorCall(reg, e.args, e.span);
      }
      // `ClassName.staticMethod(args)` where `ClassName` is either a
      // bare class or a qualified one (`pkg.Foo.staticMethod(...)`).
      if (this.workspace.isClass(dottedBase)) {
        return this.lowerStaticMethodCall(dottedBase, e, e.span);
      }
      // `pkg.foo(args)` — packaged workspace function. Let the
      // resolver decide; we route the userFunction verdict through
      // the same path as `lowerFuncCall`.
      const args = e.args.map(a => this.lowerExpr(a));
      for (const a of args) {
        this.requireValueType(a, `argument to '${qname}'`);
      }
      const argTypes = args.map(a => a.ty);
      const target = this.workspace.resolve(
        qname,
        argTypes,
        this.callSite(),
        e.span
      );
      if (target?.kind === "userFunction") {
        // Expression-context call site requests exactly 1 output. A
        // multi-output declared function specializes with nargout=1,
        // which truncates the spec's output list — the callee then
        // emits as a single-output C function (return-by-value), and
        // any `if nargout >= N` branches dead-code via the nargout
        // fold. A 0-output declared function specializes with
        // nargout=0 (void); calling it in expression position is
        // separately rejected by `requireValueType` at the consumer.
        const spec = this.specializeUserFunction(
          target.ast,
          argTypes,
          qname,
          target.file,
          undefined,
          target.ast.outputs.length === 0 ? 0 : 1
        );
        const ty: Type =
          target.ast.outputs.length === 0
            ? VOID
            : (spec.outputTypes[0] ?? { kind: "Unknown" });
        return {
          kind: "Call",
          cName: spec.cName,
          name: qname,
          args,
          ty,
          span: e.span,
        };
      }
      if (target?.kind === "classConstructor") {
        const reg = this.classReg(target.className);
        if (reg === undefined) {
          throw new UnsupportedConstruct(
            `internal: class '${target.className}' missing from workspace registry`,
            e.span
          );
        }
        return this.lowerClassConstructorCall(reg, e.args, e.span);
      }
      // Numbl's resolver only returns these dotted-route verdicts for
      // qualified names; if we got something else (or nothing) for a
      // dotted chain that's clearly not a class, fail with a clear
      // message rather than fall through to instance dispatch (which
      // would try to lower `pkg` as an Ident and crash).
      throw new UnsupportedConstruct(`unknown function '${qname}'`, e.span);
    }

    // Instance dispatch: the base lowers to a value and must be a
    // class instance.
    const base = this.lowerExpr(e.base);
    this.requireValueType(base, `method call '.${e.name}'`);
    if (!isClass(base.ty)) {
      throw new UnsupportedConstruct(
        `method call '.${e.name}' on a value of type ` +
          `${typeToString(base.ty)} is not supported (v1: classes only)`,
        e.span
      );
    }

    // Property-rooted indexing: `obj.field(args)` where `field` is a
    // class property (not a method). MATLAB semantics are "load the
    // field, then index it" — distinct from method dispatch. We
    // pre-hoist the field load to a fresh temp so the downstream
    // `IndexLoad` / `IndexSlice` has a real `Var` to anchor on (the
    // temp also gives `end`-keyword resolution a concrete `dims[k]`
    // to query).
    const classProperties = base.ty.properties;
    const isProperty = classProperties.some(p => p.name === e.name);
    const isMethod = (() => {
      const cls = this.classReg(base.ty.className);
      if (cls === undefined) return false;
      return cls.methods.has(e.name) || cls.staticMethods.has(e.name);
    })();
    if (isProperty && !isMethod) {
      return this.lowerMemberRootedIndex(base, e.name, e.args, e.span);
    }
    const args = e.args.map(a => this.lowerExpr(a));
    for (const a of args) {
      this.requireValueType(a, `argument to method '${e.name}'`);
    }
    // Build the type tuple the resolver inspects: receiver + user
    // args. The resolver decides whether `e.name` is an instance or
    // static method of `base.ty.className` and toggles
    // `stripInstance` accordingly.
    const argTypesForResolve: Type[] = [base.ty, ...args.map(a => a.ty)];
    const target = this.workspace.resolve(
      e.name,
      argTypesForResolve,
      { ...this.callSite(), targetClassName: base.ty.className },
      e.span
    );
    if (target?.kind !== "classMethod") {
      throw new TypeError(
        `class '${base.ty.className}' has no method '${e.name}'`,
        e.span
      );
    }
    const reg = this.classReg(target.className);
    if (reg === undefined) {
      throw new UnsupportedConstruct(
        `internal: class '${target.className}' missing from workspace registry`,
        e.span
      );
    }
    const method = target.stripInstance
      ? reg.staticMethods.get(target.methodName)
      : reg.methods.get(target.methodName);
    if (method === undefined) {
      throw new TypeError(
        `class '${target.className}' has no ${target.stripInstance ? "static " : ""}method '${target.methodName}'`,
        e.span
      );
    }
    if (method.outputs.length >= 2) {
      throw new UnsupportedConstruct(
        `class method '${target.className}.${target.methodName}' has ` +
          `${method.outputs.length} outputs; multi-output methods are not ` +
          `supported yet`,
        e.span
      );
    }
    const allArgs: IRExpr[] = target.stripInstance ? args : [base, ...args];
    const argTypes = allArgs.map(a => a.ty);
    const spec = this.specializeUserFunction(
      method,
      argTypes,
      classMethodSpecSource(target.className, target.methodName),
      reg.file,
      undefined,
      method.outputs.length === 0 ? 0 : 1
    );
    const ty: Type =
      method.outputs.length === 0
        ? VOID
        : (spec.outputTypes[0] ?? { kind: "Unknown" });
    return {
      kind: "Call",
      cName: spec.cName,
      name: `${target.className}.${target.methodName}`,
      args: allArgs,
      ty,
      span: e.span,
    };
  }

  /** Lowers `obj.field(args)` where `field` is a class property (not a
   *  method): load the field into a fresh temp, then run the args
   *  through the standard `lowerIndexLoad` / `lowerIndexSlice` path
   *  using the temp's name. The synthetic `Assign(temp = MemberLoad)`
   *  is queued on `pendingExprHoists` so `lowerStmt` prepends it to
   *  the emitted statement. */
  private lowerMemberRootedIndex(
    base: IRExpr,
    field: string,
    argExprs: ReadonlyArray<Expr>,
    span: Span
  ): IRExpr {
    const ft = fieldType(base.ty, field);
    if (ft === undefined) {
      throw new TypeError(
        `no field '${field}' on type ${typeToString(base.ty)}`,
        span
      );
    }
    // Only owned (multi-element / non-numeric owned) properties make
    // sense to index. Scalar real properties hit the
    // `requireMultiElement` check inside `resolveIndexBase`, so the
    // diagnostic still points at the original source span.
    const memberLoad: IRExpr = {
      kind: "MemberLoad",
      base,
      field,
      ty: ft,
      span,
    };
    const tempName = this.freshTempName();
    this.env.set(tempName, { cName: tempName, ty: ft });
    this.pendingExprHoists.push({
      kind: "Assign",
      name: tempName,
      cName: tempName,
      ty: ft,
      expr: memberLoad,
      span,
    });
    if (argExprs.some(isSliceArg)) {
      return lowerIndexSlice.call(this, tempName, argExprs, span);
    }
    return lowerIndexLoad.call(this, tempName, argExprs, span);
  }

  /** `ClassName.staticMethod(args)` — static method called via class
   *  name. The receiver is not present; arg types feed the resolver
   *  directly. */
  private lowerStaticMethodCall(
    className: string,
    e: Extract<Expr, { type: "MethodCall" }>,
    span: Span
  ): IRExpr {
    const args = e.args.map(a => this.lowerExpr(a));
    for (const a of args) {
      this.requireValueType(a, `argument to static method '${e.name}'`);
    }
    const argTypes = args.map(a => a.ty);
    const target = this.workspace.resolve(
      e.name,
      argTypes,
      { ...this.callSite(), targetClassName: className },
      span
    );
    if (target?.kind !== "classMethod") {
      throw new TypeError(
        `class '${className}' has no static method '${e.name}'`,
        span
      );
    }
    const reg = this.classReg(target.className);
    if (reg === undefined) {
      throw new UnsupportedConstruct(
        `internal: class '${target.className}' missing from workspace registry`,
        span
      );
    }
    // Numbl's `stripInstance` only fires on the `targetClassName`
    // branch when args[0] is a ClassInstance (i.e. the
    // `obj.staticMethod(...)` syntax). For the `ClassName.method(...)`
    // syntax we never prepend a receiver, so `stripInstance` is
    // always false — we instead look up `staticMethods` directly to
    // disambiguate static vs. instance.
    const method = reg.staticMethods.get(target.methodName);
    if (method === undefined) {
      if (reg.methods.has(target.methodName)) {
        throw new TypeError(
          `'${target.className}.${target.methodName}' is an instance method; ` +
            `call it on an instance (e.g. 'obj.${target.methodName}(...)')`,
          span
        );
      }
      throw new TypeError(
        `class '${target.className}' has no static method '${target.methodName}'`,
        span
      );
    }
    if (method.outputs.length >= 2) {
      throw new UnsupportedConstruct(
        `static class method '${target.className}.${target.methodName}' ` +
          `has ${method.outputs.length} outputs; multi-output methods are ` +
          `not supported yet`,
        span
      );
    }
    const spec = this.specializeUserFunction(
      method,
      argTypes,
      classMethodSpecSource(target.className, target.methodName),
      reg.file,
      undefined,
      method.outputs.length === 0 ? 0 : 1
    );
    const ty: Type =
      method.outputs.length === 0
        ? VOID
        : (spec.outputTypes[0] ?? { kind: "Unknown" });
    return {
      kind: "Call",
      cName: spec.cName,
      name: `${target.className}.${target.methodName}`,
      args,
      ty,
      span,
    };
  }

  private lowerIdent(e: Extract<Expr, { type: "Ident" }>): IRExpr {
    const entry = this.env.get(e.name);
    if (entry !== undefined) {
      return {
        kind: "Var",
        name: e.name,
        cName: entry.cName,
        ty: entry.ty,
        span: e.span,
      };
    }
    // `nargout` / `nargin` are MATLAB pseudo-variables that fold to a
    // compile-time constant per specialization. The `callFrameStack`
    // is pushed by `specializeUserFunction` before lowering the body
    // and popped after; a reference outside a function body finds it
    // empty and falls through to the "undefined" error.
    if (
      (e.name === "nargout" || e.name === "nargin") &&
      this.callFrameStack.length > 0
    ) {
      const frame = this.callFrameStack[this.callFrameStack.length - 1];
      const v = e.name === "nargout" ? frame.nargout : frame.nargin;
      return {
        kind: "NumLit",
        value: v,
        ty: scalarDouble(signFromNumber(v), v),
        span: e.span,
      };
    }
    // Identifier read of a builtin name with no parens. MATLAB treats
    // this as a 0-arg call when the name isn't shadowed by a local.
    // Supports the fixed-0-arity system builtins (`tic`, `toc`) and
    // the variadic plot-dispatch names whose arity range admits 0
    // (`figure;`, `hold;`, `drawnow;`, …). User-function
    // ident-as-call and class references are left to dedicated paths.
    const b = getBuiltin(e.name);
    if (b !== undefined && arityAccepts(b.arity, 0)) {
      const ty = b.transfer([], e.span);
      return {
        kind: "Call",
        cName: e.name,
        name: e.name,
        args: [],
        ty,
        span: e.span,
      };
    }
    throw new UnsupportedConstruct(
      `undefined variable '${e.name}' (or unsupported reference)`,
      e.span
    );
  }

  /** Lower an AST `Tensor` node (`[1 2; 3 4]`, `[a, b; c, d]`, `[v]`, etc.).
   *
   *  Two code paths share this entry:
   *
   *  - **All-scalar cells** (fast path) — every cell is a scalar real
   *    numeric. We emit `TensorBuild` with a flat column-major
   *    `elements` array, exactly as before; `mtoc2_tensor_from_row` /
   *    `mtoc2_tensor_from_matrix` handle codegen.
   *
   *  - **Mixed cells** (concat path) — at least one cell is a multi-
   *    element tensor. We compute per-row horzcat and across-row
   *    vertcat shapes statically, build a `TensorConcat` IR node, and
   *    codegen emits an alloc + per-cell block copies. Mirrors numbl's
   *    `catAlongDim` (`runtime/tensor-construction.ts:402+`).
   *
   *  Numbl semantics carried through:
   *    - Empty cells (any axis 0) are dropped. `[zeros(0,1), [1 2 3]]`
   *      produces `[1 2 3]`, not a shape error.
   *    - Rows with no surviving cells are dropped.
   *    - Singleton `[x]` (one cell, whether scalar or tensor) returns
   *      the inner expression unchanged — matches MATLAB.
   *    - Result shape is statically resolved at lowering; mismatched
   *      shapes are caught with span-attributed errors.
   *
   *  ND cells (`dims.length > 2`), complex cells, and non-numeric
   *  cells are rejected.
   */
  private lowerTensorLit(e: Extract<Expr, { type: "Tensor" }>): IRExpr {
    if (e.rows.length === 0) {
      // Empty `[]`. Numbl uses an empty 0×0 tensor — we mirror.
      return {
        kind: "TensorBuild",
        elements: [],
        shape: [0, 0],
        ty: tensorDouble([0, 0]),
        span: e.span,
      };
    }

    // Phase 1 — lower every cell and classify its shape.
    //   - scalar: kind=scalar, value carries the scalar IRExpr.
    //   - tensor: kind=tensor, rows/cols carry the cell's per-axis dim
    //             (number when exact, null when runtime-only).
    //   - empty:  kind=empty, contributes nothing (dropped below).
    type Cell =
      | { kind: "scalar"; expr: IRExpr; ty: NumericType }
      | {
          kind: "tensor";
          expr: IRExpr;
          ty: NumericType;
          rows: number | null;
          cols: number | null;
        }
      | { kind: "empty"; ty: NumericType };
    const grid: Cell[][] = [];
    let anyTensor = false;
    let anyComplex = false;
    for (const row of e.rows) {
      const out: Cell[] = [];
      for (const cell of row) {
        const lowered = this.lowerExpr(cell);
        const ty = lowered.ty;
        if (!isNumeric(ty)) {
          throw new UnsupportedConstruct(
            `bracket literal cell must be a numeric scalar or tensor (got ${typeToString(ty)})`,
            cell.span
          );
        }
        if (ty.elem !== "double" && ty.elem !== "logical") {
          throw new UnsupportedConstruct(
            `bracket literal cell must be a real double or logical (got ${ty.elem})`,
            cell.span
          );
        }
        if (ty.dims.length > 2) {
          throw new UnsupportedConstruct(
            `bracket concatenation requires 2-D cells (got a rank-${ty.dims.length} tensor); use 'cat'/'permute' for higher-rank inputs`,
            cell.span
          );
        }
        if (ty.isComplex) {
          if (isMultiElement(ty)) {
            // Phase 2 lands scalar-complex bracket cells and the
            // straight assembly into a complex tensor; a tensor-typed
            // complex cell would need Phase 3's complex tensor concat
            // machinery (lane-copy paths).
            throw new UnsupportedConstruct(
              `bracket literal with a complex tensor cell is not yet supported`,
              cell.span
            );
          }
          anyComplex = true;
        }
        if (ty.dims.every(d => d.kind === "exact" && d.value === 1)) {
          // Both scalar real and scalar complex land here.
          out.push({ kind: "scalar", expr: lowered, ty });
          continue;
        }
        // Tensor cell. Per-axis dim is `number` when exact, `null`
        // when runtime-only. `dims.length === 2` is guaranteed
        // (mtoc2 normalizes to min-2D and rejected rank>2 above).
        const d0 = ty.dims[0];
        const d1 = ty.dims[1];
        const cr: number | null = d0.kind === "exact" ? d0.value : null;
        const cc: number | null = d1.kind === "exact" ? d1.value : null;
        // Statically-zero axis ⇒ empty cell. A runtime-only axis can
        // be 0 at runtime, but we can't drop it from the grid here
        // — codegen handles size-0 tensor cells inline (the copy
        // loop iterates 0 times).
        if (cr === 0 || cc === 0) {
          out.push({ kind: "empty", ty });
          continue;
        }
        anyTensor = true;
        out.push({ kind: "tensor", expr: lowered, ty, rows: cr, cols: cc });
      }
      grid.push(out);
    }

    // All-scalar fast path — preserve the existing TensorBuild shape
    // and codegen.
    if (!anyTensor && grid.every(r => r.every(c => c.kind === "scalar"))) {
      // Uniform row width is required for the scalar grid.
      const rows = grid.length;
      const cols0 = grid[0].length;
      for (const r of grid) {
        if (r.length !== cols0) {
          throw new TypeError(
            `bracket horzcat row-count mismatch: row 1 has ${cols0} cells, ` +
              `another row has ${r.length}`,
            e.span
          );
        }
      }
      const cols = cols0;
      const total = rows * cols;
      const loweredFlat: IRExpr[] = new Array(total);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const cell = grid[r][c];
          if (cell.kind !== "scalar") {
            throw new Error(
              "internal: unexpected non-scalar in scalar fast path"
            );
          }
          loweredFlat[c * rows + r] = cell.expr;
        }
      }
      if (rows === 1 && cols === 1) {
        return loweredFlat[0];
      }
      if (anyComplex) {
        // Complex tensor literal — propagate isComplex on the result
        // type. Exact-fold via the split-buffer `{re, im}` carrier when
        // every element is exact (numeric or imaginary literals).
        let exactData: { re: Float64Array; im: Float64Array } | undefined;
        if (total <= EXACT_ARRAY_MAX_ELEMENTS) {
          const re = new Float64Array(total);
          const im = new Float64Array(total);
          let allExact = true;
          for (let i = 0; i < total; i++) {
            const cx = exactScalarAsComplex(loweredFlat[i].ty);
            if (cx === undefined) {
              allExact = false;
              break;
            }
            re[i] = cx.re;
            im[i] = cx.im;
          }
          if (allExact) exactData = { re, im };
        }
        const ty = tensorComplex([rows, cols], exactData);
        return {
          kind: "TensorBuild",
          elements: loweredFlat,
          shape: [rows, cols],
          ty,
          span: e.span,
        };
      }
      let exactData: Float64Array | undefined;
      if (total <= EXACT_ARRAY_MAX_ELEMENTS) {
        const data = new Float64Array(total);
        let allExact = true;
        for (let i = 0; i < total; i++) {
          const v = exactDouble(loweredFlat[i].ty);
          if (v === undefined) {
            allExact = false;
            break;
          }
          data[i] = v;
        }
        if (allExact) exactData = data;
      }
      const ty = tensorDouble([rows, cols], exactData);
      return {
        kind: "TensorBuild",
        elements: loweredFlat,
        shape: [rows, cols],
        ty,
        span: e.span,
      };
    }

    // Phase 3 reserved for complex tensor concat lane-copies (the
    // multi-element complex cell ↔ scalar mix variant of TensorConcat
    // codegen). The Phase 2 scalar-cell fast path above covers
    // pure-scalar complex literals; phase 3 elemwise arithmetic
    // already runs without exercising this site.
    if (anyComplex) {
      throw new UnsupportedConstruct(
        `bracket literal mixing complex cells with multi-element tensor cells is not yet supported (concat lane-copy is deferred)`,
        e.span
      );
    }

    // Concat path. Compute per-row horzcat shapes, then vertcat.
    //
    // For each row, drop empty cells. The row's height is the unique
    // non-empty cell's `rows` (validated against neighbors when both
    // sides are static; mismatched runtime/static pairs trust the
    // user — `mtoc2_check_concat_axis` could later validate at
    // runtime, but the current emit just uses whichever value is
    // known). A row with no non-empty cells contributes nothing to
    // the vertcat.
    type NonEmptyCell = Exclude<Cell, { kind: "empty" }>;
    const rowsRetained: NonEmptyCell[][] = [];
    const rowHeights: (number | null)[] = [];
    const rowWidths: (number | null)[] = [];
    const cellCols: (number | null)[][] = [];
    for (let i = 0; i < grid.length; i++) {
      const row = grid[i];
      const keptCells: NonEmptyCell[] = [];
      const keptCols: (number | null)[] = [];
      let height: number | null | undefined = undefined; // undefined = no cells seen yet
      let width: number | null = 0;
      for (let j = 0; j < row.length; j++) {
        const cell = row[j];
        if (cell.kind === "empty") continue;
        const h: number | null = cell.kind === "scalar" ? 1 : cell.rows;
        const w: number | null = cell.kind === "scalar" ? 1 : cell.cols;
        if (height === undefined) {
          height = h;
        } else if (height !== null && h !== null && height !== h) {
          throw new TypeError(
            `bracket horzcat row-height mismatch: cell ${j + 1} on row ${i + 1} ` +
              `has ${h} row(s) but a neighbor in the same row has ${height}`,
            e.rows[i][j].span
          );
        } else if (height === null && h !== null) {
          height = h; // promote: prefer the static value
        }
        keptCells.push(cell);
        keptCols.push(w);
        width = width === null || w === null ? null : width + w;
      }
      if (height === undefined) continue; // entire row was empty — drop it
      rowsRetained.push(keptCells);
      rowHeights.push(height);
      rowWidths.push(width);
      cellCols.push(keptCols);
    }

    // If every row was dropped, the result is the empty 0×0 placeholder.
    if (rowsRetained.length === 0) {
      return {
        kind: "TensorBuild",
        elements: [],
        shape: [0, 0],
        ty: tensorDouble([0, 0]),
        span: e.span,
      };
    }

    // All retained rows must have the same width (statically when
    // both sides are known; otherwise trust the user / runtime).
    let staticWidth: number | null = null;
    for (const w of rowWidths) {
      if (w === null) continue;
      if (staticWidth === null) {
        staticWidth = w;
      } else if (staticWidth !== w) {
        throw new TypeError(
          `bracket vertcat column-count mismatch: a row has ${staticWidth} ` +
            `column(s), another has ${w}`,
          e.span
        );
      }
    }
    const totalCols: number | null = staticWidth;
    // Total rows = sum of row heights; null if any height is unknown.
    let totalRows: number | null = 0;
    for (const h of rowHeights) {
      if (h === null) {
        totalRows = null;
        break;
      }
      totalRows += h;
    }

    // Singleton case: one cell total, no concat needed — return the
    // cell's lowered IR unchanged. Matches MATLAB's `[v] === v`
    // (whether v is scalar or tensor).
    if (rowsRetained.length === 1 && rowsRetained[0].length === 1) {
      const only = rowsRetained[0][0];
      return only.expr;
    }

    // ANF the tensor cells so each is a Var. Scalar cells stay
    // inline. The hoist sites flow up via the Lowerer's normal
    // ANF machinery — but at this point we're returning a single
    // expression. The standard ANF rewrite in `anfChildren` will
    // catch our TensorConcat (it's owned-producing) and recurse
    // through `cells` with `anfRequireScalarOrVar`, which will
    // hoist any tensor-typed non-Var cells. So we can just hand off
    // raw cells here — they'll be hoisted by the time codegen sees
    // them.
    const cellsIR: IRExpr[][] = rowsRetained.map(row => row.map(c => c.expr));

    // Try exact-fold. Only attempted when every dim is statically
    // known (otherwise we can't allocate a fixed-size buffer or
    // address into it). Every cell must be exact; total elements
    // must fit the cap.
    let exactData: Float64Array | undefined;
    if (
      totalRows !== null &&
      totalCols !== null &&
      rowHeights.every(h => h !== null) &&
      cellCols.every(cc => cc.every(c => c !== null))
    ) {
      const total = totalRows * totalCols;
      if (total <= EXACT_ARRAY_MAX_ELEMENTS) {
        const data = new Float64Array(total);
        let allExact = true;
        let rowOff = 0;
        for (let i = 0; i < rowsRetained.length && allExact; i++) {
          const row = rowsRetained[i];
          let colOff = 0;
          for (let j = 0; j < row.length && allExact; j++) {
            const cell = row[j];
            const cellRowsKnown =
              cell.kind === "scalar" ? 1 : (cell.rows as number);
            const cellColsKnown =
              cell.kind === "scalar" ? 1 : (cell.cols as number);
            if (cell.kind === "scalar") {
              const v = exactDouble(cell.ty);
              if (v === undefined) {
                allExact = false;
                break;
              }
              const dstIdx = rowOff + colOff * totalRows;
              data[dstIdx] = v;
            } else {
              const src = cell.ty.exact;
              if (!(src instanceof Float64Array)) {
                allExact = false;
                break;
              }
              for (let sc = 0; sc < cellColsKnown; sc++) {
                for (let sr = 0; sr < cellRowsKnown; sr++) {
                  const dstIdx = rowOff + sr + (colOff + sc) * totalRows;
                  const srcIdx = sr + sc * cellRowsKnown;
                  data[dstIdx] = src[srcIdx];
                }
              }
            }
            colOff += cellColsKnown;
          }
          rowOff += rowHeights[i] as number;
        }
        if (allExact) exactData = data;
      }
    }

    // Build the result type. Use `tensorDoubleFromDims` so a
    // runtime-only axis lands as `{ kind: "unknown" }`.
    const resultDims: DimInfo[] = [
      totalRows === null
        ? { kind: "unknown" }
        : totalRows === 1
          ? DIM_ONE
          : { kind: "exact", value: totalRows },
      totalCols === null
        ? { kind: "unknown" }
        : totalCols === 1
          ? DIM_ONE
          : { kind: "exact", value: totalCols },
    ];
    const resultTy = tensorDoubleFromDims(resultDims);
    if (exactData !== undefined && resultTy.shape !== undefined) {
      resultTy.exact = exactData;
      resultTy.sign = signFromExactArray(exactData);
    }
    return {
      kind: "TensorConcat",
      cells: cellsIR,
      rowHeights,
      cellCols,
      shape: [totalRows, totalCols],
      ty: resultTy,
      span: e.span,
    };
  }

  private lowerBinary(e: Extract<Expr, { type: "Binary" }>): IRExpr {
    // Parser produces `1i` as `Mul(Number(1), ImagUnit)` (and `2.5i`
    // as `Mul(Number(2.5), ImagUnit)`). Collapse that to a single
    // `ImagLit` so the rest of the pipeline doesn't see an artificial
    // multiplication and so the resulting type carries an exact
    // `{re: 0, im: v}` for downstream folding.
    if (
      e.op === BinaryOperation.Mul &&
      e.left.type === "Number" &&
      e.right.type === "ImagUnit"
    ) {
      const v = Number(e.left.value);
      if (Number.isFinite(v)) {
        return {
          kind: "ImagLit",
          value: v,
          ty: scalarComplex({ re: 0, im: v }),
          span: e.span,
        };
      }
    }
    const left = this.lowerExpr(e.left);
    this.requireValueType(left, "binary operator operand");
    const right = this.lowerExpr(e.right);
    this.requireValueType(right, "binary operator operand");
    const name = binaryOpBuiltin(e.op, e.span);
    const b = getBuiltin(name);
    if (!b) {
      throw new UnsupportedConstruct(
        `builtin '${name}' not registered`,
        e.span
      );
    }
    const ty = b.transfer([left.ty, right.ty], e.span);
    return {
      kind: "Binary",
      builtin: name,
      op: e.op,
      left,
      right,
      ty,
      span: e.span,
    };
  }

  private lowerUnary(e: Extract<Expr, { type: "Unary" }>): IRExpr {
    const operand = this.lowerExpr(e.operand);
    this.requireValueType(operand, "unary operator operand");
    // `'` (conjugate transpose) on a complex operand lowers to
    // `transpose(conj(z))` per the plan — no native ctranspose
    // helper. For real operands `'` and `.'` are identical (both
    // route to `transpose`).
    if (
      e.op === UnaryOperation.Transpose &&
      isNumeric(operand.ty) &&
      operand.ty.isComplex
    ) {
      const conjB = getBuiltin("conj");
      const transB = getBuiltin("transpose");
      if (!conjB || !transB) {
        throw new UnsupportedConstruct(
          `internal: 'conj'/'transpose' must be registered for complex ctranspose`,
          e.span
        );
      }
      const conjTy = conjB.transfer([operand.ty], e.span);
      const conjCall: IRExpr = {
        kind: "Call",
        cName: "conj",
        name: "conj",
        args: [operand],
        ty: conjTy,
        span: e.span,
      };
      const transTy = transB.transfer([conjTy], e.span);
      return {
        kind: "Call",
        cName: "transpose",
        name: "transpose",
        args: [conjCall],
        ty: transTy,
        span: e.span,
      };
    }
    const name = unaryOpBuiltin(e.op, e.span);
    const b = getBuiltin(name);
    if (!b) {
      throw new UnsupportedConstruct(
        `builtin '${name}' not registered`,
        e.span
      );
    }
    const ty = b.transfer([operand.ty], e.span);
    return {
      kind: "Unary",
      builtin: name,
      op: e.op,
      operand,
      ty,
      span: e.span,
    };
  }

  private lowerFuncCall(e: Extract<Expr, { type: "FuncCall" }>): IRExpr {
    // Resolve the name. Cases, in priority order:
    //   0. The literal name `struct` — produce a `StructLit` from
    //      the (name, value, name, value, ...) arg list.
    //   1. A bound variable whose type is `HandleType` — dispatch
    //      through the handle to the underlying user function.
    //   2. The name matches a registered class — route to the
    //      constructor (or synthesize a default-valued receiver when
    //      the class has no constructor). We could let the resolver
    //      return `classConstructor`, but the constructor's defaults/
    //      class type live in `workspace.classes`, so we look that up
    //      directly. Either path produces the same call.
    //   3. Resolver verdict (numbl's `resolveFunction`): builtin,
    //      user function (local or cross-file), or class method
    //      (`method(obj, ...)` syntax).
    //
    // Note: an in-scope variable of a non-handle type at a call site
    // means the user wrote `name(args)` expecting indexing/call, which
    // mtoc2 doesn't support yet — emit a clearer error than "unknown
    // function".
    // Look up the env BEFORE the `struct(...)` constructor shortcut so
    // `struct = [1 2 3]; struct(2)` reads the local (yields `2`)
    // rather than dispatching to the `struct(...)` constructor and
    // erroring on "expects an even number of args". MATLAB precedence
    // is env > builtin; this honors it for the one builtin name that
    // has special-cased lowering. Other in-scope-variable cases
    // (handle, multi-element numeric, scalar) are handled below.
    const envEntry = this.env.get(e.name);
    if (envEntry === undefined && e.name === "struct") {
      return this.lowerStructConstructor(e);
    }
    if (envEntry === undefined && e.name === "bsxfun") {
      const rewritten = this.tryRewriteBsxfun(e);
      if (rewritten !== null) return rewritten;
    }
    if (envEntry !== undefined && isHandle(envEntry.ty)) {
      return this.dispatchHandleCall(e.name, envEntry, e.args, e.span);
    }
    if (envEntry === undefined && this.workspace.isClass(e.name)) {
      return this.lowerClassConstructorCall(
        this.workspace.classes.get(e.name)!,
        e.args,
        e.span
      );
    }
    if (envEntry !== undefined) {
      // MATLAB's "workspace shadows functions" rule: `v(i)` reads as
      // an indexed access when `v` is in scope. Multi-element numeric
      // bases route through the index helpers; scalar variables get a
      // clearer error than "unknown function". Other types (handle is
      // handled above, struct / class / string) keep the existing
      // "cannot be called" error.
      if (isNumeric(envEntry.ty) && isMultiElement(envEntry.ty)) {
        if (e.args.some(isSliceArg)) {
          return lowerIndexSlice.call(this, e.name, e.args, e.span);
        }
        return lowerIndexLoad.call(this, e.name, e.args, e.span);
      }
      throw new UnsupportedConstruct(
        `'${e.name}' is an in-scope variable of type ` +
          `${typeToString(envEntry.ty)}; cannot be called as a function ` +
          `(scalar indexing and dynamically-typed handles are not supported)`,
        e.span
      );
    }

    const args = e.args.map(a => this.lowerExpr(a));
    for (const a of args) {
      this.requireValueType(a, `argument to '${e.name}'`);
    }
    const argTypes = args.map(a => a.ty);

    // Zero-arity mtoc2 builtins like `pi()` / `Inf()` / `NaN()`.
    // Numbl resolves these through a separate constants table
    // (`BUILTIN_CONSTANTS`) not in `index.builtins`, so
    // `workspace.resolve` returns null. The bare-name read path in
    // `lowerIdent` already handles `pi` (no parens); this branch
    // handles the paren-form. `e.args.length === 0` is the gate so
    // we don't accidentally claim a 1-arg call like `pi(2,3)` (which
    // numbl/MATLAB treat as a fill constructor — out of scope for
    // mtoc2 v1).
    if (args.length === 0) {
      const b = getBuiltin(e.name);
      if (b !== undefined && b.arity === 0) {
        const ty = b.transfer([], e.span);
        return {
          kind: "Call",
          cName: e.name,
          name: e.name,
          args: [],
          ty,
          span: e.span,
        };
      }
    }

    const target = this.workspace.resolve(
      e.name,
      argTypes,
      this.callSite(),
      e.span
    );
    if (!target) {
      // Fall back to mtoc2's builtin registry when numbl exposes the
      // name via a non-index surface (e.g. plot drawing primitives
      // like `plot`/`surf`/`imagesc`/`bar`, which numbl wires
      // through its runtime dispatch rather than `index.builtins`).
      // The validate-then-route shape is identical to the standard
      // builtin branch below; we just don't have numbl's blessing.
      const fallback = getBuiltin(e.name);
      if (fallback !== undefined && arityAccepts(fallback.arity, args.length)) {
        const ty = fallback.transfer(argTypes, e.span);
        return {
          kind: "Call",
          cName: e.name,
          name: e.name,
          args,
          ty,
          span: e.span,
        };
      }
      throw new UnsupportedConstruct(`unknown function '${e.name}'`, e.span);
    }
    switch (target.kind) {
      case "builtin": {
        // Numbl agreed it's a builtin; mtoc2 still requires the
        // builtin to be registered in its own table (and to match
        // arity).
        const b = getBuiltin(e.name);
        if (!b) {
          throw new UnsupportedConstruct(
            `builtin '${e.name}' is not supported by mtoc2`,
            e.span
          );
        }
        if (!arityAccepts(b.arity, args.length)) {
          throw new TypeError(
            `'${e.name}' expects ${arityDescribe(b.arity)} arg(s), got ${args.length}`,
            e.span
          );
        }
        const ty = b.transfer(argTypes, e.span);
        return {
          kind: "Call",
          cName: e.name,
          name: e.name,
          args,
          ty,
          span: e.span,
        };
      }
      case "userFunction": {
        // Expression-context: request nargout=1 (the call site's
        // single lvalue). A multi-output declared function specializes
        // with truncated output list — see the dotted-name branch
        // above and `specializeUserFunction` for the discipline.
        const spec = this.specializeUserFunction(
          target.ast,
          argTypes,
          undefined,
          target.file,
          undefined,
          target.ast.outputs.length === 0 ? 0 : 1
        );
        const ty: Type =
          target.ast.outputs.length === 0
            ? VOID
            : (spec.outputTypes[0] ?? { kind: "Unknown" });
        return {
          kind: "Call",
          cName: spec.cName,
          name: e.name,
          args,
          ty,
          span: e.span,
        };
      }
      case "classMethod": {
        // `method(obj, args)` syntax — the resolver decided this
        // name is a class method because one of the arg types is a
        // ClassInstance. Route through the same path as the dot
        // form.
        const reg = this.classReg(target.className);
        if (reg === undefined) {
          throw new UnsupportedConstruct(
            `internal: class '${target.className}' missing from workspace registry`,
            e.span
          );
        }
        const method = target.stripInstance
          ? reg.staticMethods.get(target.methodName)
          : reg.methods.get(target.methodName);
        if (method === undefined) {
          throw new TypeError(
            `class '${target.className}' has no ${target.stripInstance ? "static " : ""}method '${target.methodName}'`,
            e.span
          );
        }
        if (method.outputs.length >= 2) {
          throw new UnsupportedConstruct(
            `class method '${target.className}.${target.methodName}' has ` +
              `${method.outputs.length} outputs; multi-output methods can ` +
              `only be called via '[a, b, ...] = ...' (not yet supported ` +
              `for class methods) or as a bare statement`,
            e.span
          );
        }
        const callArgs = target.stripInstance ? args.slice(1) : args;
        const callArgTypes = callArgs.map(a => a.ty);
        const spec = this.specializeUserFunction(
          method,
          callArgTypes,
          classMethodSpecSource(target.className, target.methodName),
          reg.file,
          undefined,
          method.outputs.length === 0 ? 0 : 1
        );
        const ty: Type =
          method.outputs.length === 0
            ? VOID
            : (spec.outputTypes[0] ?? { kind: "Unknown" });
        return {
          kind: "Call",
          cName: spec.cName,
          name: `${target.className}.${target.methodName}`,
          args: callArgs,
          ty,
          span: e.span,
        };
      }
      case "classConstructor": {
        // Shouldn't fire because we short-circuit above on
        // `isClass(name)`, but kept for completeness.
        const reg = this.classReg(target.className);
        if (reg === undefined) {
          throw new UnsupportedConstruct(
            `internal: class '${target.className}' missing from workspace registry`,
            e.span
          );
        }
        return this.lowerClassConstructorCall(reg, e.args, e.span);
      }
    }
  }

  /** `struct('f1', v1, 'f2', v2, ...)`. Validates that args come in
   *  (string-literal-name, value) pairs and that no field is
   *  duplicated. Each value's storage type drives the field's
   *  recorded type — typedef shape is stable across writes because
   *  storage types are widened (no `exact`, no `sign`). */
  /** `bsxfun(@fn, A, B)` — when `@fn` is a function-handle literal
   *  whose name is one of the elementwise binary builtins, rewrite to
   *  `fn(A, B)` and let the existing implicit-expansion path do the
   *  work. Returns the lowered IR on success, or `null` to fall
   *  through to the generic call path (which will surface a clearer
   *  error for unsupported handle targets). Custom function-handle
   *  bsxfun is deferred. */
  private tryRewriteBsxfun(
    e: Extract<Expr, { type: "FuncCall" }>
  ): IRExpr | null {
    if (e.args.length !== 3) return null;
    const handleArg = e.args[0];
    if (handleArg.type !== "FuncHandle") {
      throw new UnsupportedConstruct(
        `'bsxfun' first arg must be a function-handle literal (e.g. @times); ` +
          `dynamic handle-value bsxfun is not yet supported`,
        e.span
      );
    }
    const handleName = handleArg.name;
    const knownOps = new Set([
      "plus",
      "minus",
      "times",
      "rdivide",
      "power",
      "eq",
      "ne",
      "lt",
      "le",
      "gt",
      "ge",
      "mod",
      "rem",
      "atan2",
      "hypot",
      "max",
      "min",
    ]);
    if (!knownOps.has(handleName)) {
      throw new UnsupportedConstruct(
        `'bsxfun' with handle target '@${handleName}' is not supported; ` +
          `supported targets: ${[...knownOps].sort().join(", ")}`,
        e.span
      );
    }
    const synthCall: Extract<Expr, { type: "FuncCall" }> = {
      type: "FuncCall",
      name: handleName,
      args: [e.args[1], e.args[2]],
      span: e.span,
    };
    return this.lowerFuncCall(synthCall);
  }

  private lowerStructConstructor(
    e: Extract<Expr, { type: "FuncCall" }>
  ): IRExpr {
    if (e.args.length % 2 !== 0) {
      throw new TypeError(
        `'struct' expects an even number of args (name, value, name, value, ...)`,
        e.span
      );
    }
    const fields: { name: string; value: IRExpr }[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < e.args.length; i += 2) {
      const nameExpr = e.args[i];
      if (nameExpr.type !== "String" && nameExpr.type !== "Char") {
        throw new TypeError(
          `'struct' field name (arg ${i + 1}) must be a string or char literal`,
          nameExpr.span
        );
      }
      // numbl's parser stores the literal's source text (including the
      // surrounding `'`/`"` quotes) in `value`. Strip them so the
      // recorded field name matches the user-visible name. Also
      // require a non-empty, identifier-shaped field name (no
      // embedded quotes/escapes etc).
      const fname = stripQuotes(nameExpr.value);
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(fname)) {
        throw new TypeError(
          `'struct' field name '${fname}' is not a valid identifier`,
          nameExpr.span
        );
      }
      if (seen.has(fname)) {
        throw new TypeError(
          `'struct': duplicate field '${fname}'`,
          nameExpr.span
        );
      }
      seen.add(fname);
      const v = this.lowerExpr(e.args[i + 1]);
      this.requireValueType(v, `value for field '${fname}'`);
      // Only types that have a stable owned-or-POD C representation
      // are allowed as struct field values. Reject handles (POD but
      // their typedef matrix gets messy), void, and Unknown.
      if (v.ty.kind === "Void" || v.ty.kind === "Unknown") {
        throw new TypeError(
          `value for field '${fname}': type ${typeToString(v.ty)} is not a valid struct field type`,
          e.args[i + 1].span
        );
      }
      fields.push({ name: fname, value: v });
    }
    // Build the StructType from each value's precise type. The typedef
    // hash uses `cFieldTypeStr` (one C-type string per field), so
    // different `exact` / `sign` / tensor-shape values across
    // constructions still share one C typedef. Carrying the precise
    // type through the IR lets a subsequent `aa = s.x` read return e.g.
    // `double[1×1]:positive=1` instead of a sign-stripped form.
    const tyFields = fields.map(f => ({
      name: f.name,
      ty: f.value.ty,
    }));
    const ty = structType(tyFields);
    // Re-order the values to match the canonical (sorted) field list
    // so the IR's `StructLit.fields` lines up with `ty.fields`.
    const sortedValues = fields
      .slice()
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    return {
      kind: "StructLit",
      fields: sortedValues,
      ty,
      span: e.span,
    };
  }

  /** `ClassName(args)` — class constructor call. Synthesizes a
   *  default-valued receiver (a `StructLit` whose `ty` is the
   *  class's declared `ClassType`) and routes it as the first arg of
   *  the specialized constructor.
   *
   *  When the class has properties without explicit defaults, the
   *  ClassType is resolved on first call: `resolveClassType()` runs
   *  the inference (lowering each pending property's first direct
   *  write in the constructor body, in a temp env bound to the
   *  call's argTypes) and caches the result on the registration. */
  private lowerClassConstructorCall(
    reg: ClassRegistration,
    args: Expr[],
    span: Span
  ): IRExpr {
    if (reg.constructor === null) {
      // No constructor declared: only a zero-arg call is valid; the
      // value IS the default-valued receiver. (Classes with pending
      // properties are required to declare a constructor at
      // registration time, so reg.ty is non-null on this branch.)
      if (args.length !== 0) {
        throw new TypeError(
          `class '${reg.className}' has no constructor; cannot pass arguments`,
          span
        );
      }
      const ty = this.resolveClassType(reg, [], span);
      return this.makeInitialClassReceiver(reg, ty, span);
    }
    const userArgs = args.map(a => this.lowerExpr(a));
    for (const a of userArgs) {
      this.requireValueType(a, `argument to constructor '${reg.className}'`);
    }
    const argTypes = userArgs.map(a => a.ty);
    const classTy = this.resolveClassType(reg, argTypes, span);
    const initialReceiver = this.makeInitialClassReceiver(reg, classTy, span);
    const outName = reg.constructor.outputs[0];
    const spec = this.specializeUserFunction(
      reg.constructor,
      argTypes,
      reg.className,
      reg.file,
      { name: outName, ty: classTy, initExpr: initialReceiver },
      1
    );
    // Constructor must return one output (validated at registration).
    const ty: Type = spec.outputTypes[0] ?? classTy;
    return {
      kind: "Call",
      cName: spec.cName,
      name: reg.className,
      args: userArgs,
      ty,
      span,
    };
  }

  /** Settle the class's `ClassType`. For a class with every property
   *  declaring a default, `reg.ty` is already filled in at
   *  registration and we just return it. For a class with pending
   *  properties, we pre-scan the constructor body for direct
   *  `obj.<prop> = <rhs>` writes (where `obj` is the constructor's
   *  output receiver) and lower each first-write RHS in a temp env
   *  bound to the call's `argTypes`. The first call wins — subsequent
   *  specs validate against the cached type via the normal
   *  `MemberStore` storage-equivalence check. */
  private resolveClassType(
    reg: ClassRegistration,
    argTypes: Type[],
    span: Span
  ): ClassType {
    if (reg.ty !== null) return reg.ty;
    // `registerClassDef` enforces that pendingProperties.size > 0
    // implies a constructor is declared. Defensive assertion.
    if (reg.constructor === null) {
      throw new UnsupportedConstruct(
        `internal: class '${reg.className}' has pending properties but no constructor`,
        span
      );
    }
    const decl = reg.constructor;
    if (argTypes.length !== decl.params.length) {
      // Surface the arity mismatch with the constructor call site span.
      throw new TypeError(
        `constructor '${reg.className}' expects ${decl.params.length} arg(s), got ${argTypes.length}`,
        span
      );
    }
    const receiverName = decl.outputs[0];

    // Save outer lowering state — we're going to lower the first-write
    // RHSs in a fresh env that mirrors the constructor's entry state
    // (params bound, no other locals).
    const savedEnv = this.env;
    const savedTempCounter = this.tempCounter;
    const savedCurrentFile = this.currentFile;
    this.env = new Map();
    this.tempCounter = 0;
    this.currentFile = reg.file;
    for (let i = 0; i < decl.params.length; i++) {
      this.env.set(decl.params[i], {
        cName: cIdentForUserName(decl.params[i]),
        ty: argTypes[i],
      });
    }

    const props: { name: string; ty: Type }[] = [];
    try {
      for (const propName of reg.propertyNames) {
        const def = reg.defaults.get(propName);
        if (def !== undefined) {
          // Default-having property: use the type already inferred at
          // registration (it's literal-derived, so it's stable).
          props.push({ name: propName, ty: def.ty });
          continue;
        }
        // Pending property: find the first top-level direct write in
        // the constructor body and lower its RHS for its static type.
        const rhs = findFirstPropertyWrite(decl.body, receiverName, propName);
        if (rhs === null) {
          throw new UnsupportedConstruct(
            `class '${reg.className}' property '${propName}' has no default ` +
              `and is not directly assigned at the top level of the ` +
              `constructor body (\`${receiverName}.${propName} = <expr>;\`); ` +
              `either add a default value or add such an assignment`,
            decl.span
          );
        }
        const inferred = this.lowerExpr(rhs);
        this.requireValueType(
          inferred,
          `inferring type of '${reg.className}.${propName}'`
        );
        props.push({ name: propName, ty: inferred.ty });
      }
    } finally {
      this.env = savedEnv;
      this.tempCounter = savedTempCounter;
      this.currentFile = savedCurrentFile;
    }

    const ty = classType(reg.className, props);
    reg.ty = ty;
    return ty;
  }

  /** Synthesize a `StructLit` whose ty is `classTy` and whose field
   *  values are the property defaults from `reg.defaults` — for any
   *  property without a default, synthesize a zero-value matching the
   *  inferred C-level type (the constructor body's first write
   *  overwrites it anyway; the zero is just a typed placeholder so
   *  the C designated initializer is well-formed and any
   *  read-before-write reads as 0 / empty). */
  private makeInitialClassReceiver(
    reg: ClassRegistration,
    classTy: ClassType,
    span: Span
  ): IRExpr {
    const fields: { name: string; value: IRExpr }[] = [];
    for (const p of classTy.properties) {
      const def = reg.defaults.get(p.name);
      let value: IRExpr;
      if (def !== undefined) {
        // Defaults are restricted to literals, so an empty env is
        // sufficient to lower them.
        const savedEnv = this.env;
        this.env = new Map();
        value = this.lowerExpr(def.expr);
        this.env = savedEnv;
      } else {
        value = synthesizeZeroValue(p.ty, reg.className, p.name, span);
      }
      fields.push({ name: p.name, value });
    }
    return {
      kind: "StructLit",
      fields,
      ty: classTy,
      span,
    };
  }

  // ── Function handles ──────────────────────────────────────────────────

  /** `@name` — a named handle to a top-level user function. Builds the
   *  handle type, captures empty, and returns a HandleLit. Builtin
   *  targets (`@disp`, `@sin`) are rejected — mtoc2 v1 doesn't support
   *  them. Class methods (`@SomeClass.method`) aren't reachable via
   *  this AST (the parser emits a different shape for those). The
   *  workspace resolver finds local + cross-file function targets. */
  private lowerFuncHandle(e: Extract<Expr, { type: "FuncHandle" }>): IRExpr {
    // Names shadowed by an in-scope variable: numbl forbids `@name` on
    // a non-function name (it's always a function reference, never a
    // var read).
    if (this.env.has(e.name)) {
      throw new TypeError(
        `function-handle target '@${e.name}' refers to an in-scope variable, ` +
          `not a function`,
        e.span
      );
    }
    if (getBuiltin(e.name)) {
      throw new UnsupportedConstruct(
        `builtin function handles (e.g. '@${e.name}') are not supported`,
        e.span
      );
    }
    // Pass `[]` argTypes — the resolver doesn't need them to decide
    // a function vs. classMethod for a bare `@name`; if the name is
    // a class instance method, the resolver returns its
    // `classMethod` verdict but we reject it (handles to class
    // methods aren't supported in v1).
    const target = this.workspace.resolve(e.name, [], this.callSite(), e.span);
    if (target?.kind !== "userFunction") {
      throw new UnsupportedConstruct(
        `unresolved function-handle target '@${e.name}'`,
        e.span
      );
    }
    // Use the source-level reference name (e.g. `pkg.foo`, `sq`) — NOT
    // `target.ast.name` (the basename) — so two handles to differently-
    // qualified functions with the same basename (`@pkg.foo` vs
    // `@other.foo`) produce distinct canonical types and don't unify.
    const ty = handleType(e.name, target.ast, []);
    return { kind: "HandleLit", captures: [], ty, span: e.span };
  }

  /** `@(p1, ..., pN) <body>` — an anonymous function. Detects every
   *  free Ident in the body that's bound in the enclosing scope (and
   *  not in the param list) as a capture, then synthesizes a top-level
   *  `function out = anon_<N>(p1, ..., pN, c1, ..., cM)` whose body
   *  assigns the source body expression to the synthesized output.
   *  The synthesized AST is parked in `functionDefs` so every call
   *  site routes through the same specialization cache used for
   *  user-declared functions.
   *
   *  Captures may be scalar real numeric, tensor, struct, class
   *  instance, or another handle — the handle's C struct ships with
   *  per-shape `_empty/_copy/_assign/_free` helpers (just like
   *  structs/classes), so owned-typed fields participate in the
   *  standard scope-exit-free / early-free lifecycle. String / Void /
   *  Unknown captures are rejected with `UnsupportedConstruct`. */
  private lowerAnonFunc(e: Extract<Expr, { type: "AnonFunc" }>): IRExpr {
    const paramSet = new Set(e.params);
    const captureNames: string[] = [];
    const captureSet = new Set<string>();
    collectAnonCaptures(this.env, e.body, paramSet, captureNames, captureSet);

    const captures: HandleCapture[] = [];
    const captureValues: { name: string; value: IRExpr }[] = [];
    for (const cname of captureNames) {
      if (paramSet.has(cname)) {
        throw new UnsupportedConstruct(
          `anonymous-function parameter '${cname}' shadows a captured ` +
            `variable; rename the parameter`,
          e.span
        );
      }
      const entry = this.env.get(cname);
      if (entry === undefined) {
        throw new UnsupportedConstruct(
          `internal: capture '${cname}' lost between detection and lowering`,
          e.span
        );
      }
      if (
        entry.ty.kind !== "Numeric" &&
        entry.ty.kind !== "Struct" &&
        entry.ty.kind !== "Class" &&
        entry.ty.kind !== "Handle"
      ) {
        throw new UnsupportedConstruct(
          `anonymous function captures '${cname}' of unsupported type ` +
            `${typeToString(entry.ty)} (string / void / unknown captures ` +
            `are not supported)`,
          e.span
        );
      }
      captures.push({ name: cname, ty: entry.ty });
      captureValues.push({
        name: cname,
        value: {
          kind: "Var",
          name: cname,
          cName: entry.cName,
          ty: entry.ty,
          span: e.span,
        },
      });
    }

    const idx = this.anonCounter++;
    const synthName = `anon_${idx}`;
    const outName = `anonOut_${idx}`;
    const synthAst: FuncStmt = {
      type: "Function",
      name: synthName,
      functionId: synthName,
      params: [...e.params, ...captureNames],
      outputs: [outName],
      body: [
        {
          type: "Assign",
          name: outName,
          expr: e.body,
          suppressed: true,
          span: e.span,
        },
      ],
      argumentsBlocks: [],
      span: e.span,
    };
    // The synth AST is reachable only via `handleTy.ast` at call
    // sites (`dispatchHandleCall` passes it straight to
    // `specializeUserFunction`); it never needs name-based lookup,
    // so we don't park it anywhere external.
    const ty = handleType(synthName, synthAst, captures);
    return {
      kind: "HandleLit",
      captures: captureValues,
      ty,
      span: e.span,
    };
  }

  /** Dispatch `h(args)` where `h` is an in-scope handle variable.
   *  Reads the handle's `ast` off its type, lowers the user-supplied
   *  args, appends per-capture `HandleCaptureLoad` reads, specializes
   *  the underlying function on the combined arg-type tuple, and emits
   *  a direct call to the mangled name. */
  private dispatchHandleCall(
    handleName: string,
    handleEntry: EnvEntry,
    argExprs: Expr[],
    span: Span
  ): IRExpr {
    const handleTy = handleEntry.ty as HandleType;
    const userArgs = argExprs.map(a => this.lowerExpr(a));
    for (const a of userArgs) {
      this.requireValueType(a, `argument to handle '${handleName}'`);
    }
    const baseVar: Extract<IRExpr, { kind: "Var" }> = {
      kind: "Var",
      name: handleName,
      cName: handleEntry.cName,
      ty: handleTy,
      span,
    };
    const captureArgs: IRExpr[] = handleTy.captures.map(c => ({
      kind: "HandleCaptureLoad",
      base: baseVar,
      captureName: c.name,
      ty: c.ty,
      span,
    }));
    const allArgs = [...userArgs, ...captureArgs];
    const argTypes = allArgs.map(a => a.ty);
    // The handle's stored AST carries its own source span, which
    // identifies the file the function was defined in — that's the
    // right file to salt the spec key with.
    if (handleTy.ast.outputs.length >= 2) {
      throw new UnsupportedConstruct(
        `handle '${handleName}' targets '${handleTy.targetName}', which ` +
          `has ${handleTy.ast.outputs.length} outputs; multi-output handle ` +
          `dispatch is not supported yet`,
        span
      );
    }
    const spec = this.specializeUserFunction(
      handleTy.ast,
      argTypes,
      undefined,
      handleTy.ast.span.file,
      undefined,
      handleTy.ast.outputs.length === 0 ? 0 : 1
    );
    const ty: Type =
      handleTy.ast.outputs.length === 0
        ? VOID
        : (spec.outputTypes[0] ?? { kind: "Unknown" });
    return {
      kind: "Call",
      cName: spec.cName,
      name: handleTy.targetName,
      args: allArgs,
      ty,
      span,
    };
  }

  // ── Function specialization ───────────────────────────────────────────

  /** Specialize a user function (or method, or anonymous-function
   *  synth) on the given arg-type tuple. The C mangling salts by the
   *  defining file so two files defining a same-named subfunction
   *  get distinct mangled names.
   *
   *  Caller is responsible for passing `definingFile` — for top-level
   *  functions resolved through the workspace, that's the resolver's
   *  verdict file; for class methods it's the class's file; for
   *  anonymous-function synth ASTs it's the file where `@(...)` was
   *  written. */
  private specializeUserFunction(
    decl: FuncStmt,
    argTypes: Type[],
    /** Optional override for the specialization-key source-name half.
     *  Class methods pass `<className>__<methodName>` so the mangled
     *  C name disambiguates two methods of the same source-level name
     *  on different classes. Defaults to `decl.name`. */
    specSource?: string,
    /** File the function definition lives in. Salts the spec key so
     *  cross-file homonyms get distinct C names. Defaults to the
     *  function's source span's file. */
    definingFile?: string,
    /** When set, the named output gets a synthetic first assignment
     *  to `initExpr` (an already-lowered IR expression) prepended to
     *  the body. The user's constructor body then sees the receiver
     *  initialized with the class defaults. */
    preSeedOutput?: { name: string; ty: Type; initExpr: IRExpr },
    /** Per-call-site `nargout`: the number of outputs the caller
     *  requested. Salts the spec key so two callers requesting
     *  different output counts get distinct specializations.
     *  Defaults to `decl.outputs.length` (the declared count) when
     *  the caller can't supply a more specific value (e.g.
     *  cross-file resolver paths that don't yet thread this through).
     *  Inside the body, the `nargout` identifier folds to this value
     *  via the `callFrameStack`. */
    nargout?: number
  ): IRFunc {
    if (argTypes.length !== decl.params.length) {
      throw new TypeError(
        `function '${decl.name}' expects ${decl.params.length} arg(s), got ${argTypes.length}`,
        decl.span
      );
    }
    const source = specSource ?? decl.name;
    const file = definingFile ?? decl.span.file ?? this.currentFile;
    // Per-specialization `nargout`: defaults to the declared count so
    // resolver paths that don't yet thread the caller's request still
    // produce a working specialization (matches numbl's "max possible
    // nargout" interpretation when the call site isn't statically
    // known). Callers that DO know — `lowerMultiAssign`,
    // `lowerFuncCall`, ExprStmt drop-all — supply the precise count
    // so the spec key shards correctly.
    const effectiveNargout = nargout ?? decl.outputs.length;
    // Hash the (file, argTypes, nargout) triple together so the C
    // name salts by all three. Keep the human-readable prefix
    // (`apply__<hex>`) — the hash collapses everything that doesn't
    // matter.
    const hashInput = `${file}|${argTypes.map(canonicalizeType).join("|")}|nargout=${effectiveNargout}`;
    const key = `${sanitizeCIdent(source)}__${hashType(hashInput)}`;
    const cached = this.specializations.get(key);
    if (cached) return cached;

    // Per-spec output list: truncate to the caller's requested nargout.
    // A 3-output function called as `[a] = f(...)` or `x = f(...)`
    // becomes a 1-output specialization (single-output C ABI); a bare
    // `f(...)` becomes a 0-output (void) spec. The body's assignments
    // to trailing outputs are kept but unused — the nargout fold may
    // dead-code them via `if nargout >= N` branches.
    const effectiveOutputs = decl.outputs.slice(0, effectiveNargout);
    // Insert placeholder to break recursion (not supported in MVP but
    // we'll throw a cleaner error than infinite recursion).
    const placeholder: IRFunc = {
      name: decl.name,
      cName: key,
      params: decl.params.slice(),
      cParams: decl.params.map(cIdentForUserName),
      paramTypes: argTypes,
      outputs: effectiveOutputs.slice(),
      cOutputs: effectiveOutputs.map(cIdentForUserName),
      outputTypes: [],
      body: [],
      span: decl.span,
    };
    this.specializations.set(key, placeholder);

    // Save outer state. The try/finally guarantees state is restored
    // even if body lowering throws — otherwise a TypeError /
    // UnsupportedConstruct from the body would leak this function's
    // env / tempCounter / currentFile / callFrameStack to the caller.
    const savedEnv = this.env;
    const savedTempCounter = this.tempCounter;
    const savedCurrentFile = this.currentFile;
    this.env = new Map();
    this.tempCounter = 0;
    this.currentFile = file;
    this.callFrameStack.push({
      nargin: argTypes.length,
      nargout: effectiveNargout,
    });

    try {
      // Bind params. The C name goes through `cIdentForUserName` so a
      // user-source `function r = f(struct)` doesn't reference the C
      // keyword `struct` for reads of `struct` inside the body.
      for (let i = 0; i < decl.params.length; i++) {
        const pName = decl.params[i];
        this.env.set(pName, {
          cName: cIdentForUserName(pName),
          ty: argTypes[i],
        });
      }
      // Class constructors pre-seed their output (the receiver) with
      // the default-valued class instance via an injected first stmt,
      // so the body can read `obj.x` / write `obj.x = ...` against an
      // initialized slot from the very first source statement.
      let initStmts: IRStmt[] = [];
      if (preSeedOutput !== undefined) {
        this.requireValueType(
          preSeedOutput.initExpr,
          `constructor init for '${preSeedOutput.name}'`
        );
        const initStmt = this.recordAssignment(
          preSeedOutput.name,
          preSeedOutput.initExpr,
          decl.span
        );
        initStmts = [initStmt];
      }

      const body = [...initStmts, ...this.lowerStmts(decl.body)];

      // Output types come from the final env value of each effective
      // output name. Trailing outputs the caller dropped via nargout
      // truncation aren't checked — they may legitimately be left
      // unassigned by a `if nargout >= N` body branch.
      const outputTypes: Type[] = effectiveOutputs.map(o => {
        const e = this.env.get(o);
        if (!e) {
          throw new TypeError(
            `function '${decl.name}': output '${o}' was never assigned`,
            decl.span
          );
        }
        return e.ty;
      });

      const out: IRFunc = {
        ...placeholder,
        body,
        outputTypes,
      };
      this.specializations.set(key, out);
      return out;
    } catch (err) {
      // Body lowering threw — drop the placeholder so a future call
      // with the same key (e.g. after the user fixes the error and
      // re-translates against the same Lowerer instance) re-attempts
      // specialization instead of returning the empty placeholder.
      this.specializations.delete(key);
      throw err;
    } finally {
      this.env = savedEnv;
      this.tempCounter = savedTempCounter;
      this.currentFile = savedCurrentFile;
      this.callFrameStack.pop();
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private requireScalarReal(
    t: Type,
    what: string,
    span: Span,
    detail?: string
  ): void {
    if (!isScalarRealNumeric(t)) {
      const suffix = detail ? ` ${detail}` : "";
      throw new UnsupportedConstruct(
        `${what} must be a scalar real numeric${suffix}`,
        span
      );
    }
  }

  /** Like `requireScalarReal` but also accepts scalar complex —
   *  used by `if` / `while` / `elseif` conds, where MATLAB's `toBool`
   *  rule (`creal(z) != 0 || cimag(z) != 0`) gives the boolean. */
  private requireScalarCondType(t: Type, what: string, span: Span): void {
    if (
      isNumeric(t) &&
      (t.elem === "double" || t.elem === "logical") &&
      t.dims.length === 2 &&
      t.dims[0].kind === "exact" &&
      t.dims[0].value === 1 &&
      t.dims[1].kind === "exact" &&
      t.dims[1].value === 1
    ) {
      return;
    }
    throw new UnsupportedConstruct(`${what} must be a scalar numeric`, span);
  }

  private mergeBranchEnvs(
    envs: Map<string, EnvEntry>[]
  ): Map<string, EnvEntry> {
    // Collect all keys present in any branch. Variables assigned in
    // only some branches stay in scope after the merge — MATLAB's rule
    // is "declared if any path declared it; reading without that path
    // having run is a runtime error". Codegen pre-declares such locals
    // at function top (see `collectHoistedScalarLocals` in emit.ts) so
    // a later C-level read survives the block's lexical scope.
    const allKeys = new Set<string>();
    for (const e of envs) for (const k of e.keys()) allKeys.add(k);
    const out = new Map<string, EnvEntry>();
    for (const k of allKeys) {
      const present = envs
        .map(e => e.get(k))
        .filter((x): x is EnvEntry => x !== undefined);
      if (present.length === 0) continue;
      let ty: Type = present[0].ty;
      for (let i = 1; i < present.length; i++) {
        ty = unify(ty, present[i].ty);
      }
      // Drop `exact` if the key is missing in any branch — the
      // runtime value can't be guaranteed to match.
      if (present.length < envs.length) {
        ty = withoutExact(ty);
      }
      out.set(k, { cName: present[0].cName, ty });
    }
    return out;
  }
}

// ── Helpers (free functions) ────────────────────────────────────────────

/** C reserved words that are also legal numbl identifiers. mtoc2 maps
 *  every user variable / param name through `cIdentForUserName` at
 *  declaration time so a variable named `struct`, `for`, `int`, etc.
 *  doesn't collide with a C keyword on the emit side. The keyword
 *  list mirrors numbl's C-JIT codegen. `mtoc2_` is reserved for the
 *  translator's own synthetic names. */
const C_RESERVED_NAMES: ReadonlySet<string> = new Set([
  "auto",
  "break",
  "case",
  "char",
  "const",
  "continue",
  "default",
  "do",
  "double",
  "else",
  "enum",
  "extern",
  "float",
  "for",
  "goto",
  "if",
  "inline",
  "int",
  "long",
  "register",
  "restrict",
  "return",
  "short",
  "signed",
  "sizeof",
  "static",
  "struct",
  "switch",
  "typedef",
  "union",
  "unsigned",
  "void",
  "volatile",
  "while",
  "main",
  // C99/C11 keywords seen in our runtime headers
  "_Bool",
  "_Complex",
  "_Imaginary",
]);

/** Map a user-source variable name to a safe C identifier. C keywords
 *  get a `v_` prefix; other names pass through unchanged so emitted C
 *  remains readable for the common case. The numbl parser already
 *  rejects identifiers starting with `_`, so a user `for` only collides
 *  with the C keyword (not with `v_for` from any other source). */
function cIdentForUserName(name: string): string {
  if (C_RESERVED_NAMES.has(name)) return `v_${name}`;
  return name;
}

/** Walk a chain of Ident / Member nodes (no calls, no indexing) and
 *  return the dotted-name they form, e.g. `Member(Ident("pkg"),
 *  "sub")` → `"pkg.sub"`. Returns null for any other shape. Used to
 *  detect `pkg.foo(...)` and `pkg.sub.foo(...)` package call shapes
 *  before falling through to instance-method dispatch. Mirrors
 *  numbl's interpreter helper of the same name. */
function tryExtractDottedName(e: Expr): string | null {
  if (e.type === "Ident") return e.name;
  if (e.type === "Member") {
    const base = tryExtractDottedName(e.base);
    if (base) return `${base}.${e.name}`;
  }
  return null;
}

/** Scan a constructor body for the FIRST top-level direct
 *  `<receiver>.<propName> = <rhs>` assignment. Returns the rhs Expr,
 *  or `null` if no such assignment is found. Conditional / loop /
 *  nested-block writes are intentionally NOT considered — for v1,
 *  property-type inference relies on writes that the body
 *  unconditionally performs. */
function findFirstPropertyWrite(
  body: Stmt[],
  receiverName: string,
  propName: string
): Expr | null {
  for (const s of body) {
    if (
      s.type === "AssignLValue" &&
      s.lvalue.type === "Member" &&
      s.lvalue.name === propName &&
      s.lvalue.base.type === "Ident" &&
      s.lvalue.base.name === receiverName
    ) {
      return s.expr;
    }
  }
  return null;
}

/** Build a zero / empty IR value of `ty`'s C-level shape. Used by
 *  `makeInitialClassReceiver` to fill the `StructLit` slot for a
 *  property that lacks an explicit default — the constructor body's
 *  first write overwrites it anyway, but the C designated initializer
 *  still needs a syntactic value, and a read-before-write should
 *  observe a stable zero. Only Numeric types are supported in v1;
 *  struct / class / handle / string properties without defaults raise
 *  `UnsupportedConstruct` here. */
function synthesizeZeroValue(
  ty: Type,
  className: string,
  propName: string,
  span: Span
): IRExpr {
  if (ty.kind === "Numeric") {
    if (isMultiElement(ty)) {
      // Empty 0×0 tensor — matches MATLAB's `[]` initial value. The
      // first constructor write replaces it.
      return {
        kind: "TensorBuild",
        elements: [],
        shape: [0, 0],
        ty: tensorDouble([0, 0]),
        span,
      };
    }
    return {
      kind: "NumLit",
      value: 0,
      ty: scalarDouble("zero", 0),
      span,
    };
  }
  throw new UnsupportedConstruct(
    `class '${className}' property '${propName}' is inferred to type ` +
      `${typeToString(ty)}, but v1 can only synthesize a zero placeholder ` +
      `for numeric properties; provide an explicit default value`,
    span
  );
}

/** If the lowered cond's type carries an exact scalar value, return
 *  its boolean interpretation; otherwise null. This is the ONLY place
 *  the lowerer turns a known exact value into a compile-time decision —
 *  the resulting branch is taken/dropped before codegen. Arithmetic /
 *  comparisons / builtin calls and Ident reads all produce runtime IR
 *  even when their `ty.exact` is known. */
function condToBool(cond: IRExpr): boolean | null {
  if (!isNumeric(cond.ty)) return null;
  const x = cond.ty.exact;
  if (typeof x === "number") {
    if (!Number.isFinite(x)) return null;
    return x !== 0;
  }
  // Scalar complex exact `{re, im}` — truthy iff either part is nonzero.
  if (
    x !== undefined &&
    typeof x === "object" &&
    !(x instanceof Float64Array) &&
    !(x.re instanceof Float64Array)
  ) {
    const sx = x as { re: number; im: number };
    if (!Number.isFinite(sx.re) || !Number.isFinite(sx.im)) return null;
    return sx.re !== 0 || sx.im !== 0;
  }
  return null;
}

/** True when `e` is guaranteed side-effect-free: NumLit, Var, EndRef,
 *  HandleCaptureLoad, and pure compositions of those via Binary /
 *  Unary. Calls (user functions and any builtin — `disp`, `tic`,
 *  bounds-checked indexing) are conservatively treated as impure.
 *  Used by `lowerIf`'s fold path: when the cond folds to a constant,
 *  pure conds are dropped entirely; impure ones get prepended as an
 *  `ExprStmt` so their side effects still run. */
function condIsPure(e: IRExpr): boolean {
  switch (e.kind) {
    case "NumLit":
    case "ImagLit":
    case "Var":
    case "EndRef":
    case "HandleCaptureLoad":
      return true;
    case "Unary":
      return condIsPure(e.operand);
    case "Binary":
      return condIsPure(e.left) && condIsPure(e.right);
    default:
      return false;
  }
}

/** Walk an anonymous-function body and register every free `Ident`
 *  whose name is bound in the enclosing scope (and not in the param
 *  list) as a capture. Order matters — we use registration order for
 *  the synth function's tail params and the handle struct's field
 *  layout, so the call site can match positions.
 *
 *  Names that hit a registered builtin OR a top-level user function
 *  are NOT captures — they're function references resolved at the
 *  call site. A bare-Ident reference to such a name without a call is
 *  not yet meaningful in mtoc2 (only `@name` produces a handle), so we
 *  conservatively treat any in-scope variable as a capture.
 *
 *  Nested `@(...)` and `@name` inside the body do NOT contribute to
 *  the OUTER anonymous's captures — `@name` resolves at body-lowering
 *  time, and a nested `@(...)`'s captures are detected when that
 *  inner anonymous itself is lowered. */
function collectAnonCaptures(
  outerEnv: ReadonlyMap<string, EnvEntry>,
  e: Expr,
  params: ReadonlySet<string>,
  names: string[],
  seen: Set<string>
): void {
  const register = (name: string): void => {
    if (params.has(name)) return;
    if (seen.has(name)) return;
    if (getBuiltin(name)) return;
    if (!outerEnv.has(name)) return;
    seen.add(name);
    names.push(name);
  };
  switch (e.type) {
    case "Ident":
      register(e.name);
      return;
    case "Number":
      return;
    case "Binary":
      collectAnonCaptures(outerEnv, e.left, params, names, seen);
      collectAnonCaptures(outerEnv, e.right, params, names, seen);
      return;
    case "Unary":
      collectAnonCaptures(outerEnv, e.operand, params, names, seen);
      return;
    case "Range":
      collectAnonCaptures(outerEnv, e.start, params, names, seen);
      if (e.step) collectAnonCaptures(outerEnv, e.step, params, names, seen);
      collectAnonCaptures(outerEnv, e.end, params, names, seen);
      return;
    case "FuncCall":
      // A bare `name(args)` may refer to a captured handle variable
      // OR to a top-level user function / builtin. The same
      // `register` predicate filters: only bound-in-outer-scope names
      // become captures.
      register(e.name);
      for (const a of e.args)
        collectAnonCaptures(outerEnv, a, params, names, seen);
      return;
    case "Tensor":
      for (const row of e.rows) {
        for (const cell of row) {
          collectAnonCaptures(outerEnv, cell, params, names, seen);
        }
      }
      return;
    case "AnonFunc": {
      const nested = new Set(params);
      for (const p of e.params) nested.add(p);
      collectAnonCaptures(outerEnv, e.body, nested, names, seen);
      return;
    }
    case "FuncHandle":
      // `@name` resolves to a function reference at body-lowering
      // time — not a capture of the outer scope.
      return;
    case "Member":
      collectAnonCaptures(outerEnv, e.base, params, names, seen);
      return;
    case "Index":
      collectAnonCaptures(outerEnv, e.base, params, names, seen);
      for (const idx of e.indices) {
        collectAnonCaptures(outerEnv, idx, params, names, seen);
      }
      return;
    case "MethodCall":
      // `pkg.foo(args)` and `obj.method(args)` both parse as
      // MethodCall. The base chain may reference a captured variable
      // (the leftmost ident of `obj.method(...)`) or a workspace name
      // (the leftmost ident of `pkg.foo(...)`) — `register` filters
      // out workspace names because they aren't bound in outerEnv.
      collectAnonCaptures(outerEnv, e.base, params, names, seen);
      for (const a of e.args)
        collectAnonCaptures(outerEnv, a, params, names, seen);
      return;
    case "SuperMethodCall":
      for (const a of e.args)
        collectAnonCaptures(outerEnv, a, params, names, seen);
      return;
    default:
      // Other expression kinds remaining (literals, etc.) carry no
      // captures; any unsupported expression in the body fails when
      // the body itself is lowered.
      return;
  }
}

/** Return a copy of `t` with the type at `fieldPath` replaced by
 *  `newLeafTy`. Walks struct/class types; if the path can't be
 *  resolved (shouldn't happen — the caller already validated), the
 *  original type is returned unchanged. Other type kinds at a path
 *  step are returned as-is.
 *
 *  Used by `lowerAssignLValue` to refresh env after a MemberStore so
 *  subsequent reads of the touched field/property report the post-
 *  write rhs type rather than the construction-site default. */
function withPathTypeUpdated(
  t: Type,
  fieldPath: ReadonlyArray<string>,
  newLeafTy: Type
): Type {
  if (fieldPath.length === 0) return newLeafTy;
  const [head, ...rest] = fieldPath;
  if (t.kind === "Struct") {
    return structType(
      t.fields.map(f =>
        f.name === head
          ? { name: f.name, ty: withPathTypeUpdated(f.ty, rest, newLeafTy) }
          : f
      )
    );
  }
  if (t.kind === "Class") {
    return {
      kind: "Class",
      className: t.className,
      properties: t.properties.map(p =>
        p.name === head
          ? { name: p.name, ty: withPathTypeUpdated(p.ty, rest, newLeafTy) }
          : p
      ),
    };
  }
  return t;
}

/** Strip the surrounding `'` or `"` quotes the numbl parser stores as
 *  part of a `Char`/`String` literal's lexeme. */
function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/** Refresh the env entry's `exact: Float64Array` in place after a
 *  scalar IndexStore when both the indices and the rhs are compile-
 *  time-known. Returns true on success (env updated), false if any
 *  precondition fails — the caller falls back to widening (strip
 *  exact). Only handles `IndexStore` (scalar lvalue); slice stores
 *  keep the existing strip-exact behavior. */
function tryRefreshExactAfterIndexedWrite(
  env: Map<string, { cName: string; ty: Type }>,
  name: string,
  result: IRStmt | IRStmt[]
): boolean {
  const last = Array.isArray(result) ? result[result.length - 1] : result;
  if (last.kind !== "IndexStore") return false;
  const e = env.get(name);
  if (e === undefined) return false;
  if (e.ty.kind !== "Numeric") return false;
  const ty = e.ty;
  const shape = ty.shape;
  const data = ty.exact;
  if (shape === undefined || !(data instanceof Float64Array)) return false;
  if (!isNumeric(last.rhs.ty) || typeof last.rhs.ty.exact !== "number") {
    return false;
  }
  const rhsVal = last.rhs.ty.exact;
  const idxVals: number[] = [];
  for (const ix of last.indices) {
    if (!isNumeric(ix.ty) || typeof ix.ty.exact !== "number") return false;
    const v = ix.ty.exact;
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < 1) return false;
    idxVals.push(v);
  }
  let offset: number;
  if (idxVals.length === 1) {
    const total = shape.reduce((a, b) => a * b, 1);
    if (idxVals[0] > total) return false;
    offset = idxVals[0] - 1;
  } else if (idxVals.length === shape.length) {
    offset = 0;
    let stride = 1;
    for (let k = 0; k < shape.length; k++) {
      if (idxVals[k] > shape[k]) return false;
      offset += (idxVals[k] - 1) * stride;
      stride *= shape[k];
    }
  } else {
    return false;
  }
  const newData = new Float64Array(data);
  newData[offset] = rhsVal;
  const newSign = signFromExactArray(newData);
  env.set(name, {
    cName: e.cName,
    ty: { ...ty, exact: newData, sign: newSign },
  });
  return true;
}

/** Walk a stmt-tree and collect names of LHS targets (Assign, MultiAssign,
 *  For loop vars). Used to widen loop-body-mutated env entries to non-exact. */
/** Extract the rhs sign from an IndexStore / IndexSliceStore result so
 *  `widenAfterIndexedWrite` can unify it into the base's lattice sign.
 *  The store is always the last stmt in the result (lowerIndexSliceStore
 *  may prepend hoists). */
function rhsSignFromStoreResult(result: IRStmt | IRStmt[]): Sign {
  const last = Array.isArray(result) ? result[result.length - 1] : result;
  if (last.kind !== "IndexStore" && last.kind !== "IndexSliceStore") {
    return "unknown";
  }
  return isNumeric(last.rhs.ty) ? last.rhs.ty.sign : "unknown";
}

function collectAssignedNames(stmts: Stmt[]): Set<string> {
  const out = new Set<string>();
  const walk = (ss: Stmt[]): void => {
    for (const s of ss) {
      switch (s.type) {
        case "Assign":
          out.add(s.name);
          break;
        case "AssignLValue": {
          // `s.f.g = rhs` and `s(i) = rhs` inside a loop body both
          // mutate `s` — so the loop entry needs to strip exact from
          // `s` (and its recursive struct/class field types) just
          // like a plain `s = ...` reassignment would. Walk the
          // Member / Index chain to find the root Ident; either form
          // is rooted at one (the lvalue lowerers reject anything
          // else).
          let cur: Expr | null = null;
          if (s.lvalue.type === "Member") cur = s.lvalue.base;
          else if (s.lvalue.type === "Index") cur = s.lvalue.base;
          while (cur !== null && cur.type === "Member") cur = cur.base;
          if (cur !== null && cur.type === "Ident") out.add(cur.name);
          break;
        }
        case "MultiAssign":
          for (const lv of s.lvalues) {
            if (lv.type === "Var") out.add(lv.name);
          }
          break;
        case "If":
          walk(s.thenBody);
          for (const eb of s.elseifBlocks) walk(eb.body);
          if (s.elseBody) walk(s.elseBody);
          break;
        case "While":
          walk(s.body);
          break;
        case "For":
          out.add(s.varName);
          walk(s.body);
          break;
        case "Switch":
          for (const c of s.cases) walk(c.body);
          if (s.otherwise) walk(s.otherwise);
          break;
        case "TryCatch":
          walk(s.tryBody);
          walk(s.catchBody);
          break;
      }
    }
  };
  walk(stmts);
  return out;
}

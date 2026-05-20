/**
 * Tree-walking interpreter — mtoc2's always-available execution path.
 *
 * Walks the AST (not the IR) and routes every operator through the
 * builtin registry's `call` hook, so the interpreter is bit-identical
 * to the c-aot / js-aot paths for any operation a builtin's `call`
 * covers. There's no lowering pass, no specialization, no type
 * inference beyond what's needed to dispatch builtins.
 *
 * Workspace resolution: uses `Workspace.resolve` (numbl's
 * `resolveFunction` under the hood) so MATLAB precedence + package +
 * class-folder + builtin order match the c-aot path exactly.
 *
 * The class shell lives here. Method implementations live in:
 *   - interpreterExec.ts      — execStmt, assignLValue, expandForRange
 *   - interpreterEval.ts      — evalExpr, indexTensor
 *   - interpreterFunctions.ts — callByName, callUserFunction,
 *                               callHandle, constructClassInstance,
 *                               invokeBuiltin
 *
 * Each sibling file exports its methods as top-level functions with
 * `this: Interpreter` typing; the prototype-augmentation block at the
 * bottom of this file attaches them to `Interpreter.prototype`. This
 * mirrors numbl's interpreter split — same pattern, fewer files
 * because mtoc2's interpreter has a smaller surface today.
 */

import type {
  Expr,
  Stmt,
  Span,
  LValue,
  AbstractSyntaxTree,
} from "../parser/index.js";
import { Environment } from "./environment.js";
import type { RuntimeContext } from "../runtime/context.js";
import type {
  RuntimeHandle,
  RuntimeTensor,
  RuntimeValue,
} from "../runtime/value.js";
import type { Builtin } from "../builtins/registry.js";
import type { Type } from "../lowering/types.js";
import type { ClassRegistration } from "../lowering/classDefs.js";
import { Workspace } from "../workspace/workspace.js";
import { mtoc2_format_double } from "../builtins/runtime/snippets.gen.js";

// ── Control-flow signals (thrown across stmt boundaries) ─────────────────

/** @internal */
export class ReturnSignal {}
/** @internal */
export class BreakSignal {}
/** @internal */
export class ContinueSignal {}

// ── Interpreter ──────────────────────────────────────────────────────────

export class Interpreter {
  /** @internal */ readonly ctx: RuntimeContext;
  /** @internal */ readonly env: Environment;
  /** @internal */ readonly workspace: Workspace | undefined;
  /** @internal Names currently active on the call stack — used to
   *  reject recursion in the MVP. */
  readonly active = new Set<string>();
  /** @internal Source file for `Workspace.resolve` call-site attribution. */
  readonly currentFile: string;
  /** @internal Active index-slot stack — pushed on entering an index
   *  slot (FuncCall args / Index expression / AssignLValue indices) so
   *  a nested `end` keyword inside an expression like `v(end-1)`
   *  resolves to the size of the axis being indexed. Top of stack is
   *  the innermost slot. */
  readonly endStack: Array<{
    baseTensor: { shape: ReadonlyArray<number>; data: ArrayLike<number> };
    axis: number | "linear";
  }> = [];

  constructor(
    ctx: RuntimeContext,
    opts: {
      env?: Environment;
      workspace?: Workspace;
      currentFile?: string;
    } = {}
  ) {
    this.ctx = ctx;
    this.env = opts.env ?? new Environment();
    if (opts.workspace !== undefined) this.workspace = opts.workspace;
    this.currentFile = opts.currentFile ?? "<inline>";

    // Bind $write before any builtin runs — snippet code resolves
    // `$write` as a free variable on globalThis.
    globalThis.$write = ctx.helpers.write;
  }

  /** Run a parsed AST as the top-level program. Returns when execution
   *  finishes normally, on a top-level `return`, or by re-throwing any
   *  uncaught runtime error. */
  runProgram(body: Stmt[]): void {
    try {
      this.execBody(body);
    } catch (e) {
      if (e instanceof ReturnSignal) return;
      throw e;
    }
  }

  /** @internal Resolve the current `end` keyword against the top of
   *  `endStack`. Throws if there's no active slot (the parser should
   *  have caught this, but the interpreter walks the raw AST). */
  resolveEnd(): number {
    if (this.endStack.length === 0) {
      throw new (class extends Error {})(
        `interpreter: 'end' used outside an index slot`
      );
    }
    const top = this.endStack[this.endStack.length - 1];
    if (top.axis === "linear") return top.baseTensor.data.length;
    return top.baseTensor.shape[top.axis] ?? 1;
  }

  // ── Methods added by interpreterExec.ts ───────────────────────────────
  declare execBody: (body: Stmt[]) => void;
  declare execStmt: (s: Stmt) => void;
  declare assignLValue: (
    lv: LValue,
    v: RuntimeValue,
    suppressed: boolean
  ) => void;
  declare collectMemberPath: (
    lv: LValue
  ) => { rootName: string; fields: string[] } | null;
  declare expandForRange: (e: Expr) => RuntimeValue[];
  declare autoDisp: (name: string, v: RuntimeValue) => void;

  // ── Methods added by interpreterEval.ts ───────────────────────────────
  declare evalExpr: (e: Expr) => RuntimeValue;
  declare indexTensor: (
    base: RuntimeTensor,
    rawArgs: ReadonlyArray<Expr>,
    span: Span
  ) => RuntimeValue;
  declare tryExtractDottedName: (e: Expr) => string | null;

  // ── Methods added by interpreterFunctions.ts ──────────────────────────
  declare callByName: (
    name: string,
    args: RuntimeValue[],
    nargout: number,
    span: Span
  ) => RuntimeValue[];
  declare callHandle: (
    h: RuntimeHandle,
    args: RuntimeValue[],
    span: Span
  ) => RuntimeValue;
  declare callUserFunction: (
    fn: Extract<Stmt, { type: "Function" }>,
    args: RuntimeValue[],
    nargout: number,
    span: Span,
    sourceFile?: string
  ) => RuntimeValue[];
  declare constructClassInstance: (
    reg: ClassRegistration,
    args: RuntimeValue[],
    span: Span
  ) => RuntimeValue[];
  declare invokeBuiltin: (
    b: Builtin,
    args: RuntimeValue[],
    argTypes: Type[],
    nargout: number,
    sourceName: string
  ) => RuntimeValue[];

  // Used by assignLValue to clone struct-shaped objects while
  // preserving the non-enumerable `mtoc2Class` tag (a naive `{...host}`
  // spread silently drops it). Static so callers don't pay for a
  // method lookup per write.
  /** @internal */
  static cloneStructLocal(
    src: Record<string, RuntimeValue>
  ): Record<string, RuntimeValue> {
    const out: Record<string, RuntimeValue> = {};
    for (const k of Object.keys(src)) out[k] = src[k];
    const tag = (src as { mtoc2Class?: string }).mtoc2Class;
    if (tag !== undefined) {
      Object.defineProperty(out, "mtoc2Class", {
        value: tag,
        enumerable: false,
        writable: false,
      });
    }
    return out;
  }
}

// Re-export so callers (CLI, browser preview) can format scalar values
// without routing through the interpreter.
export { mtoc2_format_double };

// Suppress "imported for type-only" warning for AbstractSyntaxTree —
// re-exported here so external entry-point types stay convenient.
export type { AbstractSyntaxTree };

// ── Prototype augmentation ───────────────────────────────────────────────
// Import method implementations from split files and assign to prototype.

import * as Exec from "./interpreterExec.js";
import * as Eval from "./interpreterEval.js";
import * as Funcs from "./interpreterFunctions.js";

const proto = Interpreter.prototype as unknown as Record<string, unknown>;
for (const mod of [Exec, Eval, Funcs]) {
  for (const [key, val] of Object.entries(mod)) {
    if (typeof val === "function") proto[key] = val;
  }
}

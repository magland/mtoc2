/**
 * Tree-walking interpreter — mtoc2's always-available execution path.
 *
 * Routes every operator through the builtin registry's `call` hook so
 * the JIT bailout target (future work) stays bit-identical to the
 * interpreter's behaviour. Walks the AST (not the IR) — there's no
 * lowering pass, no specialization, no type inference beyond what's
 * needed to dispatch builtins (each call site infers `argTypes` from
 * runtime values and feeds them to `builtin.transfer`).
 *
 * MVP scope (Phase 3): top-level scripts + user functions + scalar
 * real / boolean / string / char. Tensor literals, indexing,
 * handles, structs, classes, multi-output, method calls, package
 * calls — each raises a clear "not implemented" error and gates on
 * subsequent phases.
 *
 * Workspace resolution: uses `Workspace.resolve` (numbl's
 * `resolveFunction` under the hood) so MATLAB precedence + package +
 * class-folder + builtin order match the C path exactly.
 */

import {
  BinaryOperation,
  UnaryOperation,
  type Expr,
  type Stmt,
  type LValue,
  type Span,
} from "../parser/index.js";
import { Environment } from "./environment.js";
import type { RuntimeContext } from "../runtime/context.js";
import {
  isChar as isCharRV,
  isTensor,
  isTruthy,
  makeChar,
  makeTensor,
  toScalarNumber,
  type RuntimeValue,
} from "../runtime/value.js";
import { getBuiltin } from "../lowering/builtins/index.js";
import type { Builtin } from "../lowering/builtins/registry.js";
import { inferTypeFromValue } from "../runtime/inferType.js";
import { Workspace } from "../workspace/workspace.js";
import { UnsupportedConstruct } from "../lowering/errors.js";
import {
  mtoc2_disp_double,
  mtoc2_format_double,
  mtoc2_tensor_make_range as jsMakeRange,
} from "../codegen/runtime/snippets.gen.js";

class ReturnSignal {}
class BreakSignal {}
class ContinueSignal {}

const BINOP_BUILTIN: Record<string, string> = {
  [BinaryOperation.Add]: "plus",
  [BinaryOperation.Sub]: "minus",
  [BinaryOperation.Mul]: "mtimes",
  [BinaryOperation.ElemMul]: "times",
  [BinaryOperation.Div]: "mrdivide",
  [BinaryOperation.ElemDiv]: "rdivide",
  [BinaryOperation.Pow]: "mpower",
  [BinaryOperation.ElemPow]: "power",
  [BinaryOperation.Equal]: "eq",
  [BinaryOperation.NotEqual]: "ne",
  [BinaryOperation.Less]: "lt",
  [BinaryOperation.LessEqual]: "le",
  [BinaryOperation.Greater]: "gt",
  [BinaryOperation.GreaterEqual]: "ge",
};

const UNOP_BUILTIN: Record<string, string> = {
  [UnaryOperation.Minus]: "uminus",
  [UnaryOperation.Not]: "not",
  // `.'` (non-conjugate) maps directly to `transpose`. The complex
  // `'` form lowers to `transpose(conj(z))` in mtoc2's lowering
  // pass; the interpreter walks the AST pre-lowering, so for now
  // we route both to `transpose` — real programs match. Complex
  // inputs will surface a clearer error in transpose's transfer.
  [UnaryOperation.NonConjugateTranspose]: "transpose",
  [UnaryOperation.Transpose]: "transpose",
};

export class Interpreter {
  private readonly ctx: RuntimeContext;
  private readonly env: Environment;
  private readonly workspace: Workspace | undefined;
  /** Names currently active on the call stack — used to reject
   *  recursion in the MVP. */
  private readonly active = new Set<string>();
  /** Source file for `Workspace.resolve` call-site attribution. */
  private readonly currentFile: string;

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

    // Bind $write before any builtin runs (snippet code resolves
    // `$write` as a free variable on globalThis).
    globalThis.$write = ctx.helpers.write;
  }

  runProgram(body: Stmt[]): void {
    try {
      this.execBody(body);
    } catch (e) {
      if (e instanceof ReturnSignal) return;
      throw e;
    }
  }

  // ── Statements ─────────────────────────────────────────────────────────

  private execBody(body: Stmt[]): void {
    for (const stmt of body) {
      this.execStmt(stmt);
    }
  }

  private execStmt(s: Stmt): void {
    switch (s.type) {
      case "Assign": {
        const v = this.evalExpr(s.expr);
        this.env.set(s.name, v);
        if (!s.suppressed) this.autoDisp(s.name, v);
        return;
      }
      case "AssignLValue": {
        const v = this.evalExpr(s.expr);
        this.assignLValue(s.lvalue, v, s.suppressed);
        return;
      }
      case "MultiAssign": {
        // Builtins return RuntimeValue[]; user functions return same
        // shape. Both come through callByName.
        if (s.expr.type !== "FuncCall") {
          throw new UnsupportedConstruct(
            `interpreter: MultiAssign supports only FuncCall RHS in the MVP ` +
              `(got '${s.expr.type}')`,
            s.span
          );
        }
        const argVals = s.expr.args.map(a => this.evalExpr(a));
        const results = this.callByName(
          s.expr.name,
          argVals,
          s.lvalues.length,
          s.span
        );
        for (let i = 0; i < s.lvalues.length; i++) {
          this.assignLValue(s.lvalues[i], results[i], s.suppressed);
        }
        return;
      }
      case "ExprStmt": {
        const v = this.evalExpr(s.expr);
        if (v === undefined) return;
        if (!s.suppressed) this.autoDisp("ans", v);
        this.env.set("ans", v);
        return;
      }
      case "If": {
        if (isTruthy(this.evalExpr(s.cond))) {
          this.execBody(s.thenBody);
          return;
        }
        for (const eb of s.elseifBlocks) {
          if (isTruthy(this.evalExpr(eb.cond))) {
            this.execBody(eb.body);
            return;
          }
        }
        if (s.elseBody) this.execBody(s.elseBody);
        return;
      }
      case "While": {
        while (isTruthy(this.evalExpr(s.cond))) {
          try {
            this.execBody(s.body);
          } catch (e) {
            if (e instanceof BreakSignal) return;
            if (e instanceof ContinueSignal) continue;
            throw e;
          }
        }
        return;
      }
      case "For": {
        const iter = this.expandForRange(s.expr);
        for (const v of iter) {
          this.env.set(s.varName, v);
          try {
            this.execBody(s.body);
          } catch (e) {
            if (e instanceof BreakSignal) return;
            if (e instanceof ContinueSignal) continue;
            throw e;
          }
        }
        return;
      }
      case "Break":
        throw new BreakSignal();
      case "Continue":
        throw new ContinueSignal();
      case "Return":
        throw new ReturnSignal();

      // Non-executable at this level — body of a Function is run
      // through `callUserFunction`, not `execBody`. ClassDef /
      // Global / Persistent / Import / Directive are workspace-time
      // declarations that the interpreter doesn't enact at exec time.
      case "Function":
      case "ClassDef":
      case "Global":
      case "Persistent":
      case "Import":
      case "Directive":
        return;

      case "Switch":
      case "TryCatch":
      case "Synth":
        throw new UnsupportedConstruct(
          `interpreter: stmt '${s.type}' is not yet implemented`,
          s.span
        );

      default: {
        const _exhaustive: never = s;
        void _exhaustive;
        throw new Error(`interpreter: unhandled stmt`);
      }
    }
  }

  private assignLValue(
    lv: LValue,
    v: RuntimeValue,
    suppressed: boolean
  ): void {
    if (lv.type === "Var") {
      this.env.set(lv.name, v);
      if (!suppressed) this.autoDisp(lv.name, v);
      return;
    }
    if (lv.type === "Ignore") return;
    throw new UnsupportedConstruct(
      `interpreter: lvalue '${lv.type}' is not yet implemented`
    );
  }

  private expandForRange(e: Expr): RuntimeValue[] {
    if (e.type === "Range") {
      const start = toScalarNumber(this.evalExpr(e.start));
      const end = toScalarNumber(this.evalExpr(e.end));
      const step = e.step ? toScalarNumber(this.evalExpr(e.step)) : 1;
      const out: RuntimeValue[] = [];
      if (step === 0) return out;
      // Tiny ulp slack matches numbl's range generation so 1:0.1:1 hits
      // exactly the same iteration count as numbl's interpreter.
      const EPS = 1e-12;
      if (step > 0) {
        for (let i = start; i <= end + EPS; i += step) out.push(i);
      } else {
        for (let i = start; i >= end - EPS; i += step) out.push(i);
      }
      return out;
    }
    throw new UnsupportedConstruct(
      `interpreter: for-driver of type '${e.type}' is not yet implemented`,
      e.span
    );
  }

  // ── Expressions ────────────────────────────────────────────────────────

  private evalExpr(e: Expr): RuntimeValue {
    switch (e.type) {
      case "Number":
        return Number(e.value);
      case "String": {
        // Parser keeps the surrounding `"…"` quotes in `value`; strip
        // them so the runtime value carries just the inner string.
        const raw = e.value;
        return raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
          ? raw.slice(1, -1)
          : raw;
      }
      case "Char": {
        // Parser keeps the surrounding `'…'` quotes in `value`; strip
        // them so the runtime value (and `Char.exact` after
        // `inferTypeFromValue`) carry just the inner string.
        const raw = e.value;
        const inner =
          raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")
            ? raw.slice(1, -1)
            : raw;
        return makeChar(inner);
      }
      case "ImagUnit":
        throw new UnsupportedConstruct(
          `interpreter: imaginary literals are not yet implemented`,
          e.span
        );
      case "Ident": {
        const v = this.env.get(e.name);
        if (v !== undefined) return v;
        // Bare-ident call into a 0-arg builtin (`pi`, `eps`, `tic`, …)
        // or a 0-arg user function.
        const out = this.callByName(e.name, [], 1, e.span);
        return out[0];
      }
      case "Binary": {
        const left = this.evalExpr(e.left);
        const right = this.evalExpr(e.right);
        // `&&` / `||` short-circuit — handled before generic dispatch
        // so the right operand doesn't evaluate when the left already
        // decides. (MATLAB semantics: scalar operands only, but the
        // interpreter doesn't enforce that here — the type check would
        // belong in `andand`/`oror`'s transfer, which only fires in
        // the lowering / codegen paths.)
        if (e.op === BinaryOperation.AndAnd) {
          return isTruthy(left) && isTruthy(right) ? 1 : 0;
        }
        if (e.op === BinaryOperation.OrOr) {
          return isTruthy(left) || isTruthy(right) ? 1 : 0;
        }
        const name = BINOP_BUILTIN[e.op];
        if (!name) {
          throw new UnsupportedConstruct(
            `interpreter: binary op '${e.op}' is not yet implemented`,
            e.span
          );
        }
        return this.callByName(name, [left, right], 1, e.span)[0];
      }
      case "Unary": {
        const a = this.evalExpr(e.operand);
        if (e.op === UnaryOperation.Plus) return a;
        const name = UNOP_BUILTIN[e.op];
        if (!name) {
          throw new UnsupportedConstruct(
            `interpreter: unary op '${e.op}' is not yet implemented`,
            e.span
          );
        }
        return this.callByName(name, [a], 1, e.span)[0];
      }
      case "FuncCall": {
        const argVals = e.args.map(a => this.evalExpr(a));
        return this.callByName(e.name, argVals, 1, e.span)[0];
      }
      case "Range": {
        // Range-as-value (not for-driver) → build a 1×N row tensor
        // via the shared runtime snippet so cross-runner output
        // matches numbl / c-aot byte-for-byte.
        const start = toScalarNumber(this.evalExpr(e.start));
        const end = toScalarNumber(this.evalExpr(e.end));
        const step = e.step ? toScalarNumber(this.evalExpr(e.step)) : 1;
        return jsMakeRange(start, step, end) as unknown as RuntimeValue;
      }

      case "Tensor": {
        // `[a b c]` (single row) → 1×N tensor; `[a b; c d]` → R×C.
        // MVP: every cell must evaluate to a scalar number (not a
        // tensor — the bracket-concat case with tensor cells goes
        // through TensorConcat on the C side and isn't wired here
        // yet). 1×1 brackets `[x]` collapse to the inner scalar
        // (matches MATLAB / mtoc2's lowerer).
        const rows = e.rows;
        if (rows.length === 0 || (rows.length === 1 && rows[0].length === 0)) {
          return makeTensor([0, 0], new Float64Array(0));
        }
        const nRows = rows.length;
        const nCols = rows[0].length;
        if (nRows === 1 && nCols === 1) {
          return this.evalExpr(rows[0][0]);
        }
        for (const row of rows) {
          if (row.length !== nCols) {
            throw new UnsupportedConstruct(
              `interpreter: tensor literal rows have inconsistent lengths`,
              e.span
            );
          }
        }
        const data = new Float64Array(nRows * nCols);
        for (let c = 0; c < nCols; c++) {
          for (let r = 0; r < nRows; r++) {
            const v = this.evalExpr(rows[r][c]);
            if (typeof v !== "number") {
              throw new UnsupportedConstruct(
                `interpreter: tensor literal cells must currently be scalar numbers (got ${typeof v}); ` +
                  `tensor-cell concat is not yet wired`,
                e.span
              );
            }
            data[r + c * nRows] = v;
          }
        }
        return makeTensor([nRows, nCols], data);
      }

      case "Index":
      case "IndexCell":
      case "Member":
      case "MemberDynamic":
      case "MethodCall":
      case "SuperMethodCall":
      case "AnonFunc":
      case "FuncHandle":
      case "Cell":
      case "ClassInstantiation":
      case "EndKeyword":
      case "Colon":
      case "MetaClass":
        throw new UnsupportedConstruct(
          `interpreter: expression '${e.type}' is not yet implemented`,
          e.span
        );

      default: {
        const _exhaustive: never = e;
        void _exhaustive;
        throw new Error(`interpreter: unhandled expr`);
      }
    }
  }

  // ── Dispatch ───────────────────────────────────────────────────────────

  /** Resolve `name` against (in order): the global builtin registry,
   *  workspace-loaded `.mtoc2.js` user functions, and the workspace
   *  function index (via numbl's `resolveFunction`). Returns one
   *  value per `nargout`. */
  private callByName(
    name: string,
    args: RuntimeValue[],
    nargout: number,
    span: Span
  ): RuntimeValue[] {
    const argTypes = args.map(inferTypeFromValue);

    // Global builtin registry first.
    const b = getBuiltin(name);
    if (b !== undefined) {
      return this.invokeBuiltin(b, args, argTypes, nargout, name);
    }

    // Workspace dispatch — `.mtoc2.js` user functions, workspace
    // functions, class methods, etc. Without a workspace we can only
    // reach builtins (vitest unit-tests that hand-build a tiny env).
    if (this.workspace !== undefined) {
      const target = this.workspace.resolve(
        name,
        argTypes,
        { file: this.currentFile },
        span
      );
      if (target !== null) {
        switch (target.kind) {
          case "builtin": {
            const fb = getBuiltin(target.name);
            if (!fb) {
              throw new UnsupportedConstruct(
                `interpreter: workspace resolved '${name}' to builtin ` +
                  `'${target.name}' but no such builtin is registered`,
                span
              );
            }
            return this.invokeBuiltin(fb, args, argTypes, nargout, name);
          }
          case "userFunction":
            return this.callUserFunction(target.ast, args, nargout, span);
          case "mtoc2UserFunction": {
            const ub = this.workspace.getUserBuiltin(target.name);
            if (!ub) {
              throw new UnsupportedConstruct(
                `interpreter: workspace claimed '${name}' is a .mtoc2.js ` +
                  `user function but no Builtin is registered`,
                span
              );
            }
            return this.invokeBuiltin(ub, args, argTypes, nargout, name);
          }
          case "classConstructor":
          case "classMethod":
            throw new UnsupportedConstruct(
              `interpreter: class constructors / methods are not yet ` +
                `implemented (resolved '${name}' → ${target.kind})`,
              span
            );
        }
      }
    }

    throw new UnsupportedConstruct(
      `interpreter: undefined identifier or function '${name}'`,
      span
    );
  }

  private invokeBuiltin(
    b: Builtin,
    args: RuntimeValue[],
    argTypes: import("../lowering/types.js").Type[],
    nargout: number,
    sourceName: string
  ): RuntimeValue[] {
    if (!b.call) {
      throw new UnsupportedConstruct(
        `builtin '${sourceName}' has no interpreter implementation (call hook); ` +
          `try '--exec c-aot' or wait for Phase 5 retrofit`
      );
    }
    // Run transfer for validation (same path codegen uses); ignore the
    // returned types — `call` produces values directly.
    b.transfer(argTypes, nargout);
    return b.call({ args, argTypes, nargout, ctx: this.ctx });
  }

  /** Execute a user-function body in a fresh `Environment`, binding
   *  parameters and returning the declared outputs. */
  private callUserFunction(
    fn: Extract<Stmt, { type: "Function" }>,
    args: RuntimeValue[],
    nargout: number,
    span: Span
  ): RuntimeValue[] {
    if (this.active.has(fn.name)) {
      throw new UnsupportedConstruct(
        `interpreter: recursion is not yet implemented ('${fn.name}')`,
        span
      );
    }
    if (args.length > fn.params.length) {
      throw new UnsupportedConstruct(
        `'${fn.name}': too many arguments (${args.length} > ${fn.params.length})`,
        span
      );
    }
    if (nargout > fn.outputs.length) {
      throw new UnsupportedConstruct(
        `'${fn.name}': too many outputs (${nargout} > ${fn.outputs.length})`,
        span
      );
    }
    const child = new Environment();
    for (let i = 0; i < args.length; i++) {
      child.set(fn.params[i], args[i]);
    }
    const inner = new Interpreter(this.ctx, {
      env: child,
      ...(this.workspace !== undefined ? { workspace: this.workspace } : {}),
      currentFile: this.currentFile,
    });
    this.active.add(fn.name);
    try {
      inner.runProgram(fn.body);
    } finally {
      this.active.delete(fn.name);
    }
    const out: RuntimeValue[] = [];
    for (let i = 0; i < Math.max(nargout, 1); i++) {
      const name = fn.outputs[i];
      const v = child.get(name);
      if (v === undefined) {
        throw new UnsupportedConstruct(
          `'${fn.name}': output '${name}' was never assigned`,
          span
        );
      }
      out.push(v);
    }
    return out;
  }

  // ── Display helpers ────────────────────────────────────────────────────

  private autoDisp(name: string, v: RuntimeValue): void {
    // numbl-style: `<name> =\n<value>`. The value half routes through
    // the same snippet functions the codegen path uses, so output
    // stays bit-identical across modes (once the matching `.js`
    // snippets are populated in Phase 5).
    this.ctx.helpers.write(`${name} =\n`);
    if (typeof v === "number") mtoc2_disp_double(v);
    else if (typeof v === "boolean") mtoc2_disp_double(v ? 1 : 0);
    else if (typeof v === "string") this.ctx.helpers.write(v + "\n");
    else if (isCharRV(v)) this.ctx.helpers.write(v.value + "\n");
    else if (isTensor(v)) {
      // Placeholder until tensor formatting lands as a paired snippet.
      this.ctx.helpers.write(`  [${v.shape.join("x")} tensor]\n`);
    } else {
      this.ctx.helpers.write(String(v) + "\n");
    }
  }
}

// Re-export so callers (CLI, browser preview) can format scalar values
// without routing through the interpreter.
export { mtoc2_format_double };

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
import { getBuiltin } from "../builtins/index.js";
import type { Builtin } from "../builtins/registry.js";
import { inferTypeFromValue } from "../runtime/inferType.js";
import { Workspace } from "../workspace/workspace.js";
import { UnsupportedConstruct } from "../lowering/errors.js";
import {
  mtoc2_disp_double,
  mtoc2_format_double,
  mtoc2_tensor_make_range as jsMakeRange,
  mtoc2_toc_print,
  mtoc2_toc_handle_print,
} from "../builtins/runtime/snippets.gen.js";

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
  /** Active index slot stack — pushed on entering an index slot
   *  (FuncCall args / Index expression / AssignLValue indices) so a
   *  nested `end` keyword inside an expression like `v(end-1)`
   *  resolves to the size of the axis being indexed. Top of stack
   *  is the innermost slot. */
  private readonly endStack: Array<{
    baseTensor: { shape: ReadonlyArray<number>; data: ArrayLike<number> };
    axis: number | "linear";
  }> = [];

  /** Helper: resolve the current `end` keyword against the top of
   *  `endStack`. Throws if there's no active slot (the parser should
   *  have caught this, but the interpreter walks the raw AST). */
  private resolveEnd(): number {
    if (this.endStack.length === 0) {
      throw new UnsupportedConstruct(
        `interpreter: 'end' used outside an index slot`
      );
    }
    const top = this.endStack[this.endStack.length - 1];
    if (top.axis === "linear") return top.baseTensor.data.length;
    return top.baseTensor.shape[top.axis] ?? 1;
  }

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
        // Bare `toc;` / `toc();` / `toc(t0);` is the printing form,
        // matching numbl's `nargout === 0` discriminator. Mirrors
        // `lowerExprStmt`'s special case in the c-aot path: the shadow
        // checks ensure a user-level `toc = 5; toc;` reads the local
        // rather than dispatching to the print form. We import the
        // runtime helpers lazily to avoid a circular dep at module top.
        if (
          this.env.get("toc") === undefined &&
          !(this.workspace && this.workspace.isClass("toc"))
        ) {
          if (s.expr.type === "Ident" && s.expr.name === "toc") {
            mtoc2_toc_print();
            return;
          }
          if (s.expr.type === "FuncCall" && s.expr.name === "toc") {
            if (s.expr.args.length === 0) {
              mtoc2_toc_print();
              return;
            }
            if (s.expr.args.length === 1) {
              const t0 = toScalarNumber(this.evalExpr(s.expr.args[0]));
              mtoc2_toc_handle_print(t0);
              return;
            }
          }
        }
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
    if (lv.type === "Index") {
      // Scalar tensor write MVP: `v(i) = x` / `M(i,j) = x`. The base
      // must be a bare Var holding a tensor; the RHS must be a scalar
      // number. Range / colon / multi-element RHS land separately.
      if (lv.base.type !== "Ident") {
        throw new UnsupportedConstruct(
          `interpreter: indexed assignment requires a bare-variable base ` +
            `(got '${lv.base.type}')`
        );
      }
      const baseName = lv.base.name;
      const baseVal = this.env.get(baseName);
      if (baseVal === undefined || !isTensor(baseVal)) {
        throw new UnsupportedConstruct(
          `interpreter: indexed assignment requires '${baseName}' to be ` +
            `an already-bound tensor`
        );
      }
      if (typeof v !== "number") {
        throw new UnsupportedConstruct(
          `interpreter: indexed assignment requires a scalar RHS (got ${typeof v})`
        );
      }
      // `end` inside the index list resolves to the size of the axis
      // being indexed (or `numel` for linear single-slot).
      const ndim = lv.indices.length;
      const idxVals = lv.indices.map((ix, i) => {
        this.endStack.push({
          baseTensor: baseVal,
          axis: ndim === 1 ? "linear" : i,
        });
        try {
          return this.evalExpr(ix);
        } finally {
          this.endStack.pop();
        }
      });
      for (const iv of idxVals) {
        if (typeof iv !== "number") {
          throw new UnsupportedConstruct(
            `interpreter: indexed assignment supports scalar numeric indices only`
          );
        }
      }
      const ks = idxVals.map(iv => Math.trunc(iv as number));
      let offset: number;
      if (ks.length === 1) {
        if (ks[0] < 1 || ks[0] > baseVal.data.length) {
          throw new RangeError(
            `Index in position 1 (${ks[0]}) exceeds array bounds (${baseVal.data.length})`
          );
        }
        offset = ks[0] - 1;
      } else {
        offset = 0;
        let stride = 1;
        for (let i = 0; i < ks.length; i++) {
          const dim = baseVal.shape[i] ?? 1;
          if (ks[i] < 1 || ks[i] > dim) {
            throw new RangeError(
              `Index in position ${i + 1} (${ks[i]}) exceeds array bounds (${dim})`
            );
          }
          offset += (ks[i] - 1) * stride;
          stride *= dim;
        }
      }
      baseVal.data[offset] = v;
      if (!suppressed) this.autoDisp(baseName, baseVal);
      return;
    }
    if (lv.type === "Member") {
      // `s.f = rhs` / `s.a.b = rhs` — walk to the parent of the leaf,
      // then write the field. Bare-Ident bases bind the result back
      // into the env so `s` reflects the mutation; nested bases
      // mutate in-place via the parent reference.
      const path = this.collectMemberPath(lv);
      if (path === null) {
        throw new UnsupportedConstruct(
          `interpreter: only bare-Ident-rooted member assignment is supported`
        );
      }
      const { rootName, fields } = path;
      // Use `cloneStruct` so non-enumerable tags (e.g. `mtoc2Class`
      // on class instances) survive the deep-clone — without that,
      // a constructor's `obj.x = a` would silently strip the class
      // tag and method dispatch later would fail.
      let host = this.env.get(rootName) as Record<string, RuntimeValue> | undefined;
      if (host === undefined || typeof host !== "object" || host === null) {
        host = {};
      } else {
        host = Interpreter.cloneStructLocal(host);
      }
      // Walk to the parent of the leaf, cloning along the way so
      // older references aren't mutated.
      let cur: Record<string, RuntimeValue> = host;
      for (let i = 0; i < fields.length - 1; i++) {
        const fname = fields[i];
        const next = cur[fname];
        const cloned: Record<string, RuntimeValue> =
          next && typeof next === "object" && !isTensor(next) && !isCharRV(next)
            ? Interpreter.cloneStructLocal(next as Record<string, RuntimeValue>)
            : {};
        cur[fname] = cloned as RuntimeValue;
        cur = cloned;
      }
      cur[fields[fields.length - 1]] = v;
      this.env.set(rootName, host as RuntimeValue);
      if (!suppressed) this.autoDisp(rootName, host as RuntimeValue);
      return;
    }
    throw new UnsupportedConstruct(
      `interpreter: lvalue '${lv.type}' is not yet implemented`
    );
  }

  /** Walk a chain of `Member` lvalues down to a bare `Ident` root.
   *  Returns the root variable name and the field path; returns null
   *  if the chain ends at something other than a bare ident (e.g. a
   *  function call or member-dynamic). */
  private collectMemberPath(
    lv: LValue
  ): { rootName: string; fields: string[] } | null {
    const fields: string[] = [];
    let cur: unknown = lv;
    while (cur && typeof cur === "object" && (cur as LValue).type === "Member") {
      const m = cur as Extract<LValue, { type: "Member" }>;
      fields.unshift(m.name);
      cur = m.base;
    }
    if (
      cur &&
      typeof cur === "object" &&
      (cur as Expr).type === "Ident"
    ) {
      const id = cur as Extract<Expr, { type: "Ident" }>;
      return { rootName: id.name, fields };
    }
    return null;
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
        // MATLAB parses `v(args)` the same whether `v` is a function
        // or a tensor variable being indexed. The lowering layer
        // disambiguates by checking the env first; mirror that here.
        const envVal = this.env.get(e.name);
        if (envVal !== undefined && isTensor(envVal)) {
          return this.indexTensor(envVal, e.args, e.span);
        }
        const argVals = e.args.map(a => this.evalExpr(a));
        return this.callByName(e.name, argVals, 1, e.span)[0];
      }
      case "Range": {
        // Range-as-value (not for-driver) → build a 1×N row tensor
        // via the shared runtime snippet so cross-runner output
        // matches numbl / c-aot byte-for-byte. Length-1 collapse
        // mirrors `lowerRangeAsValue` in the c-aot path: a
        // single-element range is the scalar `start` so downstream
        // arithmetic (`(3:3) * 4`) and disp formatting agree.
        const start = toScalarNumber(this.evalExpr(e.start));
        const end = toScalarNumber(this.evalExpr(e.end));
        const step = e.step ? toScalarNumber(this.evalExpr(e.step)) : 1;
        const t = jsMakeRange(start, step, end) as unknown as Extract<
          RuntimeValue,
          { mtoc2Tag: "tensor" }
        >;
        if (t.data.length === 1) return t.data[0];
        return t;
      }

      case "Tensor": {
        // `[a b c]` (single row) → 1×N tensor; `[a b; c d]` → R×C.
        // Cells may be scalar numbers, scalar tensors, multi-element
        // tensors of compatible shape, or empty `[]` (filtered per
        // numbl's `catAlongDim` rule). 1×1 brackets `[x]` collapse to
        // the inner value (matches MATLAB).
        const srcRows = e.rows;
        if (
          srcRows.length === 0 ||
          (srcRows.length === 1 && srcRows[0].length === 0)
        ) {
          return makeTensor([0, 0], new Float64Array(0));
        }
        if (srcRows.length === 1 && srcRows[0].length === 1) {
          return this.evalExpr(srcRows[0][0]);
        }

        interface EvalCell {
          v: RuntimeValue;
          rows: number;
          cols: number;
          isScalar: boolean;
        }
        const keptRows: EvalCell[][] = [];
        for (const row of srcRows) {
          const erow: EvalCell[] = [];
          for (const cellExpr of row) {
            const v = this.evalExpr(cellExpr);
            if (typeof v === "number") {
              erow.push({ v, rows: 1, cols: 1, isScalar: true });
            } else if (isTensor(v)) {
              if (v.data.length === 0) continue;
              const r = v.shape[0] ?? 1;
              const c = v.shape[1] ?? 1;
              erow.push({ v, rows: r, cols: c, isScalar: false });
            } else {
              throw new UnsupportedConstruct(
                `interpreter: tensor literal cells must be scalar numbers ` +
                  `or real tensors (got ${typeof v})`,
                e.span
              );
            }
          }
          if (erow.length > 0) keptRows.push(erow);
        }
        if (keptRows.length === 0) {
          return makeTensor([0, 0], new Float64Array(0));
        }

        const rowHeights: number[] = [];
        for (const row of keptRows) {
          const h = row[0].rows;
          for (const c of row) {
            if (c.rows !== h) {
              throw new Error(
                `Dimensions of arrays being concatenated are not consistent.`
              );
            }
          }
          rowHeights.push(h);
        }
        const totalCols = keptRows[0].reduce((s, c) => s + c.cols, 0);
        for (const row of keptRows) {
          const w = row.reduce((s, c) => s + c.cols, 0);
          if (w !== totalCols) {
            throw new Error(
              `Dimensions of arrays being concatenated are not consistent.`
            );
          }
        }
        const totalRows = rowHeights.reduce((s, h) => s + h, 0);

        const data = new Float64Array(totalRows * totalCols);
        let rowOff = 0;
        for (let i = 0; i < keptRows.length; i++) {
          const row = keptRows[i];
          const cellRows = rowHeights[i];
          let colOff = 0;
          for (const cell of row) {
            if (cell.isScalar) {
              data[rowOff + colOff * totalRows] = cell.v as number;
              colOff += 1;
            } else {
              const t = cell.v as Extract<RuntimeValue, { mtoc2Tag: "tensor" }>;
              for (let sc = 0; sc < cell.cols; sc++) {
                for (let sr = 0; sr < cell.rows; sr++) {
                  data[rowOff + sr + (colOff + sc) * totalRows] =
                    t.data[sr + sc * cell.rows];
                }
              }
              colOff += cell.cols;
            }
          }
          rowOff += cellRows;
        }
        return makeTensor([totalRows, totalCols], data);
      }

      case "Index": {
        // Both `v(args)` and `expr(args)` route through `indexTensor`
        // — which handles scalar / colon / range / index-vector
        // slots uniformly.
        const baseVal = this.evalExpr(e.base);
        if (!isTensor(baseVal)) {
          throw new UnsupportedConstruct(
            `interpreter: indexing into a non-tensor value is not yet wired`,
            e.span
          );
        }
        return this.indexTensor(baseVal, e.indices, e.span);
      }

      case "EndKeyword":
        return this.resolveEnd();

      case "Member": {
        // `s.f` — struct / class field read. Walks the runtime
        // object via the field name. Errors out for non-object
        // bases.
        const base = this.evalExpr(e.base);
        if (
          typeof base !== "object" ||
          base === null ||
          isTensor(base) ||
          isCharRV(base)
        ) {
          throw new UnsupportedConstruct(
            `interpreter: '.${e.name}' applied to non-struct value`,
            e.span
          );
        }
        const o = base as Record<string, RuntimeValue>;
        if (!(e.name in o)) {
          throw new UnsupportedConstruct(
            `interpreter: struct has no field '${e.name}'`,
            e.span
          );
        }
        return o[e.name];
      }

      case "MethodCall": {
        // `obj.method(args)` — three resolution kinds:
        //   1. Package function: dotted name (e.g. `pkg.fn(args)`).
        //   2. Instance method on a class receiver.
        //   3. Member-rooted index: `obj.field(args)` where
        //      `obj.field` is a tensor and the `(args)` are indices.
        // Try to extract a dotted name like `pkg.fn` / `pkg.sub.fn`.
        const dotted = this.tryExtractDottedName(e.base);
        if (dotted !== null && this.env.get(dotted.split(".")[0]) === undefined) {
          const argVals = e.args.map(a => this.evalExpr(a));
          const qualified = `${dotted}.${e.name}`;
          return this.callByName(qualified, argVals, 1, e.span)[0];
        }
        const base = this.evalExpr(e.base);
        if (
          typeof base === "object" &&
          base !== null &&
          !isTensor(base) &&
          !isCharRV(base)
        ) {
          const tag = (base as { mtoc2Class?: string }).mtoc2Class;
          if (tag !== undefined && this.workspace !== undefined) {
            const reg = this.workspace.classes.get(tag);
            const fn = reg?.methods.get(e.name);
            if (reg !== undefined && fn !== undefined) {
              const argVals = e.args.map(a => this.evalExpr(a));
              return this.callUserFunction(fn, [base, ...argVals], 1, e.span)[0];
            }
          }
          // Struct / class field that's a tensor: treat as a
          // member-rooted index read (`obj.data(i)`). Read the field
          // into a temp and route through the tensor-indexing path
          // by synthesizing the equivalent FuncCall semantics.
          const obj = base as Record<string, RuntimeValue>;
          if (e.name in obj) {
            const fieldVal = obj[e.name];
            if (isTensor(fieldVal)) {
              return this.indexTensor(fieldVal, e.args, e.span);
            }
          }
        }
        throw new UnsupportedConstruct(
          `interpreter: MethodCall '${e.name}' could not be dispatched`,
          e.span
        );
      }

      case "IndexCell":
      case "MemberDynamic":
      case "SuperMethodCall":
      case "AnonFunc":
      case "FuncHandle":
      case "Cell":
      case "ClassInstantiation":
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
    // `struct(name, value, name, value, ...)` is special-cased in the
    // c-aot path's lowerFuncCall — it doesn't go through the builtin
    // registry. Match that here so the interpreter sees the same
    // dialect: a plain object with the named fields. Field-name args
    // must be Char or String; values pass through unchanged.
    if (name === "struct") {
      if (args.length % 2 !== 0) {
        throw new UnsupportedConstruct(
          `'struct' expects an even number of args (name, value, name, value, ...)`,
          span
        );
      }
      const out: Record<string, RuntimeValue> = {};
      for (let i = 0; i < args.length; i += 2) {
        const k = args[i];
        let fname: string;
        if (typeof k === "string") fname = k;
        else if (isCharRV(k)) fname = k.value;
        else {
          throw new UnsupportedConstruct(
            `'struct' field name (arg ${i + 1}) must be a string or char literal`,
            span
          );
        }
        out[fname] = args[i + 1];
      }
      return [out as unknown as RuntimeValue];
    }
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
          case "classConstructor": {
            const reg = this.workspace.classes.get(target.className);
            if (reg === undefined) {
              throw new UnsupportedConstruct(
                `interpreter: workspace resolved '${name}' as a class but ` +
                  `no registration found for '${target.className}'`,
                span
              );
            }
            return this.constructClassInstance(reg, args, span);
          }
          case "classMethod": {
            const reg = this.workspace.classes.get(target.className);
            if (reg === undefined) {
              throw new UnsupportedConstruct(
                `interpreter: workspace resolved '${name}' as a class method ` +
                  `but no registration found for '${target.className}'`,
                span
              );
            }
            // Static methods are called as `ClassName.method(args)`
            // and don't have a receiver to thread; instance methods
            // receive the receiver as their first parameter.
            const fn =
              reg.staticMethods.get(target.methodName) ??
              reg.methods.get(target.methodName);
            if (fn === undefined) {
              throw new UnsupportedConstruct(
                `interpreter: class '${target.className}' has no method ` +
                  `'${target.methodName}'`,
                span
              );
            }
            // `stripInstance: true` → caller already excluded the
            // receiver from `args`. `false` → receiver is implicit
            // first arg already in `args[0]`.
            return this.callUserFunction(fn, args, nargout, span);
          }
        }
      }
    }

    throw new UnsupportedConstruct(
      `interpreter: undefined identifier or function '${name}'`,
      span
    );
  }

  /** Tensor indexing — supports scalar reads, single-slot Colon
   *  (linearize to N×1), single-slot Range, multi-slot per-axis
   *  with Colon / Scalar / Range / IndexVec mixes. Used by both
   *  the `v(args)` FuncCall path (bare-name tensor variable) and
   *  the `obj.field(args)` MethodCall path (member-rooted index). */
  private indexTensor(
    base: import("../runtime/value.js").RuntimeTensor,
    rawArgs: ReadonlyArray<Expr>,
    span: Span
  ): RuntimeValue {
    // `v(:)` short-circuit — column-major linearize.
    if (rawArgs.length === 1 && rawArgs[0].type === "Colon") {
      const n = base.data.length;
      return makeTensor([n, 1], new Float64Array(base.data));
    }
    // Per-axis resolution: each slot becomes (count, indexFn) where
    // indexFn(k) returns the 1-based source index along that axis.
    const ndim = rawArgs.length;
    type Slot = { count: number; idxFn: (k: number) => number };
    const slots: Slot[] = [];
    let allScalar = true;
    for (let i = 0; i < ndim; i++) {
      const a = rawArgs[i];
      this.endStack.push({
        baseTensor: base,
        axis: ndim === 1 ? "linear" : i,
      });
      let slot: Slot;
      try {
        if (a.type === "Colon") {
          const axisLen = ndim === 1 ? base.data.length : base.shape[i] ?? 1;
          slot = { count: axisLen, idxFn: k => k + 1 };
          allScalar = false;
        } else if (a.type === "Range") {
          const s = toScalarNumber(this.evalExpr(a.start));
          const en = toScalarNumber(this.evalExpr(a.end));
          const st = a.step ? toScalarNumber(this.evalExpr(a.step)) : 1;
          // Use the same loop_count formula as the c-aot path.
          let n = 0;
          if (st !== 0) {
            const calc = Math.floor((en - s) / st + 1 + 1e-10);
            n = calc > 0 && Number.isFinite(calc) ? calc : 0;
          }
          slot = { count: n, idxFn: k => Math.trunc(s + st * k) };
          allScalar = false;
        } else {
          const v = this.evalExpr(a);
          if (typeof v === "number") {
            const iv = Math.trunc(v);
            slot = { count: 1, idxFn: () => iv };
          } else if (isTensor(v)) {
            const data = v.data;
            slot = { count: data.length, idxFn: k => Math.trunc(data[k]) };
            allScalar = false;
          } else {
            throw new UnsupportedConstruct(
              `interpreter: index slot must be numeric (got ${typeof v})`,
              span
            );
          }
        }
      } finally {
        this.endStack.pop();
      }
      slots.push(slot);
    }

    // All-scalar fast path: classic scalar element read.
    if (allScalar) {
      const ks = slots.map(s => s.idxFn(0));
      let offset: number;
      if (ks.length === 1) {
        if (ks[0] < 1 || ks[0] > base.data.length) {
          throw new RangeError(
            `Index in position 1 (${ks[0]}) exceeds array bounds (${base.data.length})`
          );
        }
        offset = ks[0] - 1;
      } else {
        offset = 0;
        let stride = 1;
        for (let i = 0; i < ks.length; i++) {
          const dim = base.shape[i] ?? 1;
          if (ks[i] < 1 || ks[i] > dim) {
            throw new RangeError(
              `Index in position ${i + 1} (${ks[i]}) exceeds array bounds (${dim})`
            );
          }
          offset += (ks[i] - 1) * stride;
          stride *= dim;
        }
      }
      return base.data[offset];
    }

    // Multi-element slice — walk the cartesian product and build a
    // freshly-owned tensor. For the linear single-slot form, the
    // result orientation matches MATLAB: row base → row, col base →
    // col, else column vector.
    if (slots.length === 1) {
      const n = slots[0].count;
      const isRowBase = base.shape.length >= 2 && base.shape[0] === 1;
      const out = new Float64Array(n);
      for (let k = 0; k < n; k++) {
        const ix = slots[0].idxFn(k);
        if (ix < 1 || ix > base.data.length) {
          throw new RangeError(
            `Index in position 1 (${ix}) exceeds array bounds (${base.data.length})`
          );
        }
        out[k] = base.data[ix - 1];
      }
      const shape = isRowBase ? [1, n] : [n, 1];
      return makeTensor(shape, out);
    }

    // Multi-slot per-axis.
    const dims = slots.map(s => s.count);
    let total = 1;
    for (const d of dims) total *= d;
    const out = new Float64Array(total);
    const idx = new Array(slots.length).fill(0);
    for (let k = 0; k < total; k++) {
      // Source linear offset (column-major) using actual indices.
      let srcOff = 0;
      let baseStride = 1;
      for (let i = 0; i < slots.length; i++) {
        const ix = slots[i].idxFn(idx[i]);
        const dim = base.shape[i] ?? 1;
        if (ix < 1 || ix > dim) {
          throw new RangeError(
            `Index in position ${i + 1} (${ix}) exceeds array bounds (${dim})`
          );
        }
        srcOff += (ix - 1) * baseStride;
        baseStride *= dim;
      }
      // Destination offset (column-major in result dims).
      let dstOff = 0;
      let dstStride = 1;
      for (let i = 0; i < slots.length; i++) {
        dstOff += idx[i] * dstStride;
        dstStride *= dims[i];
      }
      out[dstOff] = base.data[srcOff];
      // Advance idx (column-major).
      for (let i = 0; i < slots.length; i++) {
        idx[i]++;
        if (idx[i] < dims[i]) break;
        idx[i] = 0;
      }
    }
    // Trim trailing exact-1 axes down to a rank-2 floor (matches the
    // c-aot path's result shape canonicalization).
    while (dims.length > 2 && dims[dims.length - 1] === 1) dims.pop();
    while (dims.length < 2) dims.push(1);
    return makeTensor(dims, out);
  }

  /** Shallow-copy a struct-shaped object, preserving non-enumerable
   *  tags like `mtoc2Class`. The naive `{...host}` spread only copies
   *  enumerable own properties, so it silently drops the class tag —
   *  which breaks downstream method dispatch on instance receivers. */
  private static cloneStructLocal(
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

  /** Try to extract a dotted identifier chain like `pkg.sub.foo` from
   *  a Member-rooted expression, returning the dotted string. Returns
   *  null if the chain bottoms out at something other than an Ident. */
  private tryExtractDottedName(e: Expr): string | null {
    const parts: string[] = [];
    let cur: Expr = e;
    while (cur.type === "Member") {
      parts.unshift(cur.name);
      cur = cur.base;
    }
    if (cur.type !== "Ident") return null;
    parts.unshift(cur.name);
    return parts.join(".");
  }

  /** Build a class instance: initialize properties to defaults, run
   *  the constructor body (if any) on that initial receiver, and
   *  return the resulting object. Mirrors numbl's classdef semantics:
   *  the constructor's `obj` parameter is bound to the default-valued
   *  receiver, and the constructor body writes through `obj.<prop>`
   *  to mutate properties before returning `obj`. */
  private constructClassInstance(
    reg: import("../lowering/classDefs.js").ClassRegistration,
    args: RuntimeValue[],
    span: Span
  ): RuntimeValue[] {
    const initial: Record<string, RuntimeValue> = {};
    // Tag the instance with its class name so MethodCall dispatch
    // can look up the right method registration at the call site.
    // The tag is non-enumerable so it doesn't show up in disp /
    // Object.keys, keeping struct-shaped behavior elsewhere.
    Object.defineProperty(initial, "mtoc2Class", {
      value: reg.className,
      enumerable: false,
      writable: false,
    });
    for (const name of reg.propertyNames) {
      const def = reg.defaults.get(name);
      if (def !== undefined) {
        initial[name] = this.evalExpr(def.expr);
      } else {
        // No default — leave the slot unset; the constructor must
        // assign before the first read. Use `0` as a neutral
        // placeholder so a stray read doesn't blow up with
        // `undefined` (matches numbl's "empty struct field" feel).
        initial[name] = 0;
      }
    }
    if (reg.constructor === null) {
      if (args.length !== 0) {
        throw new UnsupportedConstruct(
          `'${reg.className}' has no constructor; the default form takes no args ` +
            `(got ${args.length})`,
          span
        );
      }
      return [initial as RuntimeValue];
    }
    // Bind the constructor's output param to `initial`, then run.
    const fn = reg.constructor;
    if (args.length > fn.params.length) {
      throw new UnsupportedConstruct(
        `'${fn.name}': too many arguments (${args.length} > ${fn.params.length})`,
        span
      );
    }
    const child = new Environment();
    for (let i = 0; i < args.length; i++) child.set(fn.params[i], args[i]);
    // The first output (typically `obj`) starts as the default-valued
    // receiver so the constructor body can write through it.
    if (fn.outputs.length > 0) {
      child.set(fn.outputs[0], initial as RuntimeValue);
    }
    child.set("nargin", args.length);
    child.set("nargout", 1);
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
    const outName = fn.outputs[0];
    const result = outName !== undefined ? child.get(outName) : undefined;
    if (result === undefined) {
      throw new UnsupportedConstruct(
        `'${fn.name}': constructor output '${outName}' was never assigned`,
        span
      );
    }
    return [result];
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
    // returned types — `call` produces values directly. Some builtins
    // (notably the shape constructors `zeros` / `ones`) raise on
    // negative-exact dim values, but the corresponding runtime case
    // in the c-aot path clamps to 0. Since the interpreter sees
    // runtime values typed with `exact` set (via inferTypeFromValue),
    // a runtime-derived negative dim falsely trips transfer's static
    // validator. The `call` hooks already handle the lenient runtime
    // path, so transfer failures here are swallowed when the call
    // would otherwise succeed.
    try {
      b.transfer(argTypes, nargout);
    } catch {
      // fall through to call(); it'll raise its own clearer error
      // if the inputs really are bad.
    }
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
    const child = new Environment();
    for (let i = 0; i < args.length; i++) {
      child.set(fn.params[i], args[i]);
    }
    // Bind the pseudo-variables `nargin` and `nargout` so the body
    // can read them. Matches the c-aot path, which folds them at
    // lowering time into compile-time constants (the lowerer reads
    // them off the specialization key). Here they're just locals.
    child.set("nargin", args.length);
    child.set("nargout", nargout);
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
    // Return the requested nargout, clamped to what the function
    // actually declares. A 0-output function called as an expression
    // (`f()` at the top level of an ExprStmt) gets nargout=1 from the
    // expression evaluator; we honor that by returning [] and letting
    // the caller see undefined for the missing slot — ExprStmt drops
    // undefined, so the bare-statement form works naturally.
    const effective = Math.min(nargout, fn.outputs.length);
    const out: RuntimeValue[] = [];
    for (let i = 0; i < effective; i++) {
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

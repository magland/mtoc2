/**
 * Statement execution + helpers: execBody, execStmt, assignLValue,
 * collectMemberPath, expandForRange, autoDisp. Attached to
 * `Interpreter.prototype` from `interpreter.ts`.
 *
 * Mirrors numbl's interpreterExec split — same role here, smaller
 * surface because mtoc2 walks a tighter AST subset.
 */

import type { Expr, Stmt, LValue } from "../parser/index.js";
import {
  isChar as isCharRV,
  isComplexValue,
  isTensor,
  isTruthy,
  toScalarNumber,
  type RuntimeValue,
} from "../runtime/value.js";
import { UnsupportedConstruct } from "../lowering/errors.js";
import { tryExtractDottedName } from "../parser/astUtils.js";
import {
  mtoc2_disp_complex,
  mtoc2_disp_double,
  mtoc2_disp_tensor,
  mtoc2_disp_tensor_complex,
  mtoc2_toc_print,
  mtoc2_toc_handle_print,
} from "../builtins/runtime/snippets.gen.js";
import {
  BreakSignal,
  ContinueSignal,
  Interpreter,
  ReturnSignal,
} from "./interpreter.js";

// ── Body / statement execution ────────────────────────────────────────────

export function execBody(this: Interpreter, body: Stmt[]): void {
  for (const stmt of body) {
    this.execStmt(stmt);
  }
}

export function execStmt(this: Interpreter, s: Stmt): void {
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
      // shape. Both come through callByName. MethodCall RHS routes
      // through the same dispatch: dotted package call (pkg.fn(args))
      // is the common case in `[a, b] = pkg.foo(x)`.
      let results: RuntimeValue[];
      const nargout = s.lvalues.length;
      if (s.expr.type === "FuncCall") {
        const argVals = s.expr.args.map(a => this.evalExpr(a));
        results = this.callByName(s.expr.name, argVals, nargout, s.span);
      } else if (s.expr.type === "MethodCall") {
        const me = s.expr;
        const dotted = tryExtractDottedName(me.base);
        if (
          dotted !== null &&
          this.env.get(dotted.split(".")[0]) === undefined
        ) {
          const argVals = me.args.map(a => this.evalExpr(a));
          results = this.callByName(
            `${dotted}.${me.name}`,
            argVals,
            nargout,
            s.span
          );
        } else {
          throw new UnsupportedConstruct(
            `interpreter: MultiAssign MethodCall RHS only supports ` +
              `dotted-package targets (got base type '${me.base.type}')`,
            s.span
          );
        }
      } else {
        throw new UnsupportedConstruct(
          `interpreter: MultiAssign supports FuncCall / package MethodCall RHS ` +
            `(got '${s.expr.type}')`,
          s.span
        );
      }
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
      // rather than dispatching to the print form.
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
    // through `callUserFunction`, not `execBody`. ClassDef / Global /
    // Persistent / Import / Directive are workspace-time declarations
    // that the interpreter doesn't enact at exec time.
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

// ── LValue assignment ─────────────────────────────────────────────────────

export function assignLValue(
  this: Interpreter,
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
    // into the env so `s` reflects the mutation; nested bases mutate
    // in-place via the parent reference.
    const path = this.collectMemberPath(lv);
    if (path === null) {
      throw new UnsupportedConstruct(
        `interpreter: only bare-Ident-rooted member assignment is supported`
      );
    }
    const { rootName, fields } = path;
    // `cloneStructLocal` preserves non-enumerable tags (e.g.
    // `mtoc2Class` on class instances) — a constructor's `obj.x = a`
    // would otherwise silently strip the class tag and break dispatch.
    let host = this.env.get(rootName) as
      | Record<string, RuntimeValue>
      | undefined;
    if (host === undefined || typeof host !== "object" || host === null) {
      host = {};
    } else {
      host = Interpreter.cloneStructLocal(host);
    }
    // Walk to the parent of the leaf, cloning along the way so older
    // references aren't mutated.
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
 *  Returns the root variable name and the field path; returns null if
 *  the chain ends at something other than a bare ident (e.g. a
 *  function call or member-dynamic). */
export function collectMemberPath(
  this: Interpreter,
  lv: LValue
): { rootName: string; fields: string[] } | null {
  void this;
  const fields: string[] = [];
  let cur: unknown = lv;
  while (cur && typeof cur === "object" && (cur as LValue).type === "Member") {
    const m = cur as Extract<LValue, { type: "Member" }>;
    fields.unshift(m.name);
    cur = m.base;
  }
  if (cur && typeof cur === "object" && (cur as Expr).type === "Ident") {
    const id = cur as Extract<Expr, { type: "Ident" }>;
    return { rootName: id.name, fields };
  }
  return null;
}

// ── For-range expansion ───────────────────────────────────────────────────

export function expandForRange(this: Interpreter, e: Expr): RuntimeValue[] {
  if (e.type === "Range") {
    const start = toScalarNumber(this.evalExpr(e.start));
    const end = toScalarNumber(this.evalExpr(e.end));
    const step = e.step ? toScalarNumber(this.evalExpr(e.step)) : 1;
    const out: RuntimeValue[] = [];
    if (step === 0) return out;
    // Tiny ulp slack matches numbl's range generation so `1:0.1:1`
    // hits exactly the same iteration count as numbl's interpreter.
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

// ── Auto-display helper ──────────────────────────────────────────────────

export function autoDisp(
  this: Interpreter,
  name: string,
  v: RuntimeValue
): void {
  // numbl-style: `<name> =\n<value>`. The value half routes through
  // the same snippet functions the codegen path uses, so output stays
  // bit-identical across modes (once the matching `.js` snippets are
  // populated).
  this.ctx.helpers.write(`${name} =\n`);
  globalThis.$write = this.ctx.helpers.write;
  if (typeof v === "number") mtoc2_disp_double(v);
  else if (typeof v === "boolean") mtoc2_disp_double(v ? 1 : 0);
  else if (typeof v === "string") this.ctx.helpers.write(v + "\n");
  else if (isCharRV(v)) this.ctx.helpers.write(v.value + "\n");
  else if (isComplexValue(v)) mtoc2_disp_complex(v);
  else if (isTensor(v)) {
    if (v.imag !== undefined) {
      mtoc2_disp_tensor_complex(v);
    } else {
      mtoc2_disp_tensor(v);
    }
  } else {
    this.ctx.helpers.write(String(v) + "\n");
  }
}

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
    // through `callUserFunction`, not `execBody`. ClassDef is a
    // workspace-time declaration; Import / Directive are translator
    // hints (or no-ops in the interpreter).
    case "Function":
    case "ClassDef":
    case "Import":
    case "Directive":
      return;

    // `global` / `persistent` change variable storage in MATLAB. The
    // interpreter currently has no shared-state slot; silently doing
    // nothing here would let user code read garbage. Raise loudly
    // until storage classes are wired through Environment.
    case "Global":
    case "Persistent":
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
    // Indexed-write paths supported:
    //   - all-scalar slots: `v(i) = x`, `M(i,j) = x` — scalar RHS,
    //     direct linear or column-major scatter into one slot.
    //   - any Colon/Range slots: `v(:) = rhs`, `v(2:5) = rhs`,
    //     `M(2,:) = rhs`, `t(:,:,2) = rhs` — slot resolution mirrors
    //     `indexTensor`'s read path; the scatter walks the cartesian
    //     product of slot indices, broadcasting a scalar RHS or
    //     copying from a numel-matching tensor RHS.
    // The base must be a bare Var holding a tensor today. IndexVec /
    // LogicalMask slots, member-rooted writes (`obj.field(args) = ...`),
    // and indexed delete (`v(2:5) = []`) raise as out-of-scope per
    // CLAUDE.md.
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
    // All indexed-write paths share the same slot-resolution + scatter
    // machinery: a slot resolves to (count, idxFn), the cartesian
    // product of slot indices walks the selected region, and each
    // visited position writes one element from a scalar / complex-
    // scalar / tensor RHS. Statically-scalar slots (Number / Char /
    // String / ImagUnit literals) still benefit from the same code:
    // count = 1, total = 1, single write. Removing the old fast path
    // unifies the handling and (importantly) lets `b(1) = 1 + 1i`
    // accept a complex scalar RHS uniformly with `b(:) = 1 + 1i`.
    //
    // Resolve each slot to (count, idxFn) mirroring `indexTensor` —
    // same `end`-stack push so `v(2:end)`, `M(2, 1:end-1)`, etc.
    // resolve consistently with the read side.
    const ndim = lv.indices.length;
    type Slot = { count: number; idxFn: (k: number) => number };
    const slots: Slot[] = [];
    for (let i = 0; i < ndim; i++) {
      const a = lv.indices[i];
      this.endStack.push({
        baseTensor: baseVal,
        axis: ndim === 1 ? "linear" : i,
      });
      let slot: Slot;
      try {
        if (a.type === "Colon") {
          const axisLen =
            ndim === 1 ? baseVal.data.length : (baseVal.shape[i] ?? 1);
          slot = { count: axisLen, idxFn: k => k + 1 };
        } else if (a.type === "Range") {
          const s = toScalarNumber(this.evalExpr(a.start));
          const en = toScalarNumber(this.evalExpr(a.end));
          const st = a.step ? toScalarNumber(this.evalExpr(a.step)) : 1;
          let n = 0;
          if (st !== 0) {
            const calc = Math.floor((en - s) / st + 1 + 1e-10);
            n = calc > 0 && Number.isFinite(calc) ? calc : 0;
          }
          slot = { count: n, idxFn: k => Math.trunc(s + st * k) };
        } else {
          // Bare ident / lit / arith — scalar numeric, an IndexVec
          // (numeric tensor), or a LogicalMask (isLogical-tagged
          // tensor). Same surface as the read-side `indexTensor`.
          const sv = this.evalExpr(a);
          if (typeof sv === "number") {
            const iv = Math.trunc(sv);
            slot = { count: 1, idxFn: () => iv };
          } else if (isTensor(sv)) {
            if (sv.isLogical) {
              const md = sv.data;
              const truthy: number[] = [];
              for (let mi = 0; mi < md.length; mi++) {
                if (md[mi] !== 0) truthy.push(mi + 1);
              }
              slot = { count: truthy.length, idxFn: k => truthy[k] };
            } else {
              const td = sv.data;
              slot = { count: td.length, idxFn: k => Math.trunc(td[k]) };
            }
          } else {
            throw new UnsupportedConstruct(
              `interpreter: indexed write slot must be a Colon, Range, ` +
                `scalar numeric, IndexVec, or logical mask ` +
                `(got ${typeof sv} at position ${i + 1})`
            );
          }
        }
      } finally {
        this.endStack.pop();
      }
      slots.push(slot);
    }
    let total = 1;
    for (const s of slots) total *= s.count;
    // Validate / classify RHS shape. Three accepted forms:
    //   - real scalar number: broadcast across every slot
    //   - complex scalar `{re, im}`: broadcast both lanes
    //   - tensor (real or complex): numel must match `total`, copy
    //     element-by-element (and the imag lane when the rhs has one)
    let rhsScalar: number | undefined;
    let rhsScalarComplex: { re: number; im: number } | undefined;
    let rhsTensor:
      | { data: ArrayLike<number>; imag?: ArrayLike<number> }
      | undefined;
    if (typeof v === "number") {
      rhsScalar = v;
    } else if (isTensor(v)) {
      if (v.data.length !== total) {
        throw new UnsupportedConstruct(
          `interpreter: indexed-slice RHS has ${v.data.length} element(s) ` +
            `but the selected region has ${total} slot(s)`
        );
      }
      rhsTensor = v;
    } else if (isComplexValue(v)) {
      rhsScalarComplex = v;
    } else {
      throw new UnsupportedConstruct(
        `interpreter: indexed-slice RHS must be a real or complex scalar, ` +
          `or a tensor (got ${typeof v})`
      );
    }
    const baseImag = baseVal.imag;
    // Walk the cartesian product of slot indices, scattering into the
    // base tensor. Column-major iteration matches the runtime layout.
    // When the base carries an imag lane, the rhs lane is written
    // alongside: real scalar / tensor RHS fills imag with 0; complex
    // scalar / tensor RHS copies the rhs imag (treating a missing rhs
    // imag as zero, mirroring the C-side helpers).
    const idx = new Array(slots.length).fill(0);
    for (let k = 0; k < total; k++) {
      // Compute source linear offset.
      let off: number;
      if (slots.length === 1) {
        const ix = slots[0].idxFn(idx[0]);
        if (ix < 1 || ix > baseVal.data.length) {
          throw new RangeError(
            `Index in position 1 (${ix}) exceeds array bounds (${baseVal.data.length})`
          );
        }
        off = ix - 1;
      } else {
        off = 0;
        let stride = 1;
        for (let i = 0; i < slots.length; i++) {
          const ix = slots[i].idxFn(idx[i]);
          const dim = baseVal.shape[i] ?? 1;
          if (ix < 1 || ix > dim) {
            throw new RangeError(
              `Index in position ${i + 1} (${ix}) exceeds array bounds (${dim})`
            );
          }
          off += (ix - 1) * stride;
          stride *= dim;
        }
      }
      let reVal: number;
      let imVal: number;
      if (rhsScalar !== undefined) {
        reVal = rhsScalar;
        imVal = 0;
      } else if (rhsScalarComplex !== undefined) {
        reVal = rhsScalarComplex.re;
        imVal = rhsScalarComplex.im;
      } else {
        reVal = rhsTensor!.data[k];
        imVal = rhsTensor!.imag ? rhsTensor!.imag[k] : 0;
      }
      baseVal.data[off] = reVal;
      if (baseImag !== undefined) baseImag[off] = imVal;
      // Advance idx in column-major order (innermost = fastest).
      for (let i = 0; i < slots.length; i++) {
        idx[i]++;
        if (idx[i] < slots[i].count) break;
        idx[i] = 0;
      }
    }
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

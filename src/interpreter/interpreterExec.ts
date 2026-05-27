/**
 * Statement execution + helpers: execBody, execStmt, assignLValue,
 * expandForRange, autoDisp. Attached to `Interpreter.prototype`
 * from `interpreter.ts`.
 *
 * Mirrors numbl's interpreterExec split — same role here, smaller
 * surface because mtoc2 walks a tighter AST subset.
 */

import type { Expr, Stmt, LValue } from "../parser/index.js";
import {
  isChar as isCharRV,
  isComplexValue,
  isHandleValue,
  isTensor,
  isTruthy,
  makeComplexTensor,
  makeTensor,
  toScalarNumber,
  type RuntimeTensor,
  type RuntimeValue,
} from "../runtime/value.js";
import { UnsupportedConstruct } from "../lowering/errors.js";
import {
  tryExtractDottedName,
  unwindMemberChain,
  unwindMemberLvalue,
} from "../parser/astUtils.js";
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

// ── Tensor cloning for in-place writes ───────────────────────────────────

/** Fresh-buffer copy of `t` for indexed-write paths. MATLAB
 *  pass-by-value semantics: an indexed write through one alias must
 *  not be visible through any other alias (caller of a function,
 *  `b = a`, struct field aliasing, ...). The interpreter has no
 *  refcounting / sharing-tracking, so we clone unconditionally —
 *  cheap relative to interpreter overhead in general, matches numbl's
 *  COW-on-shared in the worst case.
 *
 *  The `isLogical` flag (when set on a mask tensor) is preserved so a
 *  downstream `if mask(i) = 0; if mask; end` chain keeps the mask
 *  classification through the write. */
function cloneTensorForWrite(t: RuntimeTensor): RuntimeTensor {
  const shape = t.shape.slice();
  const data = new Float64Array(t.data);
  const fresh =
    t.imag !== undefined
      ? makeComplexTensor(shape, data, new Float64Array(t.imag))
      : makeTensor(shape, data);
  if (t.isLogical) {
    return { ...fresh, isLogical: true };
  }
  return fresh;
}

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
      // Expand a single `[out{1:nout}]`-style brace lvalue to N
      // synthesized `out{k}` lvalues so the multi-assign nargout
      // counts correctly (cells phase C comma-list LHS).
      const expandedLvalues = expandRangeCellLvaluesInterpreter.call(
        this,
        s.lvalues
      );
      let results: RuntimeValue[];
      const nargout = expandedLvalues.length;
      if (s.expr.type === "FuncCall") {
        const argVals = s.expr.args.map(a => this.evalExpr(a));
        // In-scope handle variable: route through callHandle so the
        // single-output (`isHandleValue`) and multi-output paths share
        // the same dispatch.
        const envVal = this.env.get(s.expr.name);
        if (envVal !== undefined && isHandleValue(envVal)) {
          results = this.callHandle(envVal, argVals, nargout, s.span);
        } else {
          results = this.callByName(s.expr.name, argVals, nargout, s.span);
        }
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
      for (let i = 0; i < expandedLvalues.length; i++) {
        this.assignLValue(expandedLvalues[i], results[i], s.suppressed);
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

    case "Switch": {
      // Numbl semantics (see numbl's `switchMatch` /
      // `switchValuesMatch`): the case value is matched against the
      // switch expression with MATLAB-style equality. A case whose
      // value is a `Cell` (`{a, b, c}`) matches if ANY of its elements
      // matches; mtoc2 doesn't have Cell in scope yet so we don't
      // handle that branch here — the parser will surface it as a
      // Cell expr inside `c.value` and the eval-switch will reject it
      // before we get a value to compare. The `otherwise` body runs
      // only when no case matched; at most one case body runs.
      const switchVal = this.evalExpr(s.expr);
      let matched = false;
      for (const c of s.cases) {
        const caseVal = this.evalExpr(c.value);
        if (switchMatch(switchVal, caseVal)) {
          matched = true;
          this.execBody(c.body);
          break;
        }
      }
      if (!matched && s.otherwise) this.execBody(s.otherwise);
      return;
    }

    // Non-executable at this level — body of a Function is run
    // through `callUserFunction`, not `execBody`. ClassDef is a
    // workspace-time declaration; Import / Directive are translator
    // hints (or no-ops in the interpreter).
    case "Function":
    case "ClassDef":
    case "Import":
    case "Directive":
      return;

    case "TryCatch": {
      // Run the try body. On any catchable exception, bind the
      // wrapped MException-shape struct to `catchVar` (if present)
      // and run the catch body. `Break` / `Continue` / `Return`
      // signal exceptions are control-flow markers and propagate
      // through `try` unchanged. `UnsupportedConstruct` is a
      // translator-level "this isn't implemented yet" error — re-
      // throw so the user sees a proper failure instead of
      // silently entering the catch arm.
      try {
        this.execBody(s.tryBody);
      } catch (e) {
        if (
          e instanceof BreakSignal ||
          e instanceof ContinueSignal ||
          e instanceof ReturnSignal ||
          e instanceof UnsupportedConstruct
        ) {
          throw e;
        }
        if (s.catchVar !== null) {
          this.env.set(s.catchVar, wrapErrorAsMException(e));
        }
        this.execBody(s.catchBody);
      }
      return;
    }

    // `global` / `persistent` change variable storage in MATLAB. The
    // interpreter currently has no shared-state slot; silently doing
    // nothing here would let user code read garbage. Raise loudly
    // until storage classes are wired through Environment.
    case "Global":
    case "Persistent":
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
  if (lv.type === "IndexCell") {
    // `c{i} = rhs` / `c{i, j} = rhs` — brace write into a cell.
    // Bare-Ident base only (member-rooted is rejected at lowering
    // and we mirror that here).
    if (lv.base.type !== "Ident") {
      throw new UnsupportedConstruct(
        `interpreter: cell brace assignment supports a bare cell variable ` +
          `as the base; member-rooted forms are not yet supported`,
        lv.base.span
      );
    }
    const cellVal = this.env.get(lv.base.name);
    if (
      cellVal === undefined ||
      cellVal === null ||
      typeof cellVal !== "object" ||
      (cellVal as { mtoc2Tag?: string }).mtoc2Tag !== "cell"
    ) {
      throw new UnsupportedConstruct(
        `interpreter: '${lv.base.name}' is not a cell; brace assignment ` +
          `'c{...} = rhs' requires a cell value`,
        lv.base.span
      );
    }
    const cell = cellVal as unknown as {
      mtoc2Tag: "cell";
      shape: number[];
      data: RuntimeValue[];
    };
    const idxs = lv.indices.map(ix => {
      const idxV = this.evalExpr(ix);
      return Math.floor(Number(idxV as number));
    });
    let off: number;
    if (idxs.length === 1) {
      off = idxs[0] - 1;
    } else if (idxs.length === 2) {
      const rows = cell.shape[0] ?? 1;
      off = (idxs[1] - 1) * rows + (idxs[0] - 1);
    } else {
      throw new UnsupportedConstruct(
        `interpreter: cell brace assignment supports 1 or 2 indices ` +
          `(got ${idxs.length})`,
        lv.base.span
      );
    }
    if (off < 0 || off >= cell.data.length) {
      throw new UnsupportedConstruct(
        `interpreter: cell brace index out of bounds`,
        lv.base.span
      );
    }
    cell.data[off] = v;
    if (!suppressed)
      this.autoDisp(lv.base.name, cell as unknown as RuntimeValue);
    return;
  }
  if (lv.type === "Index") {
    // Indexed-write paths supported:
    //   - all-scalar slots: `v(i) = x`, `M(i,j) = x` — scalar RHS,
    //     direct linear or column-major scatter into one slot.
    //   - any Colon/Range slots: `v(:) = rhs`, `v(2:5) = rhs`,
    //     `M(2,:) = rhs`, `t(:,:,2) = rhs` — slot resolution mirrors
    //     `indexTensor`'s read path; the scatter walks the cartesian
    //     product of slot indices, broadcasting a scalar RHS or
    //     copying from a numel-matching tensor RHS.
    // The base must be either a bare Var holding a tensor or a Member
    // chain rooted at a tensor-valued field of a struct / class
    // instance. IndexVec / LogicalMask slots and indexed delete
    // (`v(2:5) = []`) raise as out-of-scope per CLAUDE.md.
    let baseName: string;
    let baseVal: RuntimeTensor;
    let writeBack: () => void;
    if (lv.base.type === "Ident") {
      baseName = lv.base.name;
      const existing = this.env.get(baseName);
      if (existing === undefined || !isTensor(existing)) {
        throw new UnsupportedConstruct(
          `interpreter: indexed assignment requires '${baseName}' to be ` +
            `an already-bound tensor`
        );
      }
      // MATLAB pass-by-value: clone unconditionally before writing
      // (numbl's COW-on-shared behavior, worst case).
      baseVal = cloneTensorForWrite(existing);
      this.env.set(baseName, baseVal);
      writeBack = (): void => {
        /* nothing extra — env already updated */
      };
    } else if (lv.base.type === "Member") {
      const path = unwindMemberChain(lv.base);
      if (path === null) {
        throw new UnsupportedConstruct(
          `interpreter: member-rooted indexed write requires a bare-Ident root`
        );
      }
      const rootName = path.root.name;
      const fields = path.fields;
      // Indexed write through a dependent property would require
      // invoking the getter, splicing, then the setter — not
      // supported in v1. Match the lowerer's rejection so all three
      // backends fail with the same message shape.
      if (fields.length === 1 && this.workspace !== undefined) {
        const rootRV = this.env.get(rootName);
        const tag =
          rootRV && typeof rootRV === "object" && rootRV !== null
            ? (rootRV as { mtoc2Class?: string }).mtoc2Class
            : undefined;
        if (tag !== undefined) {
          const reg = this.workspace.classes.get(tag);
          if (reg?.dependentProperties.has(fields[0])) {
            throw new UnsupportedConstruct(
              `interpreter: indexed write of dependent property ` +
                `'${rootName}.${fields[0]}' via indexing is not supported in v1`
            );
          }
        }
      }
      let host = this.env.get(rootName) as
        | Record<string, RuntimeValue>
        | undefined;
      if (host === undefined || typeof host !== "object" || host === null) {
        throw new UnsupportedConstruct(
          `interpreter: member-rooted indexed write requires '${rootName}' ` +
            `to be a struct or class instance`
        );
      }
      // Clone the root and every intermediate struct on the path so
      // pre-write aliases see the unchanged value (pass-by-value).
      host = Interpreter.cloneStructLocal(host);
      let cur: Record<string, RuntimeValue> = host;
      for (let i = 0; i < fields.length - 1; i++) {
        const fname = fields[i];
        const next = cur[fname];
        if (
          !next ||
          typeof next !== "object" ||
          isTensor(next) ||
          isCharRV(next)
        ) {
          throw new UnsupportedConstruct(
            `interpreter: '${rootName}.${fields
              .slice(0, i + 1)
              .join(".")}' is not a struct/class container`
          );
        }
        const cloned = Interpreter.cloneStructLocal(
          next as Record<string, RuntimeValue>
        );
        cur[fname] = cloned as RuntimeValue;
        cur = cloned;
      }
      const leafName = fields[fields.length - 1];
      const leafVal = cur[leafName];
      if (!leafVal || !isTensor(leafVal)) {
        throw new UnsupportedConstruct(
          `interpreter: '${rootName}.${fields.join(".")}' is not a tensor field`
        );
      }
      baseName = `${rootName}.${fields.join(".")}`;
      baseVal = cloneTensorForWrite(leafVal);
      cur[leafName] = baseVal;
      this.env.set(rootName, host as RuntimeValue);
      const finalHost = host;
      const finalRootName = rootName;
      writeBack = (): void => {
        if (!suppressed)
          this.autoDisp(finalRootName, finalHost as RuntimeValue);
      };
    } else {
      throw new UnsupportedConstruct(
        `interpreter: indexed assignment requires a bare-variable or ` +
          `member-rooted base (got '${lv.base.type}')`
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
          slot = { count: n, idxFn: k => Math.round(s + st * k) };
        } else {
          // Bare ident / lit / arith — scalar numeric, an IndexVec
          // (numeric tensor), or a LogicalMask (isLogical-tagged
          // tensor). Same surface as the read-side `indexTensor`.
          // Non-integer values are rounded to nearest (numbl's
          // `Math.round(idx)` convention in runtimeIndexing.ts), not
          // truncated — `a(2.5)` writes element 3, not 2.
          const sv = this.evalExpr(a);
          if (typeof sv === "number") {
            const iv = Math.round(sv);
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
              slot = { count: td.length, idxFn: k => Math.round(td[k]) };
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
    // For bare-Ident bases, autoDisp shows the variable directly.
    // For member-rooted writes, writeBack shows the root struct/class
    // (and was set up at the top of this branch).
    if (lv.base.type === "Ident") {
      if (!suppressed) this.autoDisp(baseName, baseVal);
    } else {
      writeBack();
    }
    return;
  }
  if (lv.type === "Member") {
    // `s.f = rhs` / `s.a.b = rhs` — walk to the parent of the leaf,
    // then write the field. Bare-Ident bases bind the result back
    // into the env so `s` reflects the mutation; nested bases mutate
    // in-place via the parent reference.
    const path = unwindMemberLvalue(lv);
    if (path === null) {
      throw new UnsupportedConstruct(
        `interpreter: only bare-Ident-rooted member assignment is supported`
      );
    }
    const { rootName, fields } = path;
    // Dependent-property routing: single-level `obj.X = rhs` on a
    // class with a `set.X` accessor rewrites to
    // `obj = set.X(obj, rhs)`. Mirrors numbl's `setMemberReturn` in
    // `runtimeMemberAccess.ts` and the lowerer's setter dispatch.
    if (fields.length === 1 && this.workspace !== undefined) {
      const existing = this.env.get(rootName);
      const tag =
        existing && typeof existing === "object" && existing !== null
          ? (existing as { mtoc2Class?: string }).mtoc2Class
          : undefined;
      if (tag !== undefined) {
        const reg = this.workspace.classes.get(tag);
        const propName = fields[0];
        const setter = reg?.setters.get(propName);
        if (setter !== undefined) {
          const newObj = this.callUserFunction(
            setter,
            [existing as RuntimeValue, v],
            1,
            setter.span,
            setter.span.file
          )[0];
          this.env.set(rootName, newObj);
          if (!suppressed) this.autoDisp(rootName, newObj);
          return;
        }
        if (reg?.dependentProperties.has(propName)) {
          throw new UnsupportedConstruct(
            `interpreter: dependent property '${tag}.${propName}' ` +
              `has no setter; cannot assign`
          );
        }
      }
    }
    // `cloneStructLocal` preserves non-enumerable tags (e.g.
    // `mtoc2Class` on class instances) — a constructor's `obj.x = a`
    // would otherwise silently strip the class tag and break dispatch.
    let host = this.env.get(rootName) as
      | Record<string, RuntimeValue>
      | undefined;
    if (host === undefined || typeof host !== "object" || host === null) {
      host = {};
    } else if (
      isTensor(host as unknown as RuntimeValue) ||
      isCharRV(host as unknown as RuntimeValue)
    ) {
      // MATLAB-style "empty as sentinel": `s = []; s.a = rhs;` promotes
      // the empty tensor to a fresh struct, then writes the field.
      // Non-empty tensors / char arrays also get promoted on a member
      // write — matches numbl's behavior, which routes through
      // `mSetField` on any non-struct base. Pragma: this is the
      // mtoc2-interpreter side only; AOT has rigid types and would
      // need explicit struct construction.
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

// ── Switch matching ──────────────────────────────────────────────────────

/** MATLAB-style `switch` equality. Mirrors numbl's
 *  `switchValuesMatch` (runtime/runtimeHelpers.ts) + `valuesAreEqual`
 *  (runtime/compare.ts):
 *
 *  - Text ↔ text: `'foo'` and `"foo"` compare as the same string
 *    regardless of source kind (Char vs String).
 *  - Numbers, booleans (`logical`): plain `===` on the JS primitive.
 *  - Tensors: same `data` (and matching `imag` if either side is
 *    complex), no shape comparison beyond `data.length`. Mirrors
 *    numbl's elementwise tensor compare.
 *  - Complex scalars: matching `re` AND `im`.
 *  - Anything else falls back to JS `===` (handles, structs as
 *    identity).
 *
 *  v1 doesn't accept cell-of-cases (numbl's `switch x; case {a,b}`
 *  short-circuit), since `Cell` isn't yet wired through the
 *  interpreter — the caller's `evalExpr` rejects Cell exprs first. */
function switchMatch(a: RuntimeValue, b: RuntimeValue): boolean {
  // Text ↔ text (Char or String, in any combination).
  const aIsText = typeof a === "string" || isCharRV(a);
  const bIsText = typeof b === "string" || isCharRV(b);
  if (aIsText && bIsText) {
    const av = typeof a === "string" ? a : a.value;
    const bv = typeof b === "string" ? b : b.value;
    return av === bv;
  }
  if (typeof a === "number" || typeof a === "boolean") {
    if (typeof b !== "number" && typeof b !== "boolean") return false;
    return Number(a) === Number(b);
  }
  if (typeof b === "number" || typeof b === "boolean") return false;
  if (isComplexValue(a)) {
    if (!isComplexValue(b)) return false;
    return a.re === b.re && a.im === b.im;
  }
  if (isTensor(a)) {
    if (!isTensor(b)) return false;
    if (a.data.length !== b.data.length) return false;
    for (let i = 0; i < a.data.length; i++) {
      if (a.data[i] !== b.data[i]) return false;
    }
    const aIm = a.imag;
    const bIm = b.imag;
    if (!!aIm !== !!bIm) return false;
    if (aIm && bIm) {
      for (let i = 0; i < aIm.length; i++) {
        if (aIm[i] !== bIm[i]) return false;
      }
    }
    return true;
  }
  return a === b;
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

/** Wrap a thrown error into a numbl-compatible `MException`-shape
 *  struct: `{identifier, message, cause, stack}`. `identifier` is
 *  read off `e.identifier` when present (numbl's RuntimeError-style
 *  shape); otherwise it's the empty string. `cause` is an empty
 *  0×0 cell; `stack` is an empty 0×0 cell as a placeholder (numbl
 *  populates a struct array, but mtoc2's catch-binding consumers
 *  don't probe it today).
 *
 *  Matches numbl `runtime/runtime.ts:562` `wrapError` so the
 *  cross-runner sees the same field shape from a `catch ME` arm. */
function wrapErrorAsMException(e: unknown): RuntimeValue {
  let identifier = "";
  let message = "";
  if (e !== null && typeof e === "object") {
    const o = e as { identifier?: string; message?: string };
    if (typeof o.identifier === "string") identifier = o.identifier;
    if (typeof o.message === "string") message = o.message;
  } else {
    message = String(e);
  }
  const emptyCell = {
    mtoc2Tag: "cell",
    shape: [0, 0],
    data: [],
  } as unknown as RuntimeValue;
  return {
    identifier: { mtoc2Tag: "char", value: identifier },
    message: { mtoc2Tag: "char", value: message },
    cause: emptyCell,
    stack: emptyCell,
  } as unknown as RuntimeValue;
}

/** Expand `[out{1:nout}]` / `[out{start:end}]` style multi-assign
 *  LHS into N separate `out{k}` IndexCell lvalues so the multi-
 *  assign nargout matches the comma-list count. Sibling of the
 *  c-aot lowerer's `expandRangeCellLvalues`; runtime variant
 *  evaluates the range bounds with the interpreter's env (no
 *  static-exact requirement). */
export function expandRangeCellLvaluesInterpreter(
  this: Interpreter,
  lvalues: ReadonlyArray<LValue>
): LValue[] {
  if (lvalues.length !== 1) return lvalues.slice();
  const lv = lvalues[0];
  if (lv.type !== "IndexCell") return lvalues.slice();
  if (lv.indices.length !== 1) return lvalues.slice();
  const idx = lv.indices[0];
  if (idx.type !== "Range") return lvalues.slice();
  const start = Math.floor(Number(this.evalExpr(idx.start) as number));
  const end = Math.floor(Number(this.evalExpr(idx.end) as number));
  const step =
    idx.step === null
      ? 1
      : Math.floor(Number(this.evalExpr(idx.step) as number));
  if (!Number.isFinite(start) || !Number.isFinite(end) || step === 0) {
    throw new UnsupportedConstruct(
      `interpreter: multi-assign LHS '[<cell>{<range>}]': invalid range ` +
        `(${start}:${step}:${end})`,
      lv.indices[0].span
    );
  }
  const out: LValue[] = [];
  if (step > 0) {
    for (let v = start; v <= end; v += step) {
      out.push({
        type: "IndexCell",
        base: lv.base,
        indices: [
          { type: "Number", value: String(v), span: lv.indices[0].span },
        ],
      });
    }
  } else {
    for (let v = start; v >= end; v += step) {
      out.push({
        type: "IndexCell",
        base: lv.base,
        indices: [
          { type: "Number", value: String(v), span: lv.indices[0].span },
        ],
      });
    }
  }
  return out;
}

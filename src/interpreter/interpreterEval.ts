/**
 * Expression evaluation: evalExpr (the big switch), indexTensor,
 * tryExtractDottedName. Attached to `Interpreter.prototype` from
 * `interpreter.ts`.
 *
 * Mirrors numbl's interpreterExec.ts (where eval lives) split apart
 * here so each file stays under ~600 lines.
 */

import {
  BinaryOperation,
  UnaryOperation,
  type Expr,
  type Span,
} from "../parser/index.js";
import {
  isChar as isCharRV,
  isHandleValue,
  isTensor,
  isTruthy,
  makeChar,
  makeTensor,
  toScalarNumber,
  type RuntimeTensor,
  type RuntimeValue,
} from "../runtime/value.js";
import { UnsupportedConstruct } from "../lowering/errors.js";
import { Environment } from "./environment.js";
import { mtoc2_tensor_make_range as jsMakeRange } from "../builtins/runtime/snippets.gen.js";
import { Interpreter } from "./interpreter.js";

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
  // `.'` (non-conjugate) maps to `transpose`. The complex `'` form
  // lowers to `transpose(conj(z))` in mtoc2's lowering pass; the
  // interpreter walks the AST pre-lowering, so for now we route both
  // to `transpose` — real programs match. Complex inputs surface
  // a clearer error in transpose's transfer.
  [UnaryOperation.NonConjugateTranspose]: "transpose",
  [UnaryOperation.Transpose]: "transpose",
};

// ── Expression evaluation ─────────────────────────────────────────────────

export function evalExpr(this: Interpreter, e: Expr): RuntimeValue {
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
    case "ImagUnit": {
      // `1i` parses as `Number{value:"1"} * ImagUnit`; `i` alone parses
      // as a bare `ImagUnit`. Either way it's the pure imaginary unit
      // — a complex scalar `0 + 1i`. The surrounding `Binary` (for
      // `2.5i`) folds against this via the `times` builtin's complex
      // path.
      return { re: 0, im: 1 };
    }
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
      // belong in `andand`/`oror`'s transfer.)
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
      // MATLAB parses `v(args)` the same whether `v` is a function or
      // a tensor variable being indexed. The lowering layer
      // disambiguates by checking the env first; mirror that here.
      const envVal = this.env.get(e.name);
      if (envVal !== undefined && isTensor(envVal)) {
        return this.indexTensor(envVal, e.args, e.span);
      }
      if (envVal !== undefined && isHandleValue(envVal)) {
        const argVals = e.args.map(a => this.evalExpr(a));
        return this.callHandle(envVal, argVals, e.span);
      }
      const argVals = e.args.map(a => this.evalExpr(a));
      return this.callByName(e.name, argVals, 1, e.span)[0];
    }
    case "Range": {
      // Range-as-value (not for-driver) → build a 1×N row tensor via
      // the shared runtime snippet so cross-runner output matches
      // numbl / c-aot byte-for-byte. Length-1 collapse mirrors
      // `lowerRangeAsValue` in the c-aot path: a single-element range
      // is the scalar `start` so downstream arithmetic and disp
      // formatting agree.
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
      // Both `v(args)` and `expr(args)` route through `indexTensor` —
      // which handles scalar / colon / range / index-vector slots
      // uniformly.
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
      // `s.f` — struct / class field read. Walks the runtime object
      // via the field name. Errors out for non-object bases.
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
      // `obj.method(args)` — four resolution kinds:
      //   1. Static method: `ClassName.method(args)` where the base
      //      is a bare Ident matching a registered class.
      //   2. Package function: dotted name (e.g. `pkg.fn(args)`).
      //   3. Instance method on a class receiver.
      //   4. Member-rooted index: `obj.field(args)` where `obj.field`
      //      is a tensor and the `(args)` are indices.
      if (
        e.base.type === "Ident" &&
        this.workspace !== undefined &&
        this.env.get(e.base.name) === undefined
      ) {
        const reg = this.workspace.classes.get(e.base.name);
        if (reg !== undefined) {
          const fn = reg.staticMethods.get(e.name);
          if (fn === undefined) {
            throw new UnsupportedConstruct(
              `interpreter: class '${e.base.name}' has no static method ` +
                `'${e.name}'`,
              e.span
            );
          }
          const argVals = e.args.map(a => this.evalExpr(a));
          return this.callUserFunction(fn, argVals, 1, e.span)[0];
        }
      }
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
        // Struct / class field that's a tensor: treat as a member-
        // rooted index read (`obj.data(i)`). Read the field into a
        // temp and route through the tensor-indexing path.
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

    case "FuncHandle": {
      // `@name` — store the source name and (optional) snapshot of
      // the resolution context so the handle can dispatch the same
      // function the call site would see right now.
      return {
        mtoc2Handle: true,
        kind: "named",
        name: e.name,
      } as unknown as RuntimeValue;
    }

    case "AnonFunc": {
      // `@(params) body` — capture-by-value snapshot of every visible
      // binding. We snapshot the whole current env's visible names
      // because identifying free vars properly would require static
      // analysis; the closure cost is acceptable for v1.
      const captures: Record<string, RuntimeValue> = {};
      for (const [name, value] of this.env.entries()) {
        captures[name] = value;
      }
      return {
        mtoc2Handle: true,
        kind: "anon",
        params: e.params,
        body: e.body,
        captures,
      } as unknown as RuntimeValue;
    }

    case "Colon": {
      // Bare `:` outside an index slot — uncommon. The lowerer
      // rejects this at compile time; in the interpreter we mirror
      // that decision so users get the same error.
      throw new UnsupportedConstruct(
        `interpreter: bare ':' is only valid inside an index slot`,
        e.span
      );
    }

    case "IndexCell":
    case "MemberDynamic":
    case "SuperMethodCall":
    case "Cell":
    case "ClassInstantiation":
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

// ── Tensor indexing ──────────────────────────────────────────────────────

/** Tensor indexing — supports scalar reads, single-slot Colon
 *  (linearize to N×1), single-slot Range, multi-slot per-axis with
 *  Colon / Scalar / Range / IndexVec mixes. Used by both the
 *  `v(args)` FuncCall path (bare-name tensor variable) and the
 *  `obj.field(args)` MethodCall path (member-rooted index). */
export function indexTensor(
  this: Interpreter,
  base: RuntimeTensor,
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
        const axisLen = ndim === 1 ? base.data.length : (base.shape[i] ?? 1);
        slot = { count: axisLen, idxFn: k => k + 1 };
        allScalar = false;
      } else if (a.type === "Range") {
        const s = toScalarNumber(this.evalExpr(a.start));
        const en = toScalarNumber(this.evalExpr(a.end));
        const st = a.step ? toScalarNumber(this.evalExpr(a.step)) : 1;
        // Same loop_count formula as the c-aot path.
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
  // freshly-owned tensor. For the linear single-slot form, result
  // orientation matches MATLAB: row base → row, col base → col, else
  // column vector.
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

// ── Dotted-name extraction ────────────────────────────────────────────────

/** Try to extract a dotted identifier chain like `pkg.sub.foo` from a
 *  Member-rooted expression, returning the dotted string. Returns
 *  null if the chain bottoms out at something other than an Ident. */
export function tryExtractDottedName(
  this: Interpreter,
  e: Expr
): string | null {
  void this;
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

// Used internally by the anonymous-function handler so a fresh child
// interpreter can be spawned without re-importing the class.
export { Environment };

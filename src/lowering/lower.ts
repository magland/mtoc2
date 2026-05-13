/**
 * mtoc2 lowerer. Walks the numbl AST, threads a type env (with exact-
 * value tracking), and produces typed IR. The same pass:
 *   - statically evaluates fully-exact expressions and emits literals;
 *   - allocates per-call function specializations (mangled by the
 *     FNV-1a hash of the canonicalized arg-type tuple);
 *   - merges types across control-flow joins;
 *   - widens variables assigned inside loop bodies (strips exact)
 *     before lowering the body, so the one-pass lowering doesn't
 *     bake the entry-state value into the emitted code.
 *
 * MVP scope: scalar real double + arithmetic + comparisons + disp +
 * if/while/for + user functions with single output. Anything outside
 * that throws `UnsupportedConstruct` with a span.
 */

import type { AbstractSyntaxTree, Expr, Stmt, Span } from "../parser/index.js";
import { UnsupportedConstruct, TypeError } from "./errors.js";
import {
  type Type,
  type NumericType,
  scalarDouble,
  tensorDouble,
  signFromNumber,
  isScalarRealDouble,
  isScalarRealNumeric,
  isNumeric,
  unify,
  stripExactFromEnv,
  specializationKey,
  EXACT_ARRAY_MAX_ELEMENTS,
} from "./types.js";
import { type IRExpr, type IRStmt, type IRFunc, type IRProgram } from "./ir.js";
import { getBuiltin, binaryOpBuiltin, unaryOpBuiltin } from "./builtins.js";

interface EnvEntry {
  cName: string;
  ty: Type;
}

type FuncStmt = Extract<Stmt, { type: "Function" }>;

export class Lowerer {
  private env: Map<string, EnvEntry> = new Map();
  private functionDefs: Map<string, FuncStmt> = new Map();
  private specializations: Map<string, IRFunc> = new Map();
  /** Per-scope set: names introduced (first-assignment) in current
   *  function body. Used to decide `declare: true` on Assign. Reset
   *  when entering a function specialization. */
  private declared: Set<string> = new Set();

  lowerProgram(ast: AbstractSyntaxTree): IRProgram {
    // Pre-scan: collect top-level function definitions.
    for (const s of ast.body) {
      if (s.type === "Function") {
        if (this.functionDefs.has(s.name)) {
          throw new UnsupportedConstruct(
            `duplicate function '${s.name}'`,
            s.span
          );
        }
        this.functionDefs.set(s.name, s);
      }
    }
    // Lower top-level statements (functions filter to null).
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
    switch (s.type) {
      case "Function":
        return null; // pre-scanned, specialized on demand at call sites
      case "ExprStmt":
        return this.lowerExprStmt(s);
      case "Assign":
        return this.lowerAssign(s);
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
      default:
        throw new UnsupportedConstruct(
          `statement type '${s.type}' not supported`,
          s.span
        );
    }
  }

  private lowerExprStmt(s: Extract<Stmt, { type: "ExprStmt" }>): IRStmt | null {
    const expr = this.lowerExpr(s.expr);
    // If the expression is a folded literal with no side effect, drop it.
    if (expr.kind === "NumLit") return null;
    return { kind: "ExprStmt", expr, span: s.span };
  }

  private lowerAssign(s: Extract<Stmt, { type: "Assign" }>): IRStmt {
    const expr = this.lowerExpr(s.expr);
    return this.recordAssignment(s.name, expr, s.span);
  }

  private recordAssignment(name: string, expr: IRExpr, span: Span): IRStmt {
    const existing = this.env.get(name);
    const declare = !this.declared.has(name);
    this.declared.add(name);
    const cName = existing?.cName ?? name;
    this.env.set(name, { cName, ty: expr.ty });
    return {
      kind: "Assign",
      name,
      cName,
      declare,
      ty: expr.ty,
      expr,
      span,
    };
  }

  private lowerIf(s: Extract<Stmt, { type: "If" }>): IRStmt | IRStmt[] {
    const cond = this.lowerExpr(s.cond);
    this.requireScalarCond(cond.ty, "if condition", s.span);

    // If-fold: when the top cond is exact, take/drop the then-arm and
    // recurse on the remaining elseif chain.
    const folded = condToBool(cond);
    if (folded === true) return this.lowerStmts(s.thenBody);
    if (folded === false) {
      if (s.elseifBlocks.length === 0) {
        return s.elseBody ? this.lowerStmts(s.elseBody) : [];
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
      return this.lowerIf(synthetic);
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
    this.requireScalarCond(ec.ty, "elseif condition", first.cond.span);
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
    this.requireScalarCond(cond.ty, "while condition", s.span);
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
      if (stepExpr.kind !== "NumLit") {
        throw new UnsupportedConstruct(
          `for-loop step must be a numeric literal`,
          s.expr.step.span
        );
      }
      if (stepExpr.value === 0) {
        throw new UnsupportedConstruct(
          `for-loop step must be non-zero`,
          s.expr.step.span
        );
      }
      step = stepExpr.value;
    }

    const envBefore = new Map(this.env);
    // Loop var is widened to non-exact (could take many values).
    const loopVarSign =
      step > 0 ? "positive" : step < 0 ? "negative" : "unknown";
    // (Conservatively, k could be 0 for `0:N` — but for MVP "positive"
    // is fine when both start>=1 and step>0; otherwise widen.)
    const startSign = isNumeric(start.ty) ? start.ty.sign : "unknown";
    let kSign: NumericType["sign"] = "unknown";
    if (step > 0 && startSign === "positive") kSign = "positive";
    else if (step > 0 && (startSign === "nonneg" || startSign === "zero"))
      kSign = "nonneg";
    else if (step < 0 && startSign === "negative") kSign = "negative";
    else kSign = loopVarSign;

    this.declared.add(s.varName);
    this.env.set(s.varName, {
      cName: s.varName,
      ty: scalarDouble(kSign),
    });

    stripExactFromEnv(this.env, collectAssignedNames(s.body));

    const body = this.lowerStmts(s.body);
    this.env = this.mergeBranchEnvs([envBefore, this.env]);
    return {
      kind: "For",
      varName: s.varName,
      cVar: s.varName,
      start,
      step,
      end,
      body,
      span: s.span,
    };
  }

  // ── Expression lowering ───────────────────────────────────────────────

  private lowerExpr(e: Expr): IRExpr {
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
      default:
        throw new UnsupportedConstruct(
          `expression type '${e.type}' not supported`,
          e.span
        );
    }
  }

  private lowerIdent(e: Extract<Expr, { type: "Ident" }>): IRExpr {
    const entry = this.env.get(e.name);
    if (entry === undefined) {
      throw new UnsupportedConstruct(
        `undefined variable '${e.name}' (or unsupported reference)`,
        e.span
      );
    }
    // Substitute Var → literal when exact is set.
    if (isNumeric(entry.ty) && entry.ty.exact !== undefined) {
      if (typeof entry.ty.exact === "number" && isScalarRealNumeric(entry.ty)) {
        return {
          kind: "NumLit",
          value: entry.ty.exact,
          ty: entry.ty,
          span: e.span,
        };
      }
      if (entry.ty.exact instanceof Float64Array && entry.ty.shape) {
        return {
          kind: "TensorLit",
          data: entry.ty.exact,
          shape: entry.ty.shape.slice(),
          ty: entry.ty,
          span: e.span,
        };
      }
    }
    return {
      kind: "Var",
      name: e.name,
      cName: entry.cName,
      ty: entry.ty,
      span: e.span,
    };
  }

  /** Lower an AST `Tensor` node ([1 2; 3 4]) into a TensorLit IR node.
   *  Slope 1: every element must lower to an exact scalar real; the
   *  total number of elements must fit under EXACT_ARRAY_MAX_ELEMENTS.
   *  Layout is column-major to match numbl's RuntimeTensor.data. */
  private lowerTensorLit(e: Extract<Expr, { type: "Tensor" }>): IRExpr {
    if (e.rows.length === 0) {
      // Empty `[]`. Numbl uses an empty 0×0 tensor — we mirror.
      return {
        kind: "TensorLit",
        data: new Float64Array(0),
        shape: [0, 0],
        ty: tensorDouble([0, 0], new Float64Array(0)),
        span: e.span,
      };
    }
    const rows = e.rows.length;
    const cols0 = e.rows[0].length;
    for (const row of e.rows) {
      if (row.length !== cols0) {
        throw new UnsupportedConstruct(
          `tensor rows must have the same number of columns`,
          e.span
        );
      }
    }
    const cols = cols0;
    const total = rows * cols;
    if (total > EXACT_ARRAY_MAX_ELEMENTS) {
      throw new UnsupportedConstruct(
        `tensor literal of ${total} elements exceeds the exact-array cap (${EXACT_ARRAY_MAX_ELEMENTS})`,
        e.span
      );
    }

    // Lower each element first; require all to be exact scalar real
    // doubles (slope-1 restriction).
    const data = new Float64Array(total);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const lowered = this.lowerExpr(e.rows[r][c]);
        if (lowered.kind !== "NumLit" || !isScalarRealNumeric(lowered.ty)) {
          throw new UnsupportedConstruct(
            `tensor literal element must lower to an exact scalar real (slope-1 restriction)`,
            e.rows[r][c].span
          );
        }
        // Column-major flat index.
        data[c * rows + r] = lowered.value;
      }
    }
    const ty = tensorDouble([rows, cols], data);
    return {
      kind: "TensorLit",
      data,
      shape: [rows, cols],
      ty,
      span: e.span,
    };
  }

  private lowerBinary(e: Extract<Expr, { type: "Binary" }>): IRExpr {
    const left = this.lowerExpr(e.left);
    const right = this.lowerExpr(e.right);
    const name = binaryOpBuiltin(e.op);
    const b = getBuiltin(name);
    if (!b) {
      throw new UnsupportedConstruct(
        `builtin '${name}' not registered`,
        e.span
      );
    }
    const ty = b.transfer([left.ty, right.ty], e.span);
    if (
      isNumeric(ty) &&
      typeof ty.exact === "number" &&
      isScalarRealDouble(ty)
    ) {
      return {
        kind: "NumLit",
        value: ty.exact,
        ty,
        span: e.span,
      };
    }
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
    const name = unaryOpBuiltin(e.op);
    const b = getBuiltin(name);
    if (!b) {
      throw new UnsupportedConstruct(
        `builtin '${name}' not registered`,
        e.span
      );
    }
    const ty = b.transfer([operand.ty], e.span);
    if (
      isNumeric(ty) &&
      typeof ty.exact === "number" &&
      isScalarRealDouble(ty)
    ) {
      return {
        kind: "NumLit",
        value: ty.exact,
        ty,
        span: e.span,
      };
    }
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
    const args = e.args.map(a => this.lowerExpr(a));
    const argTypes = args.map(a => a.ty);

    // Builtin path.
    const b = getBuiltin(e.name);
    if (b) {
      if (args.length !== b.arity) {
        throw new TypeError(
          `'${e.name}' expects ${b.arity} arg(s), got ${args.length}`,
          e.span
        );
      }
      const ty = b.transfer(argTypes, e.span);
      if (
        isNumeric(ty) &&
        typeof ty.exact === "number" &&
        isScalarRealDouble(ty)
      ) {
        return {
          kind: "NumLit",
          value: ty.exact,
          ty,
          span: e.span,
        };
      }
      return {
        kind: "Call",
        cName: e.name, // builtins use their bare name in C (mtoc2_<name> via codegen)
        name: e.name,
        args,
        ty,
        span: e.span,
      };
    }

    // User function path.
    const decl = this.functionDefs.get(e.name);
    if (!decl) {
      throw new UnsupportedConstruct(`unknown function '${e.name}'`, e.span);
    }
    const spec = this.specializeUserFunction(decl, argTypes);
    const ty = spec.outputTypes[0] ?? { kind: "Unknown" };
    if (
      isNumeric(ty) &&
      typeof ty.exact === "number" &&
      isScalarRealDouble(ty)
    ) {
      return {
        kind: "NumLit",
        value: ty.exact,
        ty,
        span: e.span,
      };
    }
    return {
      kind: "Call",
      cName: spec.cName,
      name: e.name,
      args,
      ty,
      span: e.span,
    };
  }

  // ── Function specialization ───────────────────────────────────────────

  private specializeUserFunction(decl: FuncStmt, argTypes: Type[]): IRFunc {
    if (argTypes.length !== decl.params.length) {
      throw new TypeError(
        `function '${decl.name}' expects ${decl.params.length} arg(s), got ${argTypes.length}`,
        decl.span
      );
    }
    if (decl.outputs.length !== 1) {
      throw new UnsupportedConstruct(
        `function '${decl.name}' must have exactly 1 output (got ${decl.outputs.length})`,
        decl.span
      );
    }
    const key = `${decl.name}__${specializationKey(argTypes)}`;
    const cached = this.specializations.get(key);
    if (cached) return cached;

    // Insert placeholder to break recursion (not supported in MVP but
    // we'll throw a cleaner error than infinite recursion).
    const placeholder: IRFunc = {
      name: decl.name,
      cName: key,
      params: decl.params.slice(),
      cParams: decl.params.slice(),
      paramTypes: argTypes,
      outputs: decl.outputs.slice(),
      cOutputs: decl.outputs.slice(),
      outputTypes: [],
      body: [],
      span: decl.span,
    };
    this.specializations.set(key, placeholder);

    // Save outer state.
    const savedEnv = this.env;
    const savedDeclared = this.declared;
    this.env = new Map();
    this.declared = new Set();

    // Bind params.
    for (let i = 0; i < decl.params.length; i++) {
      const pName = decl.params[i];
      this.env.set(pName, { cName: pName, ty: argTypes[i] });
      this.declared.add(pName);
    }
    // Outputs are declared but not yet assigned.
    for (const o of decl.outputs) {
      this.declared.add(o);
    }

    const body = this.lowerStmts(decl.body);

    // Output types come from the final env value of each output name.
    const outputTypes: Type[] = decl.outputs.map(o => {
      const e = this.env.get(o);
      if (!e) {
        throw new TypeError(
          `function '${decl.name}': output '${o}' was never assigned`,
          decl.span
        );
      }
      return e.ty;
    });

    // Restore outer state.
    this.env = savedEnv;
    this.declared = savedDeclared;

    const out: IRFunc = {
      ...placeholder,
      body,
      outputTypes,
    };
    this.specializations.set(key, out);
    return out;
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private requireScalarCond(t: Type, what: string, span: Span): void {
    if (!isScalarRealNumeric(t)) {
      throw new UnsupportedConstruct(
        `${what} must be a scalar real numeric for MVP (got non-scalar/non-real)`,
        span
      );
    }
  }

  private requireScalarReal(t: Type, what: string, span: Span): void {
    if (!isScalarRealNumeric(t)) {
      throw new UnsupportedConstruct(
        `${what} must be a scalar real numeric for MVP`,
        span
      );
    }
  }

  private mergeBranchEnvs(
    envs: Map<string, EnvEntry>[]
  ): Map<string, EnvEntry> {
    // Collect all keys present in any branch.
    const allKeys = new Set<string>();
    for (const e of envs) for (const k of e.keys()) allKeys.add(k);
    const out = new Map<string, EnvEntry>();
    for (const k of allKeys) {
      const entries = envs.map(e => e.get(k));
      if (entries.some(x => x === undefined)) continue; // not in all branches
      let ty: Type = (entries[0] as EnvEntry).ty;
      for (let i = 1; i < entries.length; i++) {
        ty = unify(ty, (entries[i] as EnvEntry).ty);
      }
      const cName = (entries[0] as EnvEntry).cName;
      out.set(k, { cName, ty });
    }
    return out;
  }
}

// ── Helpers (free functions) ────────────────────────────────────────────

/** Returns true/false if `cond` is a literal logical value, null otherwise. */
function condToBool(cond: IRExpr): boolean | null {
  if (cond.kind !== "NumLit") return null;
  if (!Number.isFinite(cond.value)) return null;
  return cond.value !== 0;
}

/** Walk a stmt-tree and collect names of LHS targets (Assign, MultiAssign,
 *  For loop vars). Used to widen loop-body-mutated env entries to non-exact. */
function collectAssignedNames(stmts: Stmt[]): Set<string> {
  const out = new Set<string>();
  const walk = (ss: Stmt[]): void => {
    for (const s of ss) {
      switch (s.type) {
        case "Assign":
          out.add(s.name);
          break;
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

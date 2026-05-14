/**
 * mtoc2 lowerer. Walks the numbl AST, threads a type env (with exact-
 * value tracking), and produces typed IR. The same pass:
 *   - allocates per-call function specializations (mangled by the
 *     FNV-1a hash of the canonicalized arg-type tuple);
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
 * `Void` and are only valid as the expression of an `ExprStmt`).
 * Anything outside that throws `UnsupportedConstruct` with a span.
 */

import type { AbstractSyntaxTree, Expr, Stmt, Span } from "../parser/index.js";
import { offsetToLineCol } from "../parser/sourceLoc.js";
import { UnsupportedConstruct, TypeError } from "./errors.js";
import {
  type Type,
  type NumericType,
  type HandleType,
  type HandleCapture,
  scalarDouble,
  tensorDouble,
  signFromNumber,
  isScalarRealNumeric,
  isMultiElement,
  isNumeric,
  isVoid,
  isHandle,
  handleType,
  typeToString,
  VOID,
  unify,
  stripExactFromEnv,
  specializationKey,
} from "./types.js";

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
  /** Monotonic counter for synthesizing `_mtoc2_t1`, `_mtoc2_t2`, ...
   *  hoist-temp names. Reset per function specialization. */
  private tempCounter: number = 0;
  /** Monotonic counter for synthesizing anonymous-function names
   *  (`anon_0`, `anon_1`, ...). Shared across the whole program so two
   *  textually distinct `@(...)` expressions get distinct identities. */
  private anonCounter: number = 0;

  /** Source text, retained for offset→line/col conversion when
   *  rendering compile-time diagnostics such as the
   *  `%!numbl:printtype` directive's output. Empty string is allowed
   *  for callers that don't need positional output. */
  constructor(private source: string = "") {}

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
      const { line, column } = offsetToLineCol(this.source, s.span.start);
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
    const expr = this.lowerExpr(s.expr);
    // If the expression is a folded literal with no side effect, drop it.
    if (expr.kind === "NumLit") return null;
    // Void-typed call (zero-output user function): emit as-is. No ANF
    // (Void can't be hoisted; it's only valid at this very position).
    if (isVoid(expr.ty)) {
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
      case "Var":
      case "HandleLit":
      case "HandleCaptureLoad":
        return e;
      case "TensorBuild":
        return {
          ...e,
          elements: e.elements.map(el =>
            this.anfRequireScalarOrVar(el, hoists)
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
    }
  }

  /** Walk `e` and ensure the returned expression is either scalar or a
   *  Var. Recursively ANFs children; if `e` itself is owned-producing
   *  (multi-element non-Var), hoist it. */
  private anfRequireScalarOrVar(e: IRExpr, hoists: IRStmt[]): IRExpr {
    const rewritten = this.anfChildren(e, hoists);
    if (isMultiElement(rewritten.ty) && rewritten.kind !== "Var") {
      return this.hoistToTemp(rewritten, hoists);
    }
    return rewritten;
  }

  private hoistToTemp(e: IRExpr, hoists: IRStmt[]): IRExpr {
    const tempName = this.freshTempName();
    this.declared.add(tempName);
    this.env.set(tempName, { cName: tempName, ty: e.ty });
    hoists.push({
      kind: "Assign",
      name: tempName,
      cName: tempName,
      declare: true,
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

  private recordAssignment(name: string, expr: IRExpr, span: Span): IRStmt {
    const existing = this.env.get(name);
    // Type-compat check: don't allow scalar ↔ tensor mid-flight.
    // Catches reassignments that would invalidate the C-side
    // declaration's type. Limited check; will need to grow alongside
    // the type lattice.
    if (existing) {
      if (isMultiElement(existing.ty) !== isMultiElement(expr.ty)) {
        throw new UnsupportedConstruct(
          `cannot reassign '${name}' across scalar/tensor boundary`,
          span
        );
      }
    }
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
      case "FuncHandle":
        return this.lowerFuncHandle(e);
      case "AnonFunc":
        return this.lowerAnonFunc(e);
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
    return {
      kind: "Var",
      name: e.name,
      cName: entry.cName,
      ty: entry.ty,
      span: e.span,
    };
  }

  /** Lower an AST `Tensor` node (`[1 2; 3 4]`) to a TensorBuild IR node.
   *  The shape is statically known; each cell becomes an IRExpr (a
   *  NumLit for literal cells, Var / Binary / ... for computed cells).
   *  Layout is column-major to match numbl's RuntimeTensor.data.
   *
   *  Special case: a 1×1 tensor literal `[x]` is the same as `x` in
   *  MATLAB (both are scalars). The lowerer returns the inner scalar
   *  expression directly so the C-side variable type stays a bare
   *  `double` rather than an `mtoc2_tensor_t`. */
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

    // Lower every element first. Column-major storage: index = c*rows + r.
    const loweredFlat: IRExpr[] = new Array(total);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const lowered = this.lowerExpr(e.rows[r][c]);
        if (!isScalarRealNumeric(lowered.ty)) {
          throw new UnsupportedConstruct(
            `tensor literal element must be scalar real numeric`,
            e.rows[r][c].span
          );
        }
        loweredFlat[c * rows + r] = lowered;
      }
    }

    if (rows === 1 && cols === 1) {
      return loweredFlat[0];
    }

    const ty = tensorDouble([rows, cols]);
    return {
      kind: "TensorBuild",
      elements: loweredFlat,
      shape: [rows, cols],
      ty,
      span: e.span,
    };
  }

  private lowerBinary(e: Extract<Expr, { type: "Binary" }>): IRExpr {
    const left = this.lowerExpr(e.left);
    this.requireValueType(left, "binary operator operand");
    const right = this.lowerExpr(e.right);
    this.requireValueType(right, "binary operator operand");
    const name = binaryOpBuiltin(e.op);
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
    const name = unaryOpBuiltin(e.op);
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
    // Resolve the name. Three cases, in priority order:
    //   1. A bound variable whose type is `HandleType` — dispatch
    //      through the handle to the underlying user function.
    //   2. A registered builtin (`disp`, `sum`, ...).
    //   3. A top-level user function definition.
    //
    // Note: an in-scope variable of a non-handle type at a call site
    // means the user wrote `name(args)` expecting indexing/call, which
    // mtoc2 doesn't support yet — fall through to the unknown-function
    // error.
    const envEntry = this.env.get(e.name);
    if (envEntry !== undefined && isHandle(envEntry.ty)) {
      return this.dispatchHandleCall(e.name, envEntry, e.args, e.span);
    }
    if (envEntry !== undefined) {
      // The name is bound in env (so it's not a free function reference)
      // but isn't a handle. This is either indexing of a scalar/tensor
      // (`v(k)` — unsupported in v1) or a handle whose type unified to
      // Unknown across a control-flow merge of differently-shaped
      // handles (also unsupported). Either way, give a clearer error
      // than "unknown function".
      throw new UnsupportedConstruct(
        `'${e.name}' is an in-scope variable of type ` +
          `${typeToString(envEntry.ty)}; cannot be called as a function ` +
          `(indexing and dynamically-typed handles are not supported)`,
        e.span
      );
    }

    const args = e.args.map(a => this.lowerExpr(a));
    for (const a of args) {
      this.requireValueType(a, `argument to '${e.name}'`);
    }
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
    // Zero-output user functions return Void; the call is only valid as
    // an ExprStmt (checked by `requireValueType` at every other use site).
    const ty: Type =
      decl.outputs.length === 0
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

  // ── Function handles ──────────────────────────────────────────────────

  /** `@name` — a named handle to a top-level user function. Builds the
   *  handle type, captures empty, and returns a HandleLit. Builtin
   *  targets (`@disp`, `@sin`) are rejected — mtoc2 v1 doesn't support
   *  them. Unknown names raise `UnsupportedConstruct`. */
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
    const decl = this.functionDefs.get(e.name);
    if (decl === undefined) {
      throw new UnsupportedConstruct(
        `unresolved function-handle target '@${e.name}'`,
        e.span
      );
    }
    const ty = handleType(decl.name, decl, []);
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
   *  v1 restricts capture types to scalar real numeric — tensor /
   *  string / handle captures are rejected with `UnsupportedConstruct`
   *  so the handle struct stays plain-old-data (no per-capture
   *  copy/free helpers needed). */
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
      if (!isScalarRealNumeric(entry.ty) && !isHandle(entry.ty)) {
        throw new UnsupportedConstruct(
          `anonymous function captures '${cname}' of unsupported type ` +
            `(only scalar real numeric and function-handle captures are supported)`,
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
    // Park the synth AST so dispatchHandleCall can reach it by name
    // through the normal specializeUserFunction path.
    this.functionDefs.set(synthName, synthAst);
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
    const spec = this.specializeUserFunction(handleTy.ast, argTypes);
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

  private specializeUserFunction(decl: FuncStmt, argTypes: Type[]): IRFunc {
    if (argTypes.length !== decl.params.length) {
      throw new TypeError(
        `function '${decl.name}' expects ${decl.params.length} arg(s), got ${argTypes.length}`,
        decl.span
      );
    }
    if (decl.outputs.length > 1) {
      throw new UnsupportedConstruct(
        `function '${decl.name}' has ${decl.outputs.length} outputs; only 0 or 1 are supported`,
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
    const savedTempCounter = this.tempCounter;
    this.env = new Map();
    this.declared = new Set();
    this.tempCounter = 0;

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
    this.tempCounter = savedTempCounter;

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

/** If the lowered cond's type carries an exact scalar value, return
 *  its boolean interpretation; otherwise null. This is the ONLY place
 *  the lowerer turns a known exact value into a compile-time decision —
 *  the resulting branch is taken/dropped before codegen. Arithmetic /
 *  comparisons / builtin calls and Ident reads all produce runtime IR
 *  even when their `ty.exact` is known. */
function condToBool(cond: IRExpr): boolean | null {
  if (!isNumeric(cond.ty)) return null;
  const x = cond.ty.exact;
  if (typeof x !== "number") return null;
  if (!Number.isFinite(x)) return null;
  return x !== 0;
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
    default:
      // Other expression kinds (Index, Member, ...) are unsupported in
      // mtoc2 v1; if they appear inside an anonymous-function body,
      // the body's own lowering will reject them with a span. Skip
      // capture detection here.
      return;
  }
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

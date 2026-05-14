/**
 * Single-file C codegen for mtoc2 IR. Emits:
 *   1. Standard headers + activated runtime snippets (in dep order).
 *   2. Forward declarations for user-function specializations.
 *   3. Function specialization bodies.
 *   4. `main()` containing top-level statements.
 *
 * Scalars compile to bare `double`. Multi-element tensors compile to
 * `mtoc2_tensor_t` — no refcount, no COW. The codegen invariant
 * (matching mtoc's): every tensor RHS is freshly owned, every
 * ownership-transferring use of a Var read wraps in
 * `mtoc2_tensor_copy(name)`. Pre-declaration of every owned local
 * via `mtoc2_tensor_empty()` at function top makes the first-vs-
 * later distinction uniform (the assign helper releases the prior
 * buffer, which is NULL on first call). Scope-exit emits a
 * `mtoc2_tensor_free` for every owned local.
 *
 * `includeRuntime` (default true): when false, the activated runtime
 * helpers are omitted from the output (a placeholder comment is shown
 * instead) so the IDE's "runtime helpers" toggle can show user-level
 * code in isolation. The emitted C is not compilable in that mode —
 * it's a viewing aid.
 */

import type { IRExpr, IRStmt, IRFunc, IRProgram } from "../lowering/ir.js";
import { getBuiltin } from "../lowering/builtins.js";
import {
  isMultiElement,
  isNumeric,
  isOwned,
  type Type,
} from "../lowering/types.js";
import {
  BASE_HEADERS,
  collectRuntimeHeaders,
  newRuntimeState,
  renderRuntimeBodies,
  useRuntimeByName,
  type RuntimeState,
} from "./runtime.js";

export interface EmitOptions {
  /** Include the activated runtime helper bodies in the output.
   *  Default true. When false, headers + a placeholder stub replace
   *  them so the user sees only their generated code. */
  includeRuntime?: boolean;
}

export function emitProgram(prog: IRProgram, opts: EmitOptions = {}): string {
  const includeRuntime = opts.includeRuntime ?? true;
  const state = newRuntimeState();
  const userParts: string[] = [];

  // Forward declarations.
  for (const fn of prog.functions.values()) {
    userParts.push(`static ${fnRetType(fn)} ${fn.cName}(${fnParamList(fn)});`);
  }
  if (prog.functions.size > 0) userParts.push("");

  // Function bodies.
  for (const fn of prog.functions.values()) {
    userParts.push(emitFunction(fn, state));
    userParts.push("");
  }

  // Main.
  userParts.push("int main(void) {");
  const mainOwned = collectOwnedLocals(prog.topLevelStmts);
  for (const o of mainOwned) {
    useRuntimeByName(state, "mtoc2_tensor_empty");
    userParts.push(`  mtoc2_tensor_t ${o} = mtoc2_tensor_empty();`);
  }
  for (const s of prog.topLevelStmts) {
    const line = emitStmt(s, "  ", state);
    if (line !== null) userParts.push(line);
  }
  const mainHasRet = bodyHasReturn(prog.topLevelStmts);
  if (mainHasRet) userParts.push(`mtoc2_return:`);
  for (const o of mainOwned) {
    useRuntimeByName(state, "mtoc2_tensor_free");
    userParts.push(`  mtoc2_tensor_free(&${o});`);
  }
  userParts.push("  return 0;");
  userParts.push("}");
  userParts.push("");

  // Headers: BASE_HEADERS ∪ activated-snippet headers, deduped.
  const headers = new Set<string>(BASE_HEADERS);
  for (const h of collectRuntimeHeaders(state)) headers.add(h);

  const out: string[] = [];
  for (const h of headers) out.push(`#include ${h}`);
  out.push("");

  if (state.active.size > 0) {
    out.push(
      includeRuntime ? renderRuntimeBodies(state) : runtimePlaceholder(state)
    );
  }

  out.push(...userParts);
  return out.join("\n");
}

function runtimePlaceholder(state: RuntimeState): string {
  if (state.active.size === 0) return "";
  const names = Array.from(state.active).join(", ");
  return `/* runtime helpers omitted (${state.active.size}): ${names} */\n`;
}

function cTypeFor(t: Type): string {
  if (isMultiElement(t)) return "mtoc2_tensor_t";
  return "double";
}

function fnRetType(fn: IRFunc): string {
  const t = fn.outputTypes[0];
  if (!t) return "double";
  return cTypeFor(t);
}

function fnParamList(fn: IRFunc): string {
  if (fn.params.length === 0) return "void";
  return fn.cParams
    .map((p, i) => `${cTypeFor(fn.paramTypes[i])} ${p}`)
    .join(", ");
}

/** Walk the body and collect cNames of locals that need a tensor
 *  declaration at function top. Any Assign whose LHS is `isOwned(ty)`
 *  marks the name. Walks through If / While / For bodies — owned
 *  locals declared inside a block still live in the surrounding
 *  function's stack frame (every local declaration is hoisted to
 *  function top to keep the free-on-exit walk simple). */
function collectOwnedLocals(stmts: IRStmt[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const visit = (ss: IRStmt[]): void => {
    for (const s of ss) {
      switch (s.kind) {
        case "Assign":
          if (isOwned(s.ty) && !seen.has(s.cName)) {
            seen.add(s.cName);
            order.push(s.cName);
          }
          break;
        case "If":
          visit(s.thenBody);
          visit(s.elseBody);
          break;
        case "While":
          visit(s.body);
          break;
        case "For":
          visit(s.body);
          break;
      }
    }
  };
  visit(stmts);
  return order;
}

function emitFunction(fn: IRFunc, state: RuntimeState): string {
  const lines: string[] = [];
  const retType = fnRetType(fn);
  lines.push(`static ${retType} ${fn.cName}(${fnParamList(fn)}) {`);
  // Pre-declare the scalar/tensor output slot.
  const cOut = fn.cOutputs[0];
  const outTy = fn.outputTypes[0];
  const paramNames = new Set(fn.cParams);
  if (!paramNames.has(cOut)) {
    if (outTy && isOwned(outTy)) {
      useRuntimeByName(state, "mtoc2_tensor_empty");
      lines.push(`  mtoc2_tensor_t ${cOut} = mtoc2_tensor_empty();`);
    } else {
      lines.push(`  double ${cOut} = 0.0;`);
    }
  }
  // Pre-declare owned locals (excluding the output, which we already
  // handled above).
  const owned = collectOwnedLocals(fn.body).filter(n => n !== cOut);
  for (const o of owned) {
    useRuntimeByName(state, "mtoc2_tensor_empty");
    lines.push(`  mtoc2_tensor_t ${o} = mtoc2_tensor_empty();`);
  }
  for (const s of fn.body) {
    const line = emitStmt(s, "  ", state);
    if (line !== null) lines.push(line);
  }
  const hasRet = bodyHasReturn(fn.body);
  if (hasRet) lines.push(`mtoc2_return:`);
  // Free every owned local (and the output if it's owned but we're
  // NOT returning it — for now we always return cOut, so skip its
  // free; the caller takes ownership).
  for (const o of owned) {
    useRuntimeByName(state, "mtoc2_tensor_free");
    lines.push(`  mtoc2_tensor_free(&${o});`);
  }
  lines.push(`  return ${cOut};`);
  lines.push(`}`);
  return lines.join("\n");
}

function bodyHasReturn(body: IRStmt[]): boolean {
  for (const s of body) {
    if (s.kind === "ReturnFromFunction") return true;
    if (s.kind === "If") {
      if (bodyHasReturn(s.thenBody) || bodyHasReturn(s.elseBody)) return true;
    } else if (s.kind === "While" || s.kind === "For") {
      if (bodyHasReturn(s.body)) return true;
    }
  }
  return false;
}

function emitStmt(
  s: IRStmt,
  indent: string,
  state: RuntimeState
): string | null {
  switch (s.kind) {
    case "ExprStmt":
      return `${indent}${emitExpr(s.expr, state)};`;
    case "Assign": {
      if (isOwned(s.ty)) {
        useRuntimeByName(state, "mtoc2_tensor_assign");
        const rhs = emitTensorRhs(s.expr, state);
        return `${indent}mtoc2_tensor_assign(&${s.cName}, ${rhs});`;
      }
      const rhs = emitExpr(s.expr, state);
      if (s.declare) {
        return `${indent}double ${s.cName} = ${rhs};`;
      }
      return `${indent}${s.cName} = ${rhs};`;
    }
    case "If": {
      const lines: string[] = [];
      lines.push(`${indent}if (${emitExpr(s.cond, state)} != 0.0) {`);
      for (const t of s.thenBody) {
        const line = emitStmt(t, indent + "  ", state);
        if (line !== null) lines.push(line);
      }
      if (s.elseBody.length > 0) {
        if (s.elseBody.length === 1 && s.elseBody[0].kind === "If") {
          const inner = emitStmt(s.elseBody[0], indent, state);
          if (inner !== null)
            lines.push(`${indent}} else ${inner.trimStart()}`);
          else lines.push(`${indent}}`);
        } else {
          lines.push(`${indent}} else {`);
          for (const e of s.elseBody) {
            const line = emitStmt(e, indent + "  ", state);
            if (line !== null) lines.push(line);
          }
          lines.push(`${indent}}`);
        }
      } else {
        lines.push(`${indent}}`);
      }
      return lines.join("\n");
    }
    case "While": {
      const lines: string[] = [];
      lines.push(`${indent}while (${emitExpr(s.cond, state)} != 0.0) {`);
      for (const b of s.body) {
        const line = emitStmt(b, indent + "  ", state);
        if (line !== null) lines.push(line);
      }
      lines.push(`${indent}}`);
      return lines.join("\n");
    }
    case "For": {
      const lines: string[] = [];
      const startC = emitExpr(s.start, state);
      const endC = emitExpr(s.end, state);
      const stepC = formatDouble(s.step);
      const cmp = s.step > 0 ? "<=" : ">=";
      const upd = s.step > 0 ? `+= ${stepC}` : `-= ${formatDouble(-s.step)}`;
      lines.push(
        `${indent}for (double ${s.cVar} = ${startC}; ${s.cVar} ${cmp} ${endC}; ${s.cVar} ${upd}) {`
      );
      for (const b of s.body) {
        const line = emitStmt(b, indent + "  ", state);
        if (line !== null) lines.push(line);
      }
      lines.push(`${indent}}`);
      return lines.join("\n");
    }
    case "ReturnFromFunction":
      return `${indent}goto mtoc2_return;`;
    case "Break":
      return `${indent}break;`;
    case "Continue":
      return `${indent}continue;`;
  }
}

/** Tensor-typed RHS for an Assign. Each kind produces a freshly-owned
 *  tensor that `mtoc2_tensor_assign` consumes:
 *  - `Var`         → `mtoc2_tensor_copy(name)` (deep copy)
 *  - `TensorLit`   → `mtoc2_tensor_from_row/_matrix(...)` materialized
 *                    from the compile-time-known data
 *  - everything else → `emitExpr` (TensorBuild + Binary/Unary/Call
 *                    already emit fresh-allocating helpers) */
function emitTensorRhs(e: IRExpr, state: RuntimeState): string {
  if (e.kind === "Var") {
    useRuntimeByName(state, "mtoc2_tensor_copy");
    return `mtoc2_tensor_copy(${e.cName})`;
  }
  if (e.kind === "TensorLit") {
    return emitTensorLitMaterialize(e.data, e.shape, state);
  }
  return emitExpr(e, state);
}

function emitTensorLitMaterialize(
  data: Float64Array,
  shape: number[],
  state: RuntimeState
): string {
  const [rows, cols] = shape;
  const flat = Array.from(data).map(formatDouble).join(", ");
  if (rows === 1) {
    useRuntimeByName(state, "mtoc2_tensor_from_row");
    return `mtoc2_tensor_from_row((double[]){${flat}}, ${cols})`;
  }
  useRuntimeByName(state, "mtoc2_tensor_from_matrix");
  return `mtoc2_tensor_from_matrix((double[]){${flat}}, ${rows}, ${cols})`;
}

function emitExpr(e: IRExpr, state: RuntimeState): string {
  switch (e.kind) {
    case "NumLit":
      return formatDouble(e.value);
    case "TensorLit":
      // Exact tensors never materialize as runtime C values. The
      // only IR sites that pass them through to codegen are tensor-
      // aware builtins (disp), which read the data from
      // `argTypes[i].exact` and ignore `argsC[i]`. Placeholder keeps
      // the surrounding C parseable.
      return `0.0 /* exact tensor [${e.shape.join("x")}] (compile-time only) */`;
    case "TensorBuild": {
      // Runtime tensor construction. Both row-vector and matrix cases
      // route through the same compound-literal flat array (the data
      // is already in column-major order). 1×N picks `from_row` for
      // a marginally tighter helper.
      const [rows, cols] = e.shape;
      const flat = e.elements.map(el => emitExpr(el, state)).join(", ");
      if (rows === 1) {
        useRuntimeByName(state, "mtoc2_tensor_from_row");
        return `mtoc2_tensor_from_row((double[]){${flat}}, ${cols})`;
      }
      useRuntimeByName(state, "mtoc2_tensor_from_matrix");
      return `mtoc2_tensor_from_matrix((double[]){${flat}}, ${rows}, ${cols})`;
    }
    case "Var":
      // Tensor Var reads pass the struct by value; downstream context
      // (Assign RHS, user-function call) wraps in copy where needed.
      return e.cName;
    case "Binary": {
      const b = getBuiltin(e.builtin);
      if (!b) throw new Error(`emit: builtin '${e.builtin}' not found`);
      activateRuntimeDeps(b.runtimeDeps, state);
      return b.codegenC(
        [emitExpr(e.left, state), emitExpr(e.right, state)],
        [e.left.ty, e.right.ty]
      );
    }
    case "Unary": {
      const b = getBuiltin(e.builtin);
      if (!b) throw new Error(`emit: builtin '${e.builtin}' not found`);
      activateRuntimeDeps(b.runtimeDeps, state);
      return b.codegenC([emitExpr(e.operand, state)], [e.operand.ty]);
    }
    case "Call": {
      const builtinB = getBuiltin(e.name);
      if (builtinB) {
        activateRuntimeDeps(builtinB.runtimeDeps, state);
        return builtinB.codegenC(
          e.args.map(a => emitExpr(a, state)),
          e.args.map(a => a.ty)
        );
      }
      // User function call: tensor args wrap in copy (callee owns).
      const args = e.args
        .map(a =>
          isOwned(a.ty) ? emitTensorRhs(a, state) : emitExpr(a, state)
        )
        .join(", ");
      return `${e.cName}(${args})`;
    }
  }
}

function activateRuntimeDeps(
  deps: ReadonlyArray<string> | undefined,
  state: RuntimeState
): void {
  if (!deps) return;
  for (const d of deps) useRuntimeByName(state, d);
}

/** Format a JS number as a C double literal that round-trips. */
function formatDouble(v: number): string {
  if (Number.isInteger(v) && Math.abs(v) < 1e15) {
    return `${v}.0`;
  }
  const s = v.toString();
  if (!s.includes(".") && !s.includes("e") && !s.includes("E")) {
    return `${s}.0`;
  }
  return s;
}

// Suppress unused-import lints when narrower predicates aren't used.
void isNumeric;

/**
 * Single-file C codegen for mtoc2 IR. Emits:
 *   1. Runtime header (format helpers + disp).
 *   2. Forward declarations for user-function specializations.
 *   3. Function specialization bodies.
 *   4. `main()` containing top-level statements.
 *
 * MVP scope: everything is `double` in C. The IR types are still
 * useful at lowering time (for exact-folding and signed reasoning)
 * but the emitted C uniformly treats values as scalar real doubles.
 */

import type { IRExpr, IRStmt, IRFunc, IRProgram } from "../lowering/ir.js";
import { getBuiltin } from "../lowering/builtins.js";
import { RUNTIME_HEADER } from "./runtime.js";

export function emitProgram(prog: IRProgram): string {
  const parts: string[] = [];

  // Runtime helpers.
  parts.push(RUNTIME_HEADER);
  parts.push("");

  // Forward declarations.
  for (const fn of prog.functions.values()) {
    parts.push(`static double ${fn.cName}(${fnParamList(fn)});`);
  }
  parts.push("");

  // Function bodies.
  for (const fn of prog.functions.values()) {
    parts.push(emitFunction(fn));
    parts.push("");
  }

  // Main.
  parts.push("int main(void) {");
  for (const s of prog.topLevelStmts) {
    parts.push(emitStmt(s, "  "));
  }
  parts.push("  return 0;");
  parts.push("}");
  parts.push("");

  return parts.join("\n");
}

function fnParamList(fn: IRFunc): string {
  if (fn.params.length === 0) return "void";
  return fn.cParams.map(p => `double ${p}`).join(", ");
}

function emitFunction(fn: IRFunc): string {
  const lines: string[] = [];
  lines.push(`static double ${fn.cName}(${fnParamList(fn)}) {`);
  const cOut = fn.cOutputs[0];
  const paramNames = new Set(fn.cParams);
  if (!paramNames.has(cOut)) {
    lines.push(`  double ${cOut} = 0.0;`);
  }
  for (const s of fn.body) {
    lines.push(emitStmt(s, "  "));
  }
  if (bodyHasReturn(fn.body)) {
    lines.push(`mtoc2_return:`);
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

function emitStmt(s: IRStmt, indent: string): string {
  switch (s.kind) {
    case "ExprStmt":
      return `${indent}${emitExpr(s.expr)};`;
    case "Assign": {
      const rhs = emitExpr(s.expr);
      if (s.declare) {
        return `${indent}double ${s.cName} = ${rhs};`;
      }
      return `${indent}${s.cName} = ${rhs};`;
    }
    case "If": {
      const lines: string[] = [];
      lines.push(`${indent}if (${emitExpr(s.cond)} != 0.0) {`);
      for (const t of s.thenBody) lines.push(emitStmt(t, indent + "  "));
      if (s.elseBody.length > 0) {
        // Detect a single-If else for nicer "else if" output.
        if (s.elseBody.length === 1 && s.elseBody[0].kind === "If") {
          lines.push(
            `${indent}} else ${emitStmt(s.elseBody[0], indent).trimStart()}`
          );
        } else {
          lines.push(`${indent}} else {`);
          for (const e of s.elseBody) lines.push(emitStmt(e, indent + "  "));
          lines.push(`${indent}}`);
        }
      } else {
        lines.push(`${indent}}`);
      }
      return lines.join("\n");
    }
    case "While": {
      const lines: string[] = [];
      lines.push(`${indent}while (${emitExpr(s.cond)} != 0.0) {`);
      for (const b of s.body) lines.push(emitStmt(b, indent + "  "));
      lines.push(`${indent}}`);
      return lines.join("\n");
    }
    case "For": {
      const lines: string[] = [];
      const startC = emitExpr(s.start);
      const endC = emitExpr(s.end);
      const stepC = formatDouble(s.step);
      const cmp = s.step > 0 ? "<=" : ">=";
      const upd = s.step > 0 ? `+= ${stepC}` : `-= ${formatDouble(-s.step)}`;
      lines.push(
        `${indent}for (double ${s.cVar} = ${startC}; ${s.cVar} ${cmp} ${endC}; ${s.cVar} ${upd}) {`
      );
      for (const b of s.body) lines.push(emitStmt(b, indent + "  "));
      lines.push(`${indent}}`);
      return lines.join("\n");
    }
    case "ReturnFromFunction":
      // Single-return-arg model: assume `return cOut;` is at the
      // function's tail (emitFunction handles that). An early return
      // here uses `goto`? For MVP, we don't support early returns —
      // numbl's `return` lowers to ReturnFromFunction; we emit a goto
      // to a label at function tail.
      return `${indent}goto mtoc2_return;`;
    case "Break":
      return `${indent}break;`;
    case "Continue":
      return `${indent}continue;`;
  }
}

function emitExpr(e: IRExpr): string {
  switch (e.kind) {
    case "NumLit":
      return formatDouble(e.value);
    case "Var":
      return e.cName;
    case "Binary": {
      const b = getBuiltin(e.builtin);
      if (!b) throw new Error(`emit: builtin '${e.builtin}' not found`);
      return b.codegenC(
        [emitExpr(e.left), emitExpr(e.right)],
        [e.left.ty, e.right.ty]
      );
    }
    case "Unary": {
      const b = getBuiltin(e.builtin);
      if (!b) throw new Error(`emit: builtin '${e.builtin}' not found`);
      return b.codegenC([emitExpr(e.operand)], [e.operand.ty]);
    }
    case "Call": {
      const builtinB = getBuiltin(e.name);
      if (builtinB) {
        return builtinB.codegenC(
          e.args.map(emitExpr),
          e.args.map(a => a.ty)
        );
      }
      // User function call: cName is the mangled name.
      return `${e.cName}(${e.args.map(emitExpr).join(", ")})`;
    }
  }
}

/** Format a JS number as a C double literal that round-trips. */
function formatDouble(v: number): string {
  if (Number.isInteger(v) && Math.abs(v) < 1e15) {
    return `${v}.0`;
  }
  // Use the shortest representation that round-trips.
  // Number.prototype.toString does this for doubles.
  const s = v.toString();
  // Make sure it contains a `.` or `e` so C parses it as a double.
  if (!s.includes(".") && !s.includes("e") && !s.includes("E")) {
    return `${s}.0`;
  }
  return s;
}

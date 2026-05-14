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
import { getBuiltin } from "../lowering/builtins/index.js";
import {
  classTypedefName,
  handleTypedefName,
  isHandle,
  isMultiElement,
  isNumeric,
  isOwned,
  structTypedefName,
  typeToString,
  type ClassType,
  type HandleType,
  type StructType,
  type Type,
} from "../lowering/types.js";
import { forEachSubExpr, forEachTopLevelExpr } from "../lowering/walk.js";
import {
  BASE_HEADERS,
  collectRuntimeHeaders,
  newRuntimeState,
  renderRuntimeBodies,
  useRuntimeByName,
  type RuntimeState,
} from "./runtime.js";
import {
  computeFutureTouches,
  earlyFreeCandidates,
  nullAtScopeExit,
  type FutureTouchMap,
} from "./liveness.js";
import { irFuncDocComment, irStmtHeader } from "./prettyIR.js";
import {
  emitNamedTypedef,
  specForClass,
  specForStruct,
} from "./emitNamedTypedef.js";

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

  // Collect every distinct HandleType shape referenced anywhere in the
  // program so we can emit one struct typedef per shape ahead of the
  // user code.
  const handleTypedefs = collectHandleTypedefs(prog);

  // Function-handle struct typedefs — one per distinct capture-shape.
  // Emitted before forward decls so handle-typed params/returns/locals
  // can refer to them. No-capture handles share the placeholder typedef.
  if (handleTypedefs.length > 0) {
    for (const td of handleTypedefs) {
      userParts.push(renderHandleTypedef(td));
    }
    userParts.push("");
  }

  // Struct/class typedefs — one per distinct shape. Emitted in
  // topological order so a nested-struct field's typedef appears
  // before its container's. Each typedef ships with its four
  // owned-kind helpers (and a _disp helper for structs).
  const namedTypedefs = collectNamedTypedefs(prog);
  for (const t of namedTypedefs) {
    const spec = t.kind === "Struct" ? specForStruct(t) : specForClass(t);
    userParts.push(emitNamedTypedef(spec, state));
  }
  if (namedTypedefs.length > 0) userParts.push("");

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
    activateOwnedRuntime(o.ty, state);
    const h = ownedHelpersFor(o.ty);
    userParts.push(`  ${cTypeFor(o.ty)} ${o.cName} = ${h.empty}();`);
  }
  const mainFutureTouches = computeFutureTouches(prog.topLevelStmts, null);
  const mainOwnedTypes = new Map<string, Type>(
    mainOwned.map(o => [o.cName, o.ty])
  );
  const mainBody = emitBody(
    prog.topLevelStmts,
    "  ",
    state,
    mainFutureTouches,
    mainOwnedTypes
  );
  if (mainBody.length > 0) userParts.push(mainBody);
  const mainHasRet = bodyHasReturn(prog.topLevelStmts);
  if (mainHasRet) userParts.push(`mtoc2_return:`);
  // Scope-exit free walk skips owned locals proven NULL at this point
  // by the forward `nullAtScopeExit` dataflow — those buffers have
  // already been released by an early-free along every reaching path.
  const mainNullAtExit = nullAtScopeExit(
    prog.topLevelStmts,
    new Set(mainOwned.map(o => o.cName)),
    mainFutureTouches
  );
  for (const o of mainOwned) {
    if (mainNullAtExit.has(o.cName)) continue;
    activateOwnedRuntime(o.ty, state);
    const h = ownedHelpersFor(o.ty);
    userParts.push(`  ${h.free}(&${o.cName});`);
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

/** Walk the entire program and collect every distinct `HandleType`
 *  shape — by typedef name — referenced anywhere. The no-capture
 *  placeholder shape is always added if any handle is in use, so
 *  named-handle code emits a usable typedef. Ordered by first-seen
 *  for deterministic output. */
function collectHandleTypedefs(prog: IRProgram): HandleType[] {
  const seen = new Map<string, HandleType>();
  const consider = (t: Type | undefined): void => {
    if (t === undefined) return;
    if (!isHandle(t)) return;
    const key = handleTypedefName(t);
    if (!seen.has(key)) seen.set(key, t);
  };
  const visitExpr = (e: IRExpr): void => {
    forEachSubExpr(e, sub => {
      consider(sub.ty);
      if (sub.kind === "HandleLit") {
        for (const c of sub.captures) consider(c.value.ty);
      }
    });
  };
  const visitStmts = (stmts: ReadonlyArray<IRStmt>): void => {
    for (const s of stmts) {
      forEachTopLevelExpr(s, visitExpr);
      if (s.kind === "Assign") consider(s.ty);
      switch (s.kind) {
        case "If":
          visitStmts(s.thenBody);
          visitStmts(s.elseBody);
          break;
        case "While":
        case "For":
          visitStmts(s.body);
          break;
      }
    }
  };
  for (const fn of prog.functions.values()) {
    for (const ty of fn.paramTypes) consider(ty);
    for (const ty of fn.outputTypes) consider(ty);
    visitStmts(fn.body);
  }
  visitStmts(prog.topLevelStmts);
  // Pull in dependent handle types (a handle whose capture is itself
  // a handle pulls that handle's typedef into the set transitively).
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of Array.from(seen.values())) {
      for (const c of t.captures) {
        if (isHandle(c.ty)) {
          const k = handleTypedefName(c.ty);
          if (!seen.has(k)) {
            seen.set(k, c.ty);
            grew = true;
          }
        }
      }
    }
  }
  // Topological sort: a handle that captures another handle must come
  // after its dependency's typedef. The graph is acyclic because
  // captures snapshot a value type that pre-exists at the @-site.
  return topoSortHandleTypedefs(Array.from(seen.values()));
}

/** Walk the program and collect every distinct `StructType` and
 *  `ClassType` shape, returning them in dependency-topological order
 *  (a typedef whose fields reference another typedef is emitted
 *  after that other typedef). Recurses into struct/class field types
 *  so a transitively-used inner shape gets included even if the
 *  outer shape is the only thing the IR mentions directly. */
function collectNamedTypedefs(prog: IRProgram): Array<StructType | ClassType> {
  const seen = new Map<string, StructType | ClassType>();

  const considerNamed = (t: Type | undefined): void => {
    if (t === undefined) return;
    if (t.kind === "Struct") {
      const key = structTypedefName(t);
      if (!seen.has(key)) {
        seen.set(key, t);
        for (const f of t.fields) considerNamed(f.ty);
      }
    } else if (t.kind === "Class") {
      const key = classTypedefName(t);
      if (!seen.has(key)) {
        seen.set(key, t);
        for (const p of t.properties) considerNamed(p.ty);
      }
    }
  };

  const visitExpr = (e: IRExpr): void => {
    forEachSubExpr(e, sub => considerNamed(sub.ty));
  };
  const visitStmts = (stmts: ReadonlyArray<IRStmt>): void => {
    for (const s of stmts) {
      forEachTopLevelExpr(s, visitExpr);
      if (s.kind === "Assign") considerNamed(s.ty);
      if (s.kind === "MemberStore") {
        considerNamed(s.base.ty);
        considerNamed(s.leafTy);
      }
      switch (s.kind) {
        case "If":
          visitStmts(s.thenBody);
          visitStmts(s.elseBody);
          break;
        case "While":
        case "For":
          visitStmts(s.body);
          break;
      }
    }
  };
  for (const fn of prog.functions.values()) {
    for (const ty of fn.paramTypes) considerNamed(ty);
    for (const ty of fn.outputTypes) considerNamed(ty);
    visitStmts(fn.body);
  }
  visitStmts(prog.topLevelStmts);

  // Topological sort: a struct/class whose fields reference another
  // struct/class must come after its dependency's typedef.
  return topoSortNamedTypedefs(Array.from(seen.values()));
}

function namedTypedefKey(t: StructType | ClassType): string {
  return t.kind === "Struct" ? structTypedefName(t) : classTypedefName(t);
}

function topoSortNamedTypedefs(
  ts: Array<StructType | ClassType>
): Array<StructType | ClassType> {
  const byName = new Map<string, StructType | ClassType>();
  for (const t of ts) byName.set(namedTypedefKey(t), t);
  const visited = new Set<string>();
  const out: Array<StructType | ClassType> = [];
  const visit = (t: StructType | ClassType): void => {
    const name = namedTypedefKey(t);
    if (visited.has(name)) return;
    visited.add(name);
    const inner =
      t.kind === "Struct"
        ? t.fields.map(f => f.ty)
        : t.properties.map(p => p.ty);
    for (const ity of inner) {
      if (ity.kind === "Struct" || ity.kind === "Class") {
        const dep = byName.get(namedTypedefKey(ity));
        if (dep) visit(dep);
      }
    }
    out.push(t);
  };
  for (const t of ts) visit(t);
  return out;
}

function topoSortHandleTypedefs(ts: HandleType[]): HandleType[] {
  const byName = new Map<string, HandleType>();
  for (const t of ts) byName.set(handleTypedefName(t), t);
  const visited = new Set<string>();
  const out: HandleType[] = [];
  const visit = (t: HandleType): void => {
    const name = handleTypedefName(t);
    if (visited.has(name)) return;
    visited.add(name);
    for (const c of t.captures) {
      if (isHandle(c.ty)) {
        const dep = byName.get(handleTypedefName(c.ty));
        if (dep) visit(dep);
      }
    }
    out.push(t);
  };
  for (const t of ts) visit(t);
  return out;
}

/** Render a single handle-shape typedef as a C struct definition.
 *  No-capture handles get a single `char _placeholder` field so the
 *  struct is non-empty (C forbids empty structs in standard C). */
function renderHandleTypedef(t: HandleType): string {
  const name = handleTypedefName(t);
  if (t.captures.length === 0) {
    return `typedef struct ${name} { char _placeholder; } ${name};`;
  }
  const fields = t.captures
    .map(c => `${cTypeFor(c.ty)} cap_${c.name};`)
    .join(" ");
  return `typedef struct ${name} { ${fields} } ${name};`;
}

function cTypeFor(t: Type): string {
  if (isMultiElement(t)) return "mtoc2_tensor_t";
  if (isHandle(t)) return handleTypedefName(t);
  if (t.kind === "Struct") return structTypedefName(t);
  if (t.kind === "Class") return classTypedefName(t);
  return "double";
}

/** Default initializer for a freshly-declared local of `ty`. Scalars
 *  default to `0.0`; handles default to a zero-initialized struct. */
function defaultInitFor(ty: Type): string {
  if (isHandle(ty)) return `(${handleTypedefName(ty)}){0}`;
  return "0.0";
}

/** Per-owned-kind helper-name family. Tensors use the global
 *  `mtoc2_tensor_*` runtime snippet names; structs and classes use
 *  their program-emitted `<typedef>_*` family. Pure POD owned isn't
 *  a thing — every owned type has all four helpers. */
interface OwnedHelpers {
  empty: string;
  assign: string;
  copy: string;
  free: string;
  /** When true, `assign`/`copy`/`free` are loaded from the runtime
   *  snippet registry. When false, they're emitted directly into the
   *  generated C by `emitNamedTypedef` and need no `useRuntimeByName`
   *  activation. */
  isRuntime: boolean;
}

function ownedHelpersFor(t: Type): OwnedHelpers {
  if (isMultiElement(t)) {
    return {
      empty: "mtoc2_tensor_empty",
      assign: "mtoc2_tensor_assign",
      copy: "mtoc2_tensor_copy",
      free: "mtoc2_tensor_free",
      isRuntime: true,
    };
  }
  if (t.kind === "Struct") {
    const name = structTypedefName(t);
    return {
      empty: `${name}_empty`,
      assign: `${name}_assign`,
      copy: `${name}_copy`,
      free: `${name}_free`,
      isRuntime: false,
    };
  }
  if (t.kind === "Class") {
    const name = classTypedefName(t);
    return {
      empty: `${name}_empty`,
      assign: `${name}_assign`,
      copy: `${name}_copy`,
      free: `${name}_free`,
      isRuntime: false,
    };
  }
  throw new Error(`ownedHelpersFor: non-owned type ${typeToString(t)}`);
}

function activateOwnedRuntime(t: Type, state: RuntimeState): void {
  const h = ownedHelpersFor(t);
  if (h.isRuntime) {
    useRuntimeByName(state, h.empty);
    useRuntimeByName(state, h.assign);
    useRuntimeByName(state, h.copy);
    useRuntimeByName(state, h.free);
  }
}

function fnRetType(fn: IRFunc): string {
  if (fn.outputs.length === 0) return "void";
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

/** Walk the body and collect every owned local that needs a top-of-
 *  function predeclaration. Any Assign whose LHS is `isOwned(ty)`
 *  marks the name with its type (the type drives which helper family
 *  to use for `_empty()` / `_free()`). Walks through If / While /
 *  For bodies — owned locals declared inside a block still live in
 *  the surrounding function's stack frame (every local declaration
 *  is hoisted to function top to keep the free-on-exit walk
 *  simple). */
function collectOwnedLocals(stmts: IRStmt[]): { cName: string; ty: Type }[] {
  const seen = new Map<string, Type>();
  const order: string[] = [];
  const visit = (ss: IRStmt[]): void => {
    for (const s of ss) {
      switch (s.kind) {
        case "Assign":
          if (isOwned(s.ty) && !seen.has(s.cName)) {
            seen.set(s.cName, s.ty);
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
  return order.map(cName => ({ cName, ty: seen.get(cName)! }));
}

function emitFunction(fn: IRFunc, state: RuntimeState): string {
  const lines: string[] = [];
  const retType = fnRetType(fn);
  const isVoidFn = fn.outputs.length === 0;
  lines.push(irFuncDocComment(fn));
  lines.push(`static ${retType} ${fn.cName}(${fnParamList(fn)}) {`);
  // Pre-declare the scalar/tensor output slot (skip for void functions).
  const cOut = isVoidFn ? null : fn.cOutputs[0];
  const outTy = isVoidFn ? null : fn.outputTypes[0];
  const paramNames = new Set(fn.cParams);
  if (cOut !== null && !paramNames.has(cOut)) {
    if (outTy && isOwned(outTy)) {
      activateOwnedRuntime(outTy, state);
      const h = ownedHelpersFor(outTy);
      lines.push(`  ${cTypeFor(outTy)} ${cOut} = ${h.empty}();`);
    } else if (outTy !== null) {
      lines.push(`  ${cTypeFor(outTy)} ${cOut} = ${defaultInitFor(outTy)};`);
    } else {
      lines.push(`  double ${cOut} = 0.0;`);
    }
  }
  // Pre-declare owned locals (excluding the output, which we already
  // handled above).
  const owned = collectOwnedLocals(fn.body).filter(o => o.cName !== cOut);
  for (const o of owned) {
    activateOwnedRuntime(o.ty, state);
    const h = ownedHelpersFor(o.ty);
    lines.push(`  ${cTypeFor(o.ty)} ${o.cName} = ${h.empty}();`);
  }
  const ownedOutput =
    cOut !== null && outTy && isOwned(outTy)
      ? { cName: cOut, ty: outTy }
      : null;
  const futureTouches = computeFutureTouches(fn.body, ownedOutput);
  const fnOwnedTypes = new Map<string, Type>();
  for (const o of owned) fnOwnedTypes.set(o.cName, o.ty);
  if (cOut !== null && outTy && isOwned(outTy)) {
    fnOwnedTypes.set(cOut, outTy);
  }
  // Owned-typed params: the caller wrapped them in `_copy` so the
  // callee owns its arg. Track them so early-free / scope-exit free
  // can pick the right helper. They're NOT pre-declared (the
  // function signature already declared them) but they ARE freed at
  // scope exit.
  const ownedParams: { cName: string; ty: Type }[] = [];
  for (let i = 0; i < fn.cParams.length; i++) {
    const pTy = fn.paramTypes[i];
    if (isOwned(pTy)) {
      ownedParams.push({ cName: fn.cParams[i], ty: pTy });
      fnOwnedTypes.set(fn.cParams[i], pTy);
    }
  }
  const bodyText = emitBody(fn.body, "  ", state, futureTouches, fnOwnedTypes);
  if (bodyText.length > 0) lines.push(bodyText);
  const hasRet = bodyHasReturn(fn.body);
  if (hasRet) lines.push(`mtoc2_return:`);
  // Scope-exit frees: skip owned locals that nullAtScopeExit proves
  // are NULL on every reaching path (already early-freed).
  const scopeExitNames = new Set<string>([
    ...owned.map(o => o.cName),
    ...ownedParams.map(p => p.cName),
  ]);
  const fnNullAtExit = nullAtScopeExit(fn.body, scopeExitNames, futureTouches);
  for (const o of [...owned, ...ownedParams]) {
    if (fnNullAtExit.has(o.cName)) continue;
    // Skip freeing the output — it's the value we're returning.
    if (o.cName === cOut) continue;
    activateOwnedRuntime(o.ty, state);
    const h = ownedHelpersFor(o.ty);
    lines.push(`  ${h.free}(&${o.cName});`);
  }
  if (isVoidFn) {
    // `return;` is implicit at function end, but emit it when there's a
    // `goto mtoc2_return;` label so the label can't sit at the close
    // brace (which would be a syntax error in C).
    if (hasRet) lines.push(`  return;`);
  } else {
    lines.push(`  return ${cOut};`);
  }
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

/** Emit a sequence of statements with their per-stmt early-frees.
 *  After each stmt, owned C-names that aren't in the stmt's
 *  futureTouchOut (i.e. their last use was at this stmt) get a
 *  `<owned-kind>_free(&v);` call dispatched on the variable's
 *  recorded owned type. Scope-exit frees still emit unconditionally
 *  — they're no-ops for buffers already nulled by the early-free. */
function emitBody(
  stmts: IRStmt[],
  indent: string,
  state: RuntimeState,
  futureTouches: FutureTouchMap,
  ownedTypes: ReadonlyMap<string, Type>
): string {
  const out: string[] = [];
  for (const s of stmts) {
    const header = irStmtHeader(s);
    if (header !== null) {
      out.push(`${indent}/* ${header} */`);
    }
    const line = emitStmt(s, indent, state, futureTouches, ownedTypes);
    if (line !== null) out.push(line);
    const freeNames = earlyFreeCandidates(s, futureTouches);
    for (const v of freeNames) {
      const ty = ownedTypes.get(v);
      if (ty === undefined) {
        throw new Error(
          `emit: early-free of '${v}' but no owned type recorded`
        );
      }
      activateOwnedRuntime(ty, state);
      const h = ownedHelpersFor(ty);
      out.push(`${indent}${h.free}(&${v});`);
    }
  }
  return out.join("\n");
}

function emitStmt(
  s: IRStmt,
  indent: string,
  state: RuntimeState,
  futureTouches: FutureTouchMap,
  ownedTypes: ReadonlyMap<string, Type>
): string | null {
  switch (s.kind) {
    case "ExprStmt":
      return `${indent}${emitExpr(s.expr, state)};`;
    case "Assign": {
      if (isOwned(s.ty)) {
        activateOwnedRuntime(s.ty, state);
        const h = ownedHelpersFor(s.ty);
        const rhs = emitOwnedRhs(s.expr, state);
        return `${indent}${h.assign}(&${s.cName}, ${rhs});`;
      }
      const rhs = emitExpr(s.expr, state);
      if (s.declare) {
        return `${indent}${cTypeFor(s.ty)} ${s.cName} = ${rhs};`;
      }
      return `${indent}${s.cName} = ${rhs};`;
    }
    case "MemberStore": {
      const slot = [s.base.cName, ...s.fieldPath].join(".");
      if (isOwned(s.leafTy)) {
        activateOwnedRuntime(s.leafTy, state);
        const h = ownedHelpersFor(s.leafTy);
        const rhs = emitOwnedRhs(s.rhs, state);
        return `${indent}${h.assign}(&${slot}, ${rhs});`;
      }
      const rhs = emitExpr(s.rhs, state);
      return `${indent}${slot} = ${rhs};`;
    }
    case "If": {
      const lines: string[] = [];
      lines.push(`${indent}if (${emitExpr(s.cond, state)} != 0.0) {`);
      const thenText = emitBody(
        s.thenBody,
        indent + "  ",
        state,
        futureTouches,
        ownedTypes
      );
      if (thenText.length > 0) lines.push(thenText);
      if (s.elseBody.length > 0) {
        if (s.elseBody.length === 1 && s.elseBody[0].kind === "If") {
          const inner = emitStmt(
            s.elseBody[0],
            indent,
            state,
            futureTouches,
            ownedTypes
          );
          if (inner !== null)
            lines.push(`${indent}} else ${inner.trimStart()}`);
          else lines.push(`${indent}}`);
        } else {
          lines.push(`${indent}} else {`);
          const elseText = emitBody(
            s.elseBody,
            indent + "  ",
            state,
            futureTouches,
            ownedTypes
          );
          if (elseText.length > 0) lines.push(elseText);
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
      const bodyText = emitBody(
        s.body,
        indent + "  ",
        state,
        futureTouches,
        ownedTypes
      );
      if (bodyText.length > 0) lines.push(bodyText);
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
      const bodyText = emitBody(
        s.body,
        indent + "  ",
        state,
        futureTouches,
        ownedTypes
      );
      if (bodyText.length > 0) lines.push(bodyText);
      lines.push(`${indent}}`);
      return lines.join("\n");
    }
    case "ReturnFromFunction":
      return `${indent}goto mtoc2_return;`;
    case "Break":
      return `${indent}break;`;
    case "Continue":
      return `${indent}continue;`;
    case "TypeComment": {
      const lines = s.entries.map(
        e =>
          `${indent}/* type ${e.name} (${e.cName}) :: ${typeToString(e.ty)} */`
      );
      return lines.join("\n");
    }
  }
}

/** Owned-typed RHS for an Assign or MemberStore (or a Call arg that
 *  binds to an owned callee param). Every owned C value produced
 *  here is freshly-owned; the consumer's `_assign` helper releases
 *  the prior slot and consumes the rhs.
 *
 *  - `Var`        → `<type>_copy(name)` (deep copy)
 *  - `MemberLoad` → `<type>_copy(<base>.<field>)` (the load itself is
 *                   a struct-by-value read; we wrap it in copy so
 *                   the consumer gets a freshly-owned buffer)
 *  - anything else → `emitExpr` (TensorBuild / StructLit / Binary /
 *                    Call etc. already emit fresh-allocating
 *                    helpers) */
function emitOwnedRhs(e: IRExpr, state: RuntimeState): string {
  if (e.kind === "Var") {
    activateOwnedRuntime(e.ty, state);
    const h = ownedHelpersFor(e.ty);
    return `${h.copy}(${e.cName})`;
  }
  if (e.kind === "MemberLoad" && isOwned(e.ty)) {
    activateOwnedRuntime(e.ty, state);
    const h = ownedHelpersFor(e.ty);
    return `${h.copy}(${emitMemberLoadBare(e, state)})`;
  }
  return emitExpr(e, state);
}

/** Render a `MemberLoad` chain as a bare C field-access string, no
 *  copy wrapping. Used by `emitOwnedRhs` and inside `emitExpr` for
 *  non-owning contexts. */
function emitMemberLoadBare(
  e: Extract<IRExpr, { kind: "MemberLoad" }>,
  state: RuntimeState
): string {
  const baseStr =
    e.base.kind === "MemberLoad"
      ? emitMemberLoadBare(e.base, state)
      : emitExpr(e.base, state);
  return `${baseStr}.${e.field}`;
}

function emitExpr(e: IRExpr, state: RuntimeState): string {
  switch (e.kind) {
    case "NumLit":
      return formatDouble(e.value);
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
      // User function call: owned args wrap in copy (callee owns).
      const args = e.args
        .map(a => (isOwned(a.ty) ? emitOwnedRhs(a, state) : emitExpr(a, state)))
        .join(", ");
      return `${e.cName}(${args})`;
    }
    case "HandleLit": {
      // `(<typedef>){.cap_<name> = <value>, ...}` for capture-bearing
      // handles, or `(mtoc2_handle_empty_t){0}` for the no-capture
      // shared form. Captures are scalar real numeric (enforced at
      // lowering), so each value is a plain `double` C expression.
      if (e.ty.kind !== "Handle") {
        throw new Error("emit: HandleLit with non-Handle ty");
      }
      const cTy = handleTypedefName(e.ty);
      if (e.captures.length === 0) return `(${cTy}){0}`;
      const parts = e.captures.map(
        c => `.cap_${c.name} = ${emitExpr(c.value, state)}`
      );
      return `(${cTy}){${parts.join(", ")}}`;
    }
    case "HandleCaptureLoad":
      return `${e.base.cName}.cap_${e.captureName}`;
    case "StructLit": {
      if (e.ty.kind !== "Struct" && e.ty.kind !== "Class") {
        throw new Error(
          `emit: StructLit ty is ${e.ty.kind}, expected Struct or Class`
        );
      }
      const typedef =
        e.ty.kind === "Struct"
          ? structTypedefName(e.ty)
          : classTypedefName(e.ty);
      // Each field value is consumed by the freshly-allocated struct
      // — owned values must already be fresh producers (ANF
      // guarantees this for any non-Var owned RHS; a `Var` is wrapped
      // in copy here so the struct owns its own buffer copy).
      const parts = e.fields.map(f => {
        const v = isOwned(f.value.ty)
          ? emitOwnedRhs(f.value, state)
          : emitExpr(f.value, state);
        return `.${f.name} = ${v}`;
      });
      return `(${typedef}){${parts.join(", ")}}`;
    }
    case "MemberLoad":
      // Bare field-access read; the load passes the field by value.
      // Owned-typed reads at owned-consuming sites are wrapped in
      // `_copy` by emitOwnedRhs, not here. (Non-owning sites — e.g.
      // a tensor field passed to `disp` — pass the struct by value
      // and don't take ownership.)
      return emitMemberLoadBare(e, state);
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

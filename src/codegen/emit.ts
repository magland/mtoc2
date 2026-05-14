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
  isDimOne,
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
  specForHandle,
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

  // Struct / class / handle typedefs — one per distinct shape.
  // Emitted ahead of forward decls so user code can refer to them,
  // and in dependency-topological order so any typedef that references
  // another (a struct field of struct type, a handle capturing a
  // tensor's enclosing struct, a handle capturing another handle, ...)
  // is emitted after its dependency. Each typedef ships with its four
  // owned-kind helpers (and a `_disp` helper for structs).
  const namedTypedefs = collectNamedTypedefs(prog);
  for (const t of namedTypedefs) {
    const spec =
      t.kind === "Struct"
        ? specForStruct(t)
        : t.kind === "Class"
          ? specForClass(t)
          : specForHandle(t);
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

type NamedType = StructType | ClassType | HandleType;

/** Walk the program and collect every distinct named (struct / class /
 *  handle) typedef shape, returning them in dependency-topological
 *  order so any typedef that references another is emitted after its
 *  dependency. Recurses into field, property, and capture types so a
 *  transitively-used inner shape gets included even if the outer shape
 *  is the only thing the IR mentions directly. Also walks `HandleLit`
 *  capture value types — those drive the per-capture C field types
 *  even when the outer expression's `ty` is enough by itself. */
function collectNamedTypedefs(prog: IRProgram): NamedType[] {
  const seen = new Map<string, NamedType>();

  const innerTys = (t: NamedType): Type[] => {
    if (t.kind === "Struct") return t.fields.map(f => f.ty);
    if (t.kind === "Class") return t.properties.map(p => p.ty);
    return t.captures.map(c => c.ty);
  };

  const considerNamed = (t: Type | undefined): void => {
    if (t === undefined) return;
    let key: string;
    let named: NamedType;
    if (t.kind === "Struct") {
      key = structTypedefName(t);
      named = t;
    } else if (t.kind === "Class") {
      key = classTypedefName(t);
      named = t;
    } else if (t.kind === "Handle") {
      key = handleTypedefName(t);
      named = t;
    } else {
      return;
    }
    if (seen.has(key)) return;
    seen.set(key, named);
    for (const ity of innerTys(named)) considerNamed(ity);
  };

  const visitExpr = (e: IRExpr): void => {
    forEachSubExpr(e, sub => {
      considerNamed(sub.ty);
      if (sub.kind === "HandleLit") {
        for (const c of sub.captures) considerNamed(c.value.ty);
      }
    });
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

  return topoSortNamedTypedefs(Array.from(seen.values()), innerTys);
}

function namedTypedefKey(t: NamedType): string {
  if (t.kind === "Struct") return structTypedefName(t);
  if (t.kind === "Class") return classTypedefName(t);
  return handleTypedefName(t);
}

function topoSortNamedTypedefs(
  ts: NamedType[],
  innerTys: (t: NamedType) => Type[]
): NamedType[] {
  const byName = new Map<string, NamedType>();
  for (const t of ts) byName.set(namedTypedefKey(t), t);
  const visited = new Set<string>();
  const out: NamedType[] = [];
  const visit = (t: NamedType): void => {
    const name = namedTypedefKey(t);
    if (visited.has(name)) return;
    visited.add(name);
    for (const ity of innerTys(t)) {
      if (
        ity.kind === "Struct" ||
        ity.kind === "Class" ||
        ity.kind === "Handle"
      ) {
        const dep = byName.get(namedTypedefKey(ity));
        if (dep) visit(dep);
      }
    }
    out.push(t);
  };
  for (const t of ts) visit(t);
  return out;
}

function cTypeFor(t: Type): string {
  if (isMultiElement(t)) return "mtoc2_tensor_t";
  if (isHandle(t)) return handleTypedefName(t);
  if (t.kind === "Struct") return structTypedefName(t);
  if (t.kind === "Class") return classTypedefName(t);
  return "double";
}

/** Default initializer for a freshly-declared non-owned local. Owned
 *  types (tensors, structs, classes, handles) route through their
 *  `_empty()` helper instead and never hit this path; everything
 *  reaching here is scalar real numeric, so `0.0` always fits. */
function defaultInitFor(): string {
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
  if (t.kind === "Handle") {
    const name = handleTypedefName(t);
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
  // 0 outputs → C `void`. 1 output → classic return-by-value. N≥2
  // outputs → `void` return + out-pointer params (see `fnParamList`).
  if (fn.outputs.length !== 1) return "void";
  const t = fn.outputTypes[0];
  if (!t) return "double";
  return cTypeFor(t);
}

function fnParamList(fn: IRFunc): string {
  const parts: string[] = [];
  for (let i = 0; i < fn.cParams.length; i++) {
    parts.push(`${cTypeFor(fn.paramTypes[i])} ${fn.cParams[i]}`);
  }
  // Multi-output convention: append one `T_i *_mtoc2_o<i>` per output
  // after the user params, in declaration order. The body's sret
  // writes (emitted at every return point and at the function-end
  // fall-through) target these pointers.
  if (fn.outputs.length >= 2) {
    for (let i = 0; i < fn.outputs.length; i++) {
      const ty = fn.outputTypes[i] ?? { kind: "Unknown" as const };
      parts.push(`${cTypeFor(ty)} *_mtoc2_o${i}`);
    }
  }
  return parts.length === 0 ? "void" : parts.join(", ");
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
        case "MultiAssignCall":
          // Owned-typed N-output slot bindings need the same top-of-
          // function predeclaration treatment as ordinary owned
          // Assigns. v1 restricts slots to scalar real numeric, so
          // this loop is structurally a no-op today — kept for the
          // future-tensor-output extension.
          for (const slot of s.outputs) {
            if (
              slot.binding !== null &&
              isOwned(slot.ty) &&
              !seen.has(slot.binding.cName)
            ) {
              seen.set(slot.binding.cName, slot.ty);
              order.push(slot.binding.cName);
            }
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
  const nOutputs = fn.outputs.length;
  const isVoidFn = nOutputs === 0;
  const isMulti = nOutputs >= 2;
  lines.push(irFuncDocComment(fn));
  lines.push(`static ${retType} ${fn.cName}(${fnParamList(fn)}) {`);
  const paramNames = new Set(fn.cParams);
  // Pre-declare each declared output slot (skip any that share a
  // C-name with a param — a vacuous shadowing case kept for symmetry
  // with the existing single-output code path).
  const outputCNames = new Set<string>();
  for (let i = 0; i < nOutputs; i++) {
    const cOut = fn.cOutputs[i];
    const outTy = fn.outputTypes[i];
    outputCNames.add(cOut);
    if (paramNames.has(cOut)) continue;
    if (outTy && isOwned(outTy)) {
      activateOwnedRuntime(outTy, state);
      const h = ownedHelpersFor(outTy);
      lines.push(`  ${cTypeFor(outTy)} ${cOut} = ${h.empty}();`);
    } else if (outTy !== undefined) {
      lines.push(`  ${cTypeFor(outTy)} ${cOut} = ${defaultInitFor()};`);
    } else {
      lines.push(`  double ${cOut} = 0.0;`);
    }
  }
  // Pre-declare owned locals (excluding outputs, which we already
  // handled above).
  const owned = collectOwnedLocals(fn.body).filter(
    o => !outputCNames.has(o.cName)
  );
  for (const o of owned) {
    activateOwnedRuntime(o.ty, state);
    const h = ownedHelpersFor(o.ty);
    lines.push(`  ${cTypeFor(o.ty)} ${o.cName} = ${h.empty}();`);
  }
  // Single-output owned: keep the output alive through the body so
  // the future-touch analysis doesn't emit a stray early-free of the
  // value we're about to return. Multi-output and zero-output don't
  // need this — the sret writes / void return have no value being
  // carried out via the return statement itself.
  const ownedOutput =
    nOutputs === 1 &&
    fn.outputTypes[0] !== undefined &&
    isOwned(fn.outputTypes[0])
      ? { cName: fn.cOutputs[0], ty: fn.outputTypes[0] }
      : null;
  const futureTouches = computeFutureTouches(fn.body, ownedOutput);
  const fnOwnedTypes = new Map<string, Type>();
  for (const o of owned) fnOwnedTypes.set(o.cName, o.ty);
  for (let i = 0; i < nOutputs; i++) {
    const outTy = fn.outputTypes[i];
    if (outTy && isOwned(outTy)) {
      fnOwnedTypes.set(fn.cOutputs[i], outTy);
    }
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
  // Multi-output: write each output through its sret pointer. This
  // happens BEFORE the scope-exit free walk so the writes can read
  // the live locals before any tensor frees would zero them. For v1
  // outputs are scalar, but the ordering still matches mtoc's pattern.
  //
  // Defensive guard: an owned output slot would be both written via
  // `*_mtoc2_o${i} = <local>` (struct copy of the buffer pointer) AND
  // freed in the scope-exit walk below — the caller would then see
  // a dangling pointer and the next assign would double-free. The
  // lowerer rejects owned multi-output slots in v1, so this guard is
  // latent today; it surfaces a clear internal error if that
  // restriction is ever lifted without first fixing this codegen
  // path to transfer ownership (e.g. `*_mtoc2_o${i} = <local>;
  // <local> = <empty>();` so the scope-exit free is a no-op).
  if (isMulti) {
    for (let i = 0; i < nOutputs; i++) {
      if (isOwned(fn.outputTypes[i])) {
        throw new Error(
          `internal: multi-output owned slot at index ${i} of '${fn.name}' — codegen does not yet transfer ownership for N≥2 outputs (would double-free at scope exit)`
        );
      }
      lines.push(`  *_mtoc2_o${i} = ${fn.cOutputs[i]};`);
    }
  }
  // Scope-exit frees: skip owned locals that nullAtScopeExit proves
  // are NULL on every reaching path (already early-freed). Owned
  // params arrive freshly-owned from the caller — they are NOT null
  // at entry, so they MUST NOT be seeded into nullAtScopeExit's
  // entry set; doing so would let a body that never reassigns the
  // param keep the param in the null-set and skip its scope-exit
  // free, leaking the caller's `mtoc2_tensor_copy` allocation.
  const scopeExitNames = new Set<string>(owned.map(o => o.cName));
  const fnNullAtExit = nullAtScopeExit(fn.body, scopeExitNames, futureTouches);
  for (const o of [...owned, ...ownedParams]) {
    if (fnNullAtExit.has(o.cName)) continue;
    // Skip freeing the single-output return value — its buffer is
    // about to transfer to the caller via return-by-value.
    if (nOutputs === 1 && o.cName === fn.cOutputs[0]) continue;
    activateOwnedRuntime(o.ty, state);
    const h = ownedHelpersFor(o.ty);
    lines.push(`  ${h.free}(&${o.cName});`);
  }
  if (isVoidFn) {
    // `return;` is implicit at function end, but emit it when there's a
    // `goto mtoc2_return;` label so the label can't sit at the close
    // brace (which would be a syntax error in C).
    if (hasRet) lines.push(`  return;`);
  } else if (isMulti) {
    // Multi-output sret writes already emitted above; just `return;`.
    // Always emit it so the `mtoc2_return:` label (if present) has a
    // statement to head.
    lines.push(`  return;`);
  } else {
    lines.push(`  return ${fn.cOutputs[0]};`);
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
    case "IndexStore": {
      const offset = emitNdScalarOffset(state, s.indices, s.base.cName);
      const rhs = emitExpr(s.rhs, state);
      return `${indent}${s.base.cName}.real[${offset}] = ${rhs};`;
    }
    case "IndexSliceStore":
      return emitIndexSliceStore(s, indent, state);
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
      // MATLAB / numbl evaluate `start:step:end` ONCE at loop entry
      // (the range becomes a vector and the loop iterates over its
      // elements). To match: snapshot start/end into block-scoped
      // locals, derive the iteration count via `mtoc2_loop_count` so
      // it agrees with `mtoc2_tensor_make_range`'s formula, and use
      // `mtoc2_range_value` to apply the snap-to-end on the final
      // iteration. Without this, the body re-reads the live binding
      // for `end` every iteration — so e.g. `for k=1:n; n=100; end`
      // becomes a 100-iter loop instead of the MATLAB-correct 3.
      useRuntimeByName(state, "mtoc2_loop_count");
      useRuntimeByName(state, "mtoc2_range_value");
      const lines: string[] = [];
      const startC = emitExpr(s.start, state);
      const endC = emitExpr(s.end, state);
      const stepC = formatDouble(s.step);
      // Block-scope the snapshot temps so nested For loops don't
      // collide on the fixed `_mtoc2_for_*` names.
      lines.push(`${indent}{`);
      lines.push(`${indent}  const double _mtoc2_for_start = ${startC};`);
      lines.push(`${indent}  const double _mtoc2_for_end = ${endC};`);
      lines.push(
        `${indent}  const long _mtoc2_for_n = mtoc2_loop_count(_mtoc2_for_start, _mtoc2_for_end, ${stepC});`
      );
      lines.push(
        `${indent}  for (long _mtoc2_for_i = 0; _mtoc2_for_i < _mtoc2_for_n; _mtoc2_for_i++) {`
      );
      // The user may mutate the loop variable inside the body (the
      // next iteration overrides it), so it stays non-const.
      lines.push(
        `${indent}    double ${s.cVar} = mtoc2_range_value(_mtoc2_for_start, ${stepC}, _mtoc2_for_end, _mtoc2_for_n, _mtoc2_for_i);`
      );
      const bodyText = emitBody(
        s.body,
        indent + "    ",
        state,
        futureTouches,
        ownedTypes
      );
      if (bodyText.length > 0) lines.push(bodyText);
      lines.push(`${indent}  }`);
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
    case "MultiAssignCall": {
      // N≥2-output user-function call. Each named slot's `binding.cName`
      // is either already pre-declared at function top (for owned-typed
      // slots; v1 has none) or needs a one-shot `double <cName>;` here
      // when `declare` is true (scalar slots — the only kind in v1).
      // Ignored slots become `_mtoc2_discard_<callIdx>_<i>` locals
      // scoped to the call's `{}` block.
      //
      // Owned arg-copy uses the same `emitOwnedRhs` wrapping as a
      // regular `Call` so the callee owns its arg.
      const argStrs = s.args.map(a =>
        isOwned(a.ty) ? emitOwnedRhs(a, state) : emitExpr(a, state)
      );
      // Pre-declare any scalar named slot whose declare flag is set.
      // Owned-typed slots are predeclared at function top by the
      // collectOwnedLocals pass — skip them here.
      const preDecls: string[] = [];
      for (const slot of s.outputs) {
        if (
          slot.binding !== null &&
          slot.binding.declare &&
          !isOwned(slot.ty)
        ) {
          preDecls.push(
            `${indent}${cTypeFor(slot.ty)} ${slot.binding.cName} = ${defaultInitFor()};`
          );
        }
      }
      const callIdx = state.multiAssignCallCounter++;
      const out: string[] = [];
      for (const d of preDecls) out.push(d);
      out.push(`${indent}{`);
      const outArgs: string[] = [];
      for (let i = 0; i < s.outputs.length; i++) {
        const slot = s.outputs[i];
        if (slot.binding === null) {
          const tmp = `_mtoc2_discard_${callIdx}_${i}`;
          if (isOwned(slot.ty)) {
            // (Unreachable in v1; kept for the future-tensor-output
            // extension.) Initialize the discard temp to an empty
            // handle so the callee's `_assign` sees a freeable slot.
            activateOwnedRuntime(slot.ty, state);
            const h = ownedHelpersFor(slot.ty);
            out.push(`${indent}  ${cTypeFor(slot.ty)} ${tmp} = ${h.empty}();`);
          } else {
            out.push(
              `${indent}  ${cTypeFor(slot.ty)} ${tmp} = ${defaultInitFor()};`
            );
          }
          outArgs.push(`&${tmp}`);
        } else {
          outArgs.push(`&${slot.binding.cName}`);
        }
      }
      const callArgs = [...argStrs, ...outArgs].join(", ");
      out.push(`${indent}  ${s.cName}(${callArgs});`);
      // Release any owned discard temps before closing the block.
      // (Unreachable in v1; for symmetry with the future extension.)
      for (let i = 0; i < s.outputs.length; i++) {
        const slot = s.outputs[i];
        if (slot.binding === null && isOwned(slot.ty)) {
          activateOwnedRuntime(slot.ty, state);
          const h = ownedHelpersFor(slot.ty);
          out.push(`${indent}  ${h.free}(&_mtoc2_discard_${callIdx}_${i});`);
        }
      }
      out.push(`${indent}}`);
      return out.join("\n");
    }
  }
}

/** Owned-typed RHS for an Assign or MemberStore (or a Call arg that
 *  binds to an owned callee param). Every owned C value produced
 *  here is freshly-owned; the consumer's `_assign` helper releases
 *  the prior slot and consumes the rhs.
 *
 *  - `Var`               → `<type>_copy(name)` (deep copy)
 *  - `MemberLoad`        → `<type>_copy(<base>.<field>)` (the load
 *                          itself is a struct-by-value read; we wrap
 *                          it in copy so the consumer gets a freshly-
 *                          owned buffer)
 *  - `HandleCaptureLoad` → `<type>_copy(<base>.cap_<name>)` (same
 *                          rationale — the handle's capture slot is
 *                          read by value and we copy it for the
 *                          consumer)
 *  - anything else       → `emitExpr` (TensorBuild / StructLit /
 *                          HandleLit / Binary / Call etc. already
 *                          emit fresh-allocating helpers) */
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
  if (e.kind === "HandleCaptureLoad" && isOwned(e.ty)) {
    activateOwnedRuntime(e.ty, state);
    const h = ownedHelpersFor(e.ty);
    return `${h.copy}(${e.base.cName}.cap_${e.captureName})`;
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
    case "StringLit":
      // Today only consumed by reducer builtins, whose `codegenC`
      // drops the slot before emitting the C call. Render as a C
      // string literal so the bare expression still compiles if it
      // somehow reaches a site that doesn't filter (e.g. future
      // builtins that DO pass strings through).
      return JSON.stringify(e.value);
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
      // Lowerer-synthesized bare-`toc;` print form. Not registered as
      // a public builtin (the registry only knows about value-returning
      // `toc`); the lowerer routes here for ExprStmt-position calls.
      // Activate the tic/toc runtime snippet so `mtoc2_toc_print` is
      // declared.
      if (e.name === "toc_print" && e.cName === "mtoc2_toc_print") {
        useRuntimeByName(state, "mtoc2_tic_toc");
        return `mtoc2_toc_print()`;
      }
      // User function call: owned args wrap in copy (callee owns).
      const args = e.args
        .map(a => (isOwned(a.ty) ? emitOwnedRhs(a, state) : emitExpr(a, state)))
        .join(", ");
      return `${e.cName}(${args})`;
    }
    case "HandleLit": {
      // No-capture handles share the placeholder typedef and call
      // through its `_empty()` to mirror the struct/class lifecycle.
      // Capture-bearing handles emit a designated initializer; each
      // owned-typed capture value is routed through `emitOwnedRhs`
      // so a Var read of the enclosing scope's binding wraps in
      // `<innerTypedef>_copy`, giving the handle struct its own
      // freshly-owned snapshot (MATLAB by-value capture semantics).
      if (e.ty.kind !== "Handle") {
        throw new Error("emit: HandleLit with non-Handle ty");
      }
      const cTy = handleTypedefName(e.ty);
      if (e.captures.length === 0) {
        activateOwnedRuntime(e.ty, state);
        return `${cTy}_empty()`;
      }
      const parts = e.captures.map(c => {
        const v = isOwned(c.value.ty)
          ? emitOwnedRhs(c.value, state)
          : emitExpr(c.value, state);
        return `.cap_${c.name} = ${v}`;
      });
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
    case "IndexLoad": {
      const offset = emitNdScalarOffset(state, e.indices, e.base.cName);
      return `${e.base.cName}.real[${offset}]`;
    }
    case "IndexSlice":
      return emitIndexSliceProducer(e, state);
    case "EndRef":
      if (e.axis === "linear") {
        if (e.baseTy.kind === "Numeric" && e.baseTy.shape !== undefined) {
          const n = e.baseTy.shape.reduce((a, b) => a * b, 1);
          return formatDouble(n);
        }
        if (e.baseTy.kind === "Numeric") {
          const parts: string[] = [];
          for (let i = 0; i < e.baseTy.dims.length; i++) {
            parts.push(`${e.baseCName}.dims[${i}]`);
          }
          return `(double)(${parts.join(" * ")})`;
        }
        throw new Error("emit: EndRef with non-numeric baseTy");
      }
      // Per-axis form.
      if (e.baseTy.kind === "Numeric" && e.baseTy.shape !== undefined) {
        return formatDouble(e.baseTy.shape[e.axis]);
      }
      return `(double)${e.baseCName}.dims[${e.axis}]`;
    case "MakeRange":
      return emitMakeRange(e, state);
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

/** Compute the column-major linear buffer offset for a scalar
 *  IndexLoad / IndexStore: 1-arg linear, 2-arg row/col, or N-arg N-D.
 *  Each axis index is wrapped in a runtime bounds-check call
 *  (`mtoc2_idx_axis` for per-axis; `mtoc2_idx_lin` for 1-arg linear)
 *  so an OOB access aborts with a numbl-style "Index exceeds array
 *  bounds" message instead of silently reading/writing past the
 *  buffer. Mirrors mtoc's `emitNdScalarOffset` — one source of truth
 *  for the offset formula. */
function emitNdScalarOffset(
  state: RuntimeState,
  indices: ReadonlyArray<IRExpr>,
  baseCName: string
): string {
  useRuntimeByName(state, "mtoc2_oob_abort");
  if (indices.length === 1) {
    const loc = locStringOf(indices[0].span);
    return `mtoc2_idx_lin(&${baseCName}, (long)(${emitExpr(indices[0], state)}), ${loc})`;
  }
  const terms: string[] = [];
  for (let i = 0; i < indices.length; i++) {
    const loc = locStringOf(indices[i].span);
    const checked = `mtoc2_idx_axis(&${baseCName}, ${i}, (long)(${emitExpr(indices[i], state)}), ${loc})`;
    if (i === 0) {
      terms.push(checked);
    } else {
      const strideParts: string[] = [];
      for (let j = 0; j < i; j++) strideParts.push(`${baseCName}.dims[${j}]`);
      terms.push(`${checked} * ${strideParts.join(" * ")}`);
    }
  }
  return terms.join(" + ");
}

/** Format a Span as a quoted "<file>:<offset>" string literal for
 *  passing to a runtime helper. The file path is JSON-escaped (the
 *  emitter already requires a single C-string-safe form), and the
 *  offset is the byte offset of the violating expression — matches
 *  the format used by translate-time `UnsupportedConstruct` errors,
 *  so the user sees a familiar location for runtime OOB too. */
function locStringOf(span: { file: string; start: number }): string {
  return `${JSON.stringify(`${span.file}:offset ${span.start}`)}`;
}

/** Compute the column-major linear offset for an N-D access given
 *  per-axis source terms and a stride source. */
function formatNdOffset(
  terms: ReadonlyArray<string>,
  stride: (axisIndex: number) => string
): string {
  if (terms.length === 0) return "0";
  const out: string[] = [];
  for (let i = 0; i < terms.length; i++) {
    if (i === 0) {
      out.push(terms[i]);
    } else {
      const strideParts: string[] = [];
      for (let j = 0; j < i; j++) strideParts.push(stride(j));
      out.push(`${terms[i]} * ${strideParts.join(" * ")}`);
    }
  }
  return out.join(" + ");
}

/** Emit per-slot setup for a multi-slot slice (read or write): pushes
 *  `_mtoc2_n_<i>` (per-slot iteration count) and any Range / Scalar
 *  locals into `lines`. Returns the per-slot source-index expression
 *  (in terms of `_mtoc2_k_<i>` for Colon/Range, or the precomputed
 *  `_mtoc2_src_<i>` local for Scalar slots). */
function emitSliceSlotSetup(
  state: RuntimeState,
  lines: string[],
  indent: string,
  slots: ReadonlyArray<IRExpr extends never ? never : { kind: string }>,
  slotsTyped: ReadonlyArray<import("../lowering/ir.js").IndexSliceArg>,
  baseCName: string
): string[] {
  void slots;
  const slotSrc: string[] = [];
  for (let i = 0; i < slotsTyped.length; i++) {
    const slot = slotsTyped[i];
    const kVar = `_mtoc2_k_${i}`;
    if (slot.kind === "Colon") {
      lines.push(`${indent}long _mtoc2_n_${i} = ${baseCName}.dims[${i}];`);
      slotSrc.push(kVar);
    } else if (slot.kind === "Scalar") {
      // Per-axis bounds check at setup time. Same `mtoc2_idx_axis`
      // helper used by scalar IndexLoad / IndexStore — aborts with
      // a numbl-style "Index in position N exceeds array bounds".
      useRuntimeByName(state, "mtoc2_oob_abort");
      const scalarStr = emitExpr(slot.expr, state);
      const loc = locStringOf(slot.span);
      lines.push(`${indent}long _mtoc2_n_${i} = 1;`);
      lines.push(
        `${indent}long _mtoc2_src_${i} = mtoc2_idx_axis(&${baseCName}, ${i}, (long)(${scalarStr}), ${loc});`
      );
      slotSrc.push(`_mtoc2_src_${i}`);
    } else {
      if (slot.step.kind !== "NumLit") {
        throw new Error(
          "emit internal: IndexSlice range step must be a NumLit; " +
            "should have been caught at lowering"
        );
      }
      // Range-slot bounds check: validate first and last 1-based
      // indices once at setup time. The per-iter index expression
      // doesn't need its own check — `mtoc2_loop_count` derives `n`
      // monotonically from start/end/step, so the iteration stays
      // within `[first, last]`.
      useRuntimeByName(state, "mtoc2_loop_count");
      useRuntimeByName(state, "mtoc2_oob_abort");
      const startStr = emitExpr(slot.start, state);
      const endStr = emitExpr(slot.end, state);
      const stepStr = formatDouble(slot.step.value);
      const loc = locStringOf(slot.span);
      lines.push(`${indent}double _mtoc2_start_${i} = ${startStr};`);
      lines.push(`${indent}double _mtoc2_end_${i} = ${endStr};`);
      lines.push(
        `${indent}long _mtoc2_n_${i} = mtoc2_loop_count(_mtoc2_start_${i}, _mtoc2_end_${i}, ${stepStr});`
      );
      // Skip the bounds check on an empty range — the loop won't run
      // and validating an out-of-range start/end would reject benign
      // cases like `v(5:4)` on a 3-element vector (which yields an
      // empty slice in MATLAB).
      lines.push(`${indent}if (_mtoc2_n_${i} > 0) {`);
      lines.push(
        `${indent}  long _mtoc2_first_${i} = (long)_mtoc2_start_${i};`
      );
      lines.push(
        `${indent}  long _mtoc2_last_${i} = (long)(_mtoc2_start_${i} + ${stepStr} * (double)(_mtoc2_n_${i} - 1));`
      );
      lines.push(
        `${indent}  mtoc2_check_axis_range(&${baseCName}, ${i}, _mtoc2_first_${i}, _mtoc2_last_${i}, ${loc});`
      );
      lines.push(`${indent}}`);
      slotSrc.push(
        `((long)(_mtoc2_start_${i} + ${stepStr} * (double)${kVar}) - 1L)`
      );
    }
  }
  return slotSrc;
}

/** Emit an `IndexSlice` as a C statement-expression-style block that
 *  allocates the result tensor, fills it, and evaluates to the result
 *  via a comma expression. The result is consumed at an owned consume
 *  site (`mtoc2_tensor_assign(&v, <here>)`); ANF guarantees IndexSlice
 *  appears only as the direct RHS of an Assign. */
function emitIndexSliceProducer(
  e: Extract<IRExpr, { kind: "IndexSlice" }>,
  state: RuntimeState
): string {
  // Generate via a GCC/Clang statement-expression. This keeps the
  // IndexSlice producer self-contained at the expression site without
  // requiring out-of-line statements.
  useRuntimeByName(state, "mtoc2_tensor_t");
  useRuntimeByName(state, "mtoc2_tensor_alloc_nd");
  const baseCName = e.base.cName;
  const lines: string[] = [];

  if (e.index.length === 1) {
    // Single-slot linear form.
    const slot = e.index[0];
    let count: string;
    let srcIndexFor: (kVar: string) => string;
    let resultRows: string;
    let resultCols: string;
    if (slot.kind === "Colon") {
      const parts: string[] = [];
      if (e.base.ty.kind === "Numeric") {
        for (let i = 0; i < e.base.ty.dims.length; i++) {
          parts.push(`${baseCName}.dims[${i}]`);
        }
      }
      lines.push(`long _mtoc2_n = ${parts.join(" * ")};`);
      count = "_mtoc2_n";
      srcIndexFor = k => k;
      resultRows = "_mtoc2_n";
      resultCols = "1";
    } else if (slot.kind === "Range") {
      if (slot.step.kind !== "NumLit") {
        throw new Error("emit internal: index-slot Range step must be NumLit");
      }
      useRuntimeByName(state, "mtoc2_loop_count");
      useRuntimeByName(state, "mtoc2_oob_abort");
      const startStr = emitExpr(slot.start, state);
      const endStr = emitExpr(slot.end, state);
      const stepStr = formatDouble(slot.step.value);
      const loc = locStringOf(slot.span);
      lines.push(`double _mtoc2_start = ${startStr};`);
      lines.push(`double _mtoc2_end = ${endStr};`);
      lines.push(
        `long _mtoc2_n = mtoc2_loop_count(_mtoc2_start, _mtoc2_end, ${stepStr});`
      );
      // Single-slot range slice indexes linearly over numel(base),
      // not against a single axis dim — `v(2:10)` on a 4-element row
      // vector is OOB regardless of `dims[0]`. Skip the check on an
      // empty range (MATLAB allows `v(5:4)` to yield 1×0).
      lines.push(`if (_mtoc2_n > 0) {`);
      lines.push(`  long _mtoc2_first = (long)_mtoc2_start;`);
      lines.push(
        `  long _mtoc2_last = (long)(_mtoc2_start + ${stepStr} * (double)(_mtoc2_n - 1));`
      );
      lines.push(
        `  mtoc2_check_linear_range(&${baseCName}, _mtoc2_first, _mtoc2_last, ${loc});`
      );
      lines.push(`}`);
      count = "_mtoc2_n";
      srcIndexFor = k =>
        `(long)(_mtoc2_start + ${stepStr} * (double)${k}) - 1L`;
      // Single-slot range: row-vec → row, col-vec → col, matrix/N-D → row.
      const isColVec =
        e.base.ty.kind === "Numeric" &&
        e.base.ty.dims.length === 2 &&
        e.base.ty.dims[0].kind === "exact" &&
        e.base.ty.dims[0].value > 1 &&
        isDimOne(e.base.ty.dims[1]);
      if (isColVec) {
        resultRows = "_mtoc2_n";
        resultCols = "1";
      } else {
        resultRows = "1";
        resultCols = "_mtoc2_n";
      }
    } else {
      throw new Error(
        "emit internal: single-slot Scalar IndexSlice should have routed to IndexLoad"
      );
    }
    lines.push(
      `mtoc2_tensor_t _mtoc2_t = mtoc2_tensor_alloc_nd(2, (long[]){${resultRows}, ${resultCols}});`
    );
    lines.push(`for (long _mtoc2_k = 0; _mtoc2_k < ${count}; _mtoc2_k++) {`);
    lines.push(
      `  _mtoc2_t.real[_mtoc2_k] = ${baseCName}.real[${srcIndexFor("_mtoc2_k")}];`
    );
    lines.push(`}`);
    lines.push(`_mtoc2_t;`);
    return `({ ${lines.join(" ")} })`;
  }

  // Multi-slot per-axis form.
  const ndim = e.index.length;
  const slotSrc = emitSliceSlotSetup(state, lines, "", [], e.index, baseCName);
  const resultRank =
    e.ty.kind === "Numeric" ? Math.max(2, e.ty.dims.length) : 2;
  const dimsList: string[] = [];
  for (let i = 0; i < resultRank; i++) {
    dimsList.push(i < ndim ? `_mtoc2_n_${i}` : `1L`);
  }
  lines.push(
    `mtoc2_tensor_t _mtoc2_t = mtoc2_tensor_alloc_nd(${resultRank}, (long[]){${dimsList.join(", ")}});`
  );
  for (let i = ndim - 1; i >= 0; i--) {
    lines.push(
      `for (long _mtoc2_k_${i} = 0; _mtoc2_k_${i} < _mtoc2_n_${i}; _mtoc2_k_${i}++) {`
    );
  }
  lines.push(
    `long _mtoc2_src_off = ${formatNdOffset(slotSrc, j => `${baseCName}.dims[${j}]`)};`
  );
  lines.push(
    `long _mtoc2_dst_off = ${formatNdOffset(
      Array.from({ length: ndim }, (_, i) => `_mtoc2_k_${i}`),
      j => `_mtoc2_n_${j}`
    )};`
  );
  lines.push(
    `_mtoc2_t.real[_mtoc2_dst_off] = ${baseCName}.real[_mtoc2_src_off];`
  );
  for (let i = ndim - 1; i >= 0; i--) {
    lines.push(`}`);
  }
  lines.push(`_mtoc2_t;`);
  return `({ ${lines.join(" ")} })`;
}

/** Emit an `IndexSliceStore` statement: mutate `base` in place. */
function emitIndexSliceStore(
  s: Extract<IRStmt, { kind: "IndexSliceStore" }>,
  indent: string,
  state: RuntimeState
): string {
  const baseCName = s.base.cName;
  const rhsIsScalar =
    s.rhs.ty.kind === "Numeric" && s.rhs.ty.dims.every(isDimOne);
  const lines: string[] = [];
  lines.push(`${indent}{`);

  if (s.index.length === 1) {
    const slot = s.index[0];
    let dstOffsetFor: (kVar: string) => string;
    if (slot.kind === "Colon") {
      const parts: string[] = [];
      if (s.base.ty.kind === "Numeric") {
        for (let i = 0; i < s.base.ty.dims.length; i++) {
          parts.push(`${baseCName}.dims[${i}]`);
        }
      }
      lines.push(`${indent}  long _mtoc2_n = ${parts.join(" * ")};`);
      dstOffsetFor = k => k;
    } else if (slot.kind === "Range") {
      if (slot.step.kind !== "NumLit") {
        throw new Error("emit internal: index-slot Range step must be NumLit");
      }
      useRuntimeByName(state, "mtoc2_loop_count");
      useRuntimeByName(state, "mtoc2_oob_abort");
      const startStr = emitExpr(slot.start, state);
      const endStr = emitExpr(slot.end, state);
      const stepStr = formatDouble(slot.step.value);
      const loc = locStringOf(slot.span);
      lines.push(`${indent}  double _mtoc2_start = ${startStr};`);
      lines.push(`${indent}  double _mtoc2_end = ${endStr};`);
      lines.push(
        `${indent}  long _mtoc2_n = mtoc2_loop_count(_mtoc2_start, _mtoc2_end, ${stepStr});`
      );
      // Linear-form bounds check (single-slot range slice writes
      // index linearly over numel(base)). Skip the check on an
      // empty range to allow `v(5:4) = []`-style no-ops.
      lines.push(`${indent}  if (_mtoc2_n > 0) {`);
      lines.push(`${indent}    long _mtoc2_first = (long)_mtoc2_start;`);
      lines.push(
        `${indent}    long _mtoc2_last = (long)(_mtoc2_start + ${stepStr} * (double)(_mtoc2_n - 1));`
      );
      lines.push(
        `${indent}    mtoc2_check_linear_range(&${baseCName}, _mtoc2_first, _mtoc2_last, ${loc});`
      );
      lines.push(`${indent}  }`);
      dstOffsetFor = k =>
        `(long)(_mtoc2_start + ${stepStr} * (double)${k}) - 1L`;
    } else {
      throw new Error(
        "emit internal: single-slot Scalar IndexSliceStore should have routed to IndexStore"
      );
    }

    if (rhsIsScalar) {
      const rhsExpr = emitExpr(s.rhs, state);
      lines.push(`${indent}  double _mtoc2_rhs = ${rhsExpr};`);
      lines.push(
        `${indent}  for (long _mtoc2_k = 0; _mtoc2_k < _mtoc2_n; _mtoc2_k++) {`
      );
      lines.push(`${indent}    long _mtoc2_dst = ${dstOffsetFor("_mtoc2_k")};`);
      lines.push(`${indent}    ${baseCName}.real[_mtoc2_dst] = _mtoc2_rhs;`);
      lines.push(`${indent}  }`);
    } else {
      if (s.rhs.kind !== "Var") {
        throw new Error(
          `emit internal: IndexSliceStore tensor RHS must be a Var (got ${s.rhs.kind})`
        );
      }
      const rhsCName = s.rhs.cName;
      const rhsTy = s.rhs.ty;
      const rhsParts: string[] = [];
      if (rhsTy.kind === "Numeric") {
        for (let i = 0; i < rhsTy.dims.length; i++) {
          rhsParts.push(`${rhsCName}.dims[${i}]`);
        }
      }
      lines.push(`${indent}  long _mtoc2_rhs_n = ${rhsParts.join(" * ")};`);
      lines.push(`${indent}  if (_mtoc2_n != _mtoc2_rhs_n) {`);
      lines.push(
        `${indent}    fprintf(stderr, "mtoc2: Subscripted assignment dimension mismatch (lhs slice has %ld elements, rhs has %ld)\\n", _mtoc2_n, _mtoc2_rhs_n);`
      );
      // exit(1) rather than abort(): abort raises SIGABRT, which
      // spawnSync surfaces as `signal` instead of `status`, so the
      // CLI's `process.exit(run.status ?? 0)` would report a clean
      // run despite the diagnostic. exit(1) gives a non-zero status
      // the cross-runner sees.
      lines.push(`${indent}    exit(1);`);
      lines.push(`${indent}  }`);
      lines.push(
        `${indent}  for (long _mtoc2_k = 0; _mtoc2_k < _mtoc2_n; _mtoc2_k++) {`
      );
      lines.push(`${indent}    long _mtoc2_dst = ${dstOffsetFor("_mtoc2_k")};`);
      lines.push(
        `${indent}    ${baseCName}.real[_mtoc2_dst] = ${rhsCName}.real[_mtoc2_k];`
      );
      lines.push(`${indent}  }`);
    }
    lines.push(`${indent}}`);
    return lines.join("\n");
  }

  // Multi-slot.
  const ndim = s.index.length;
  const slotDst = emitSliceSlotSetup(
    state,
    lines,
    `${indent}  `,
    [],
    s.index,
    baseCName
  );
  const totalParts: string[] = [];
  for (let i = 0; i < ndim; i++) totalParts.push(`_mtoc2_n_${i}`);
  lines.push(`${indent}  long _mtoc2_n = ${totalParts.join(" * ")};`);

  if (rhsIsScalar) {
    const rhsExpr = emitExpr(s.rhs, state);
    lines.push(`${indent}  double _mtoc2_rhs = ${rhsExpr};`);
  } else {
    if (s.rhs.kind !== "Var") {
      throw new Error(
        `emit internal: IndexSliceStore tensor RHS must be a Var (got ${s.rhs.kind})`
      );
    }
    const rhsCName = s.rhs.cName;
    const rhsTy = s.rhs.ty;
    const rhsParts: string[] = [];
    if (rhsTy.kind === "Numeric") {
      for (let i = 0; i < rhsTy.dims.length; i++) {
        rhsParts.push(`${rhsCName}.dims[${i}]`);
      }
    }
    lines.push(`${indent}  long _mtoc2_rhs_n = ${rhsParts.join(" * ")};`);
    lines.push(`${indent}  if (_mtoc2_n != _mtoc2_rhs_n) {`);
    lines.push(
      `${indent}    fprintf(stderr, "mtoc2: Subscripted assignment dimension mismatch (lhs slice has %ld elements, rhs has %ld)\\n", _mtoc2_n, _mtoc2_rhs_n);`
    );
    // exit(1), not abort() — see emitIndexSliceStore single-slot path
    // for rationale (CLI swallows SIGABRT).
    lines.push(`${indent}    exit(1);`);
    lines.push(`${indent}  }`);
  }

  for (let i = ndim - 1; i >= 0; i--) {
    const ind = "  ".repeat(ndim - 1 - i);
    lines.push(
      `${indent}  ${ind}for (long _mtoc2_k_${i} = 0; _mtoc2_k_${i} < _mtoc2_n_${i}; _mtoc2_k_${i}++) {`
    );
  }
  const innerInd = "  ".repeat(ndim);
  lines.push(
    `${indent}  ${innerInd}long _mtoc2_dst = ${formatNdOffset(slotDst, j => `${baseCName}.dims[${j}]`)};`
  );
  if (rhsIsScalar) {
    lines.push(
      `${indent}  ${innerInd}${baseCName}.real[_mtoc2_dst] = _mtoc2_rhs;`
    );
  } else {
    const rhs = s.rhs as Extract<IRExpr, { kind: "Var" }>;
    lines.push(
      `${indent}  ${innerInd}long _mtoc2_k = ${formatNdOffset(
        Array.from({ length: ndim }, (_, i) => `_mtoc2_k_${i}`),
        j => `_mtoc2_n_${j}`
      )};`
    );
    lines.push(
      `${indent}  ${innerInd}${baseCName}.real[_mtoc2_dst] = ${rhs.cName}.real[_mtoc2_k];`
    );
  }
  for (let i = ndim - 1; i >= 0; i--) {
    const ind = "  ".repeat(ndim - 1 - i);
    lines.push(`${indent}  ${ind}}`);
  }
  lines.push(`${indent}}`);
  return lines.join("\n");
}

/** Emit a `MakeRange` expression. Activates the runtime helper. */
function emitMakeRange(
  e: Extract<IRExpr, { kind: "MakeRange" }>,
  state: RuntimeState
): string {
  useRuntimeByName(state, "mtoc2_tensor_make_range");
  const startStr = emitExpr(e.start, state);
  const stepStr = emitExpr(e.step, state);
  const endStr = emitExpr(e.end, state);
  return `mtoc2_tensor_make_range(${startStr}, ${stepStr}, ${endStr})`;
}

// Suppress unused-import lints when narrower predicates aren't used.
void isNumeric;

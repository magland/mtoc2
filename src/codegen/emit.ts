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
  isScalar,
  scalarDouble,
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
  for (const o of collectHoistedScalarLocals(prog.topLevelStmts)) {
    userParts.push(`  ${cTypeFor(o.ty)} ${o.cName} = ${defaultInitFor()};`);
  }
  const mainFutureTouches = computeFutureTouches(prog.topLevelStmts);
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
  // Always emit scope-exit frees for every owned local. Early-frees
  // null out the buffer, and every owned `_free` helper bottoms out at
  // `free(NULL)` which is a no-op — so a scope-exit free of an already-
  // freed local is redundant but safe. The previous `nullAtScopeExit`
  // optimization tried to skip these frees, but it only modelled the
  // fall-through path to the function end and treated `return;` as
  // having no effect; that combination leaked owned locals along
  // every early-return path.
  for (const o of mainOwned) {
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
  if (t.kind === "String") return "mtoc2_string_t";
  if (t.kind === "Char") return "mtoc2_char_tensor_t";
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
  if (t.kind === "String") {
    return {
      empty: "mtoc2_string_empty",
      assign: "mtoc2_string_assign",
      copy: "mtoc2_string_copy",
      free: "mtoc2_string_free",
      isRuntime: true,
    };
  }
  if (t.kind === "Char") {
    return {
      empty: "mtoc2_char_tensor_empty",
      assign: "mtoc2_char_tensor_assign",
      copy: "mtoc2_char_tensor_copy",
      free: "mtoc2_char_tensor_free",
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

/** Walk the body and collect every non-owned local (scalars, including
 *  For loop vars and multi-assign slot bindings) so they can be
 *  pre-declared at function top with `double v = 0.0;`. Symmetric with
 *  `collectOwnedLocals`: every local is declared at function top, every
 *  Assign / loop-var rebinding is a plain `v = rhs;`. Without this,
 *  inner-block declarations would scope to the block and a later read
 *  (now reachable after the `mergeBranchEnvs` change that keeps
 *  partial-branch variables in scope) would reference an undeclared C
 *  variable. */
function collectHoistedScalarLocals(
  stmts: IRStmt[]
): { cName: string; ty: Type }[] {
  const seen = new Map<string, Type>();
  const order: string[] = [];
  const note = (cName: string, ty: Type): void => {
    if (isOwned(ty)) return;
    if (seen.has(cName)) return;
    seen.set(cName, ty);
    order.push(cName);
  };
  const visit = (ss: IRStmt[]): void => {
    for (const s of ss) {
      switch (s.kind) {
        case "Assign":
          note(s.cName, s.ty);
          break;
        case "MultiAssignCall":
          for (const slot of s.outputs) {
            if (slot.binding !== null) note(slot.binding.cName, slot.ty);
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
          // Loop var is intrinsic to the For node (declared by
          // `for (...) { double k = ...; ... }` in codegen); hoist it
          // so reads after the loop see the last iteration's value.
          note(s.cVar, scalarDouble());
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
  // Pre-declare owned locals (excluding outputs and params, both of
  // which are already declared elsewhere — outputs above, params in
  // the function signature). Without the paramNames filter, a body
  // that reassigns an owned param (`function f(xs); xs = xs(:); ...`)
  // would emit a duplicate `mtoc2_tensor_t xs = mtoc2_tensor_empty();`
  // and the C compiler would reject the redeclaration.
  const owned = collectOwnedLocals(fn.body).filter(
    o => !outputCNames.has(o.cName) && !paramNames.has(o.cName)
  );
  for (const o of owned) {
    activateOwnedRuntime(o.ty, state);
    const h = ownedHelpersFor(o.ty);
    lines.push(`  ${cTypeFor(o.ty)} ${o.cName} = ${h.empty}();`);
  }
  // Pre-declare non-owned locals (scalars, For loop vars, multi-assign
  // slot bindings) at function top. Symmetric with the owned-locals
  // pass above; ensures a later read of a variable first written inside
  // an If / While / For body (now reachable thanks to mergeBranchEnvs
  // keeping partial-branch keys) doesn't reference an out-of-scope C
  // local.
  const hoistedScalars = collectHoistedScalarLocals(fn.body).filter(
    o => !outputCNames.has(o.cName) && !paramNames.has(o.cName)
  );
  for (const o of hoistedScalars) {
    lines.push(`  ${cTypeFor(o.ty)} ${o.cName} = ${defaultInitFor()};`);
  }
  // Keep each owned output alive through the body so the future-touch
  // analysis doesn't emit a stray early-free of the value we're about
  // to return (single-output) or transfer via sret (multi-output).
  // Zero-output / scalar-only-output functions contribute nothing.
  const ownedOutputsForLiveness: { cName: string; ty: Type }[] = [];
  for (let i = 0; i < nOutputs; i++) {
    const outTy = fn.outputTypes[i];
    if (outTy !== undefined && isOwned(outTy)) {
      ownedOutputsForLiveness.push({ cName: fn.cOutputs[i], ty: outTy });
    }
  }
  const futureTouches = computeFutureTouches(fn.body, ownedOutputsForLiveness);
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
  // the live locals before any tensor frees would zero them.
  //
  // Scalar slots: bare struct copy (`*_mtoc2_o<i> = <local>`).
  // Owned slots: ownership transfer via the kind's `_assign` helper.
  // The helper releases the destination's prior contents (always
  // NULL on a freshly-empty slot from the caller, but `_assign` is
  // still the right shape — it leaves the local moved-out). The
  // local's scope-exit free is suppressed below; see the skip on
  // `outputCNames` in the free walk.
  if (isMulti) {
    for (let i = 0; i < nOutputs; i++) {
      const outTy = fn.outputTypes[i];
      if (outTy && isOwned(outTy)) {
        activateOwnedRuntime(outTy, state);
        const h = ownedHelpersFor(outTy);
        lines.push(`  ${h.assign}(_mtoc2_o${i}, ${fn.cOutputs[i]});`);
      } else {
        lines.push(`  *_mtoc2_o${i} = ${fn.cOutputs[i]};`);
      }
    }
  }
  // Always emit scope-exit frees for every owned local and owned
  // param. Early-frees null out the buffer, and every owned `_free`
  // helper is NULL-safe, so scope-exit frees of already-freed locals
  // are redundant but safe. See the comment in the main-body walk
  // for why the previous `nullAtScopeExit` optimization was unsound
  // along early-return paths.
  for (const o of [...owned, ...ownedParams]) {
    // Skip freeing the single-output return value — its buffer is
    // about to transfer to the caller via return-by-value.
    if (nOutputs === 1 && o.cName === fn.cOutputs[0]) continue;
    // Multi-output owned slots are moved-out by the sret writes
    // above; freeing them here would double-free the buffer the
    // caller now owns.
    if (isMulti && outputCNames.has(o.cName)) continue;
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
      // The loop var is pre-declared at function top by
      // `collectHoistedScalarLocals`, so the rebind here is a plain
      // assignment. This lets reads after the loop see the final
      // iteration's value (matching numbl).
      lines.push(
        `${indent}    ${s.cVar} = mtoc2_range_value(_mtoc2_for_start, ${stepC}, _mtoc2_for_end, _mtoc2_for_n, _mtoc2_for_i);`
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
      // N≥2-output user-function call OR builtin with a `multiOutput`
      // hook (e.g. `[v, i] = sort(a)`). Named slots' `binding.cName` is
      // pre-declared at function top — owned slots by `collectOwnedLocals`,
      // scalar slots by `collectHoistedScalarLocals`. Ignored slots
      // become `_mtoc2_discard_<callIdx>_<i>` locals scoped to the
      // call's `{}` block.
      //
      // Owned arg-copy uses the same `emitOwnedRhs` wrapping as a
      // regular `Call` so the user-function callee owns its arg.
      // Builtin multi-output helpers follow the single-output builtin
      // convention instead: they read the arg without taking ownership
      // (no `_copy` at the call site), matching every other
      // `mtoc2_tensor_*` helper that takes a tensor by value.
      //
      // Builtin path: activate the registry-declared runtime deps so the
      // `mtoc2_<name>_<nargout>` helper snippet lands in the emitted C.
      // User-function path: the spec is already emitted elsewhere, no
      // runtime dep activation needed.
      const builtinMA = getBuiltin(s.name);
      const isBuiltinMA = builtinMA?.multiOutput !== undefined;
      if (isBuiltinMA) {
        activateRuntimeDeps(builtinMA!.runtimeDeps, state);
      }
      const argStrs = s.args.map(a =>
        !isBuiltinMA && isOwned(a.ty)
          ? emitOwnedRhs(a, state)
          : emitExpr(a, state)
      );
      const callIdx = state.multiAssignCallCounter++;
      const out: string[] = [];
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
    case "StringLit": {
      // Text literal — kind comes from `e.ty`: `Char` (single-quoted,
      // 1×N char array) or `String` (double-quoted, scalar handle).
      // The reducer-builtin slot path (`sum(A, 'all')`, etc.) doesn't
      // route through emitExpr — those builtins' codegenC drops the
      // slot — so the bare C-string-literal fallback isn't load-bearing
      // anymore. Every reached `StringLit` here is a value-producing
      // text literal that needs the owned struct.
      const { lit, byteLen } = cStringLiteral(e.value);
      if (e.ty.kind === "String") {
        useRuntimeByName(state, "mtoc2_string_from_literal");
        return `mtoc2_string_from_literal(${lit}, ${byteLen})`;
      }
      if (e.ty.kind === "Char") {
        useRuntimeByName(state, "mtoc2_char_tensor_from_literal");
        return `mtoc2_char_tensor_from_literal(${lit}, ${byteLen})`;
      }
      // Reducer-builtin slot context (e.g. `'all'` to `sum`/`min`/`max`):
      // the surrounding builtin reads `ty.exact` at transfer time and
      // drops the slot in codegenC, so this bare literal is unreachable
      // by emitted C. Return a plain C literal as a safe stub.
      return lit;
    }
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
    case "TensorConcat":
      return emitTensorConcat(e, state);
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
      if (e.base.kind !== "Var") {
        throw new Error(
          `emit internal: IndexLoad base must be a Var after ANF (got ${e.base.kind})`
        );
      }
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

/** Encode `s` as a C string literal `"..."` whose bytes are the UTF-8
 *  encoding of `s`. Returns `{ lit, byteLen }` where `byteLen` is the
 *  encoded byte count (excluding the trailing NUL). Non-printable bytes
 *  use `\xHH`; backslash/quote/standard whitespace use the C escapes.
 *
 *  Why hex over `\uHHHH`: narrow C string literals don't accept
 *  universal-character names; we need byte-level escapes to keep the
 *  emitted code portable. */
function cStringLiteral(s: string): { lit: string; byteLen: number } {
  const bytes = new TextEncoder().encode(s);
  let out = '"';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x5c) {
      out += "\\\\";
    } else if (b === 0x22) {
      out += '\\"';
    } else if (b === 0x0a) {
      out += "\\n";
    } else if (b === 0x0d) {
      out += "\\r";
    } else if (b === 0x09) {
      out += "\\t";
    } else if (b >= 0x20 && b < 0x7f) {
      out += String.fromCharCode(b);
    } else {
      // \xHH (lowercase). Wrap in `""` separator if a hex digit follows
      // so the runtime hex escape doesn't gobble up valid following
      // characters (e.g. "\x0a1" must be "\x0a" "1", not "\x0a1").
      const hex = b.toString(16).padStart(2, "0");
      const next = i + 1 < bytes.length ? bytes[i + 1] : 0;
      const nextIsHex =
        (next >= 0x30 && next <= 0x39) ||
        (next >= 0x41 && next <= 0x46) ||
        (next >= 0x61 && next <= 0x66);
      out += `\\x${hex}`;
      if (nextIsHex) out += '" "';
    }
  }
  out += '"';
  return { lit: out, byteLen: bytes.length };
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
  slotsTyped: ReadonlyArray<import("../lowering/ir.js").IndexSliceArg>,
  baseCName: string
): string[] {
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
    } else if (slot.kind === "IndexVec") {
      // Fancy gather. The slot's tensor expression is ANF'd to a Var
      // (see `anfChildren`'s IndexSlice case), so we read its values
      // per iteration without re-evaluating. Each entry is a 1-based
      // index into the base's i-th axis; `mtoc2_idx_axis` does the
      // bounds check and 1→0-based conversion per access.
      if (slot.expr.kind !== "Var") {
        throw new Error(
          "emit internal: IndexVec slot expr must be a Var after ANF"
        );
      }
      useRuntimeByName(state, "mtoc2_oob_abort");
      const idxCName = slot.expr.cName;
      const idxTy = slot.expr.ty;
      const dimsProd: string[] = [];
      if (idxTy.kind === "Numeric") {
        for (let j = 0; j < idxTy.dims.length; j++) {
          dimsProd.push(`${idxCName}.dims[${j}]`);
        }
      }
      const numelExpr = dimsProd.length === 0 ? "0L" : dimsProd.join(" * ");
      lines.push(`${indent}long _mtoc2_n_${i} = ${numelExpr};`);
      const loc = locStringOf(slot.span);
      // Per-iteration: read the 1-based index, bounds-check, convert to 0-based.
      slotSrc.push(
        `mtoc2_idx_axis(&${baseCName}, ${i}, (long)${idxCName}.real[${kVar}], ${loc})`
      );
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

/** Emit a `TensorConcat` as a GCC statement-expression: alloc a fresh
 *  tensor, write every cell into its rectangle of the destination,
 *  then evaluate to the tensor. Scalar cells write a single slot;
 *  tensor cells run a nested loop over the cell's rectangle copying
 *  column-major source data into the destination. ANF guarantees
 *  every tensor cell is already a `Var`, so reads from the cell
 *  carry no allocation cost.
 *
 *  Two codegen paths:
 *    - All-static: every per-cell dim and the output shape are known
 *      compile-time integers. We unroll row / col offsets into
 *      bake-in literals and emit straight-line copies.
 *    - Dynamic: at least one dim is `null` in the IR (runtime-only).
 *      Per-cell rows / cols come from `<cell>.dims[k]`; we accumulate
 *      row / col offsets in `long` locals and walk the cells the
 *      same way.
 *
 *  Mirrors numbl's `catAlongDim` (runtime/tensor-construction.ts:402+)
 *  output layout — column-major destination, per-cell rectangle. */
function emitTensorConcat(
  e: Extract<IRExpr, { kind: "TensorConcat" }>,
  state: RuntimeState
): string {
  useRuntimeByName(state, "mtoc2_tensor_t");
  useRuntimeByName(state, "mtoc2_tensor_alloc_nd");

  const allStatic =
    e.shape.every(s => s !== null) &&
    e.rowHeights.every(h => h !== null) &&
    e.cellCols.every(row => row.every(c => c !== null));
  if (allStatic) {
    return emitTensorConcatStatic(
      e.cells,
      e.shape as number[],
      e.rowHeights as number[],
      e.cellCols as number[][],
      state
    );
  }
  return emitTensorConcatDynamic(e, state);
}

function emitTensorConcatStatic(
  cells: IRExpr[][],
  shape: number[],
  rowHeights: number[],
  cellCols: number[][],
  state: RuntimeState
): string {
  const [totalRows, totalCols] = shape;
  void totalCols;
  const lines: string[] = [];
  lines.push(
    `mtoc2_tensor_t _mtoc2_t = mtoc2_tensor_alloc_nd(2, (long[]){${totalRows}L, ${shape[1]}L});`
  );

  let rowOff = 0;
  for (let i = 0; i < cells.length; i++) {
    const row = cells[i];
    const cellRows = rowHeights[i];
    let colOff = 0;
    for (let j = 0; j < row.length; j++) {
      const cell = row[j];
      const cellColsHere = cellCols[i][j];
      const cellStr = emitExpr(cell, state);

      if (cellRows === 1 && cellColsHere === 1) {
        const dstIdx = `${rowOff}L + ${colOff}L * ${totalRows}L`;
        lines.push(`_mtoc2_t.real[${dstIdx}] = ${cellStr};`);
      } else {
        lines.push(
          `for (long _mtoc2_sc = 0; _mtoc2_sc < ${cellColsHere}L; _mtoc2_sc++) {`
        );
        lines.push(
          `  for (long _mtoc2_sr = 0; _mtoc2_sr < ${cellRows}L; _mtoc2_sr++) {`
        );
        const dstIdx = `(${rowOff}L + _mtoc2_sr) + (${colOff}L + _mtoc2_sc) * ${totalRows}L`;
        const srcIdx = `_mtoc2_sr + _mtoc2_sc * ${cellRows}L`;
        lines.push(
          `    _mtoc2_t.real[${dstIdx}] = ${cellStr}.real[${srcIdx}];`
        );
        lines.push(`  }`);
        lines.push(`}`);
      }
      colOff += cellColsHere;
    }
    rowOff += cellRows;
  }
  lines.push(`_mtoc2_t;`);
  return `({ ${lines.join(" ")} })`;
}

function emitTensorConcatDynamic(
  e: Extract<IRExpr, { kind: "TensorConcat" }>,
  state: RuntimeState
): string {
  const lines: string[] = [];
  // Resolve every cell's emitted C expression up front and cache it.
  // After ANF every tensor cell is a `Var` (bare identifier) and
  // scalar cells are simple expressions — neither has side effects
  // we'd be doubling up on by referencing twice.
  const cellStrs: string[][] = e.cells.map(row =>
    row.map(c => emitExpr(c, state))
  );
  // Per-cell row / col extent expressions.
  const cellRowsExpr = (i: number, j: number): string => {
    const c = e.cells[i][j];
    if (c.ty.kind !== "Numeric") return "1L";
    if (c.ty.dims.length === 0 || isScalar(c.ty)) return "1L";
    const r = e.rowHeights[i];
    if (r !== null) return `${r}L`;
    return `${cellStrs[i][j]}.dims[0]`;
  };
  const cellColsExpr = (i: number, j: number): string => {
    const c = e.cells[i][j];
    if (c.ty.kind !== "Numeric") return "1L";
    if (c.ty.dims.length === 0 || isScalar(c.ty)) return "1L";
    const k = e.cellCols[i][j];
    if (k !== null) return `${k}L`;
    return `${cellStrs[i][j]}.dims[1]`;
  };
  // Emit row-height locals so we don't recompute the witness cell's
  // `.dims[0]` more than once per row.
  const rhLocals: string[] = [];
  for (let i = 0; i < e.cells.length; i++) {
    const name = `_mtoc2_rh_${i}`;
    rhLocals.push(name);
    // Pick the first cell's height as the witness — every cell in
    // the row is required to share it (validated statically at
    // lowering when both sides are known).
    lines.push(`long ${name} = ${cellRowsExpr(i, 0)};`);
  }
  // Total height = sum of row heights.
  const trExpr = e.shape[0] !== null ? `${e.shape[0]}L` : rhLocals.join(" + ");
  lines.push(`long _mtoc2_tr = ${trExpr};`);
  // Total width = first row's width = sum of its cells' cols.
  const widthExpr = (() => {
    if (e.shape[1] !== null) return `${e.shape[1]}L`;
    if (e.cells.length === 0) return "0L";
    return e.cells[0].map((_, j) => cellColsExpr(0, j)).join(" + ");
  })();
  lines.push(`long _mtoc2_tc = ${widthExpr};`);
  lines.push(
    `mtoc2_tensor_t _mtoc2_t = mtoc2_tensor_alloc_nd(2, (long[]){_mtoc2_tr, _mtoc2_tc});`
  );

  // Track destination row offset as a running long. Cells inside a
  // row use their column-offset accumulator too.
  lines.push(`long _mtoc2_row_off = 0;`);
  for (let i = 0; i < e.cells.length; i++) {
    const row = e.cells[i];
    lines.push(`long _mtoc2_col_off_${i} = 0;`);
    for (let j = 0; j < row.length; j++) {
      const cell = row[j];
      const cellStr = cellStrs[i][j];
      const rowsHere = cellRowsExpr(i, j);
      const colsHere = cellColsExpr(i, j);
      const isScalarCell =
        cell.ty.kind === "Numeric" &&
        (cell.ty.dims.length === 0 || isScalar(cell.ty));
      if (isScalarCell) {
        const dstIdx = `_mtoc2_row_off + _mtoc2_col_off_${i} * _mtoc2_tr`;
        lines.push(`_mtoc2_t.real[${dstIdx}] = ${cellStr};`);
        lines.push(`_mtoc2_col_off_${i} += 1;`);
      } else {
        const sc = `_mtoc2_sc_${i}_${j}`;
        const sr = `_mtoc2_sr_${i}_${j}`;
        const cw = `_mtoc2_cw_${i}_${j}`;
        const ch = `_mtoc2_ch_${i}_${j}`;
        lines.push(`long ${cw} = ${colsHere};`);
        lines.push(`long ${ch} = ${rowsHere};`);
        lines.push(`for (long ${sc} = 0; ${sc} < ${cw}; ${sc}++) {`);
        lines.push(`  for (long ${sr} = 0; ${sr} < ${ch}; ${sr}++) {`);
        const dstIdx = `(_mtoc2_row_off + ${sr}) + (_mtoc2_col_off_${i} + ${sc}) * _mtoc2_tr`;
        const srcIdx = `${sr} + ${sc} * ${ch}`;
        lines.push(
          `    _mtoc2_t.real[${dstIdx}] = ${cellStr}.real[${srcIdx}];`
        );
        lines.push(`  }`);
        lines.push(`}`);
        lines.push(`_mtoc2_col_off_${i} += ${cw};`);
      }
    }
    lines.push(`_mtoc2_row_off += ${rhLocals[i]};`);
  }
  lines.push(`_mtoc2_t;`);
  return `({ ${lines.join(" ")} })`;
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
  if (e.base.kind !== "Var") {
    throw new Error(
      `emit internal: IndexSlice base must be a Var after ANF (got ${e.base.kind})`
    );
  }
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
  const slotSrc = emitSliceSlotSetup(state, lines, "", e.index, baseCName);
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

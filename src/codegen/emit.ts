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

import type {
  IRExpr,
  IRStmt,
  IRFunc,
  IRProgram,
  IndexSliceArg,
} from "../lowering/ir.js";
import { getBuiltin } from "../lowering/builtins/index.js";
import { cTypeFor, requireOwnedHelpers } from "./cHelpers.js";
import {
  classTypedefName,
  handleTypedefName,
  isColVecTy,
  isRowVecTy,
  isDimOne,
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
import { emitTensorAssignFused, isFusableAssign } from "./emitTensorFused.js";

export interface EmitOptions {
  /** Include the activated runtime helper bodies in the output.
   *  Default true. When false, headers + a placeholder stub replace
   *  them so the user sees only their generated code. */
  includeRuntime?: boolean;
  /** Max-threads OpenMP setting. See `TranslateOptions.threads`. */
  threads?: number | "auto";
}

export function emitProgram(prog: IRProgram, opts: EmitOptions = {}): string {
  const includeRuntime = opts.includeRuntime ?? true;
  const threads = opts.threads;
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
  // `--threads N` (numeric, >= 2) → pin the OpenMP team size at
  // startup; subsequent `#pragma omp parallel for` regions cap at N.
  // `--threads auto` doesn't emit anything here — OpenMP picks from
  // `OMP_NUM_THREADS` / core count via its own defaults. The
  // `omp_set_num_threads` symbol comes from `<omp.h>`, which the
  // header block below pulls in conditionally on the same predicate.
  if (typeof threads === "number" && threads > 1) {
    userParts.push(`  omp_set_num_threads(${threads});`);
  }
  const mainLocals = collectLocals(prog.topLevelStmts);
  const mainOwned = mainLocals.owned;
  for (const o of mainOwned) {
    activateOwnedRuntime(o.ty, state);
    const h = requireOwnedHelpers(o.ty);
    userParts.push(`  ${cTypeFor(o.ty)} ${o.cName} = ${h.empty}();`);
  }
  for (const o of mainLocals.scalars) {
    userParts.push(`  ${cTypeFor(o.ty)} ${o.cName} = ${defaultInitFor()};`);
  }
  const mainFutureTouches = computeFutureTouches(prog.topLevelStmts);
  const mainOwnedTypes = new Map<string, Type>(
    mainOwned.map(o => [o.cName, o.ty])
  );
  // Tail closure for main: scope-exit frees + `return 0;`. Called both
  // at every `ReturnFromFunction` inside the top-level body (inline
  // cleanup — no goto) and at the fall-through bottom. Activates the
  // owned `_free` runtime deps eagerly so the snippet ships even when
  // every path is an early return.
  for (const o of mainOwned) activateOwnedRuntime(o.ty, state);
  const mainReturnTail: EmitReturnTail = indent => {
    const lines: string[] = [];
    // Early-frees null the buffer, every `_free` helper is NULL-safe,
    // so duplicate frees across overlapping early-return + fall-through
    // paths are redundant but safe. A prior `nullAtScopeExit`
    // optimization tried to skip provably-NULL frees but mis-modeled
    // early returns; we don't ship it.
    for (const o of mainOwned) {
      const h = requireOwnedHelpers(o.ty);
      lines.push(`${indent}${h.free}(&${o.cName});`);
    }
    lines.push(`${indent}return 0;`);
    return lines.join("\n");
  };
  const mainBody = emitBody(
    prog.topLevelStmts,
    "  ",
    state,
    mainFutureTouches,
    mainOwnedTypes,
    mainReturnTail
  );
  if (mainBody.length > 0) userParts.push(mainBody);
  userParts.push(mainReturnTail("  "));
  userParts.push("}");
  userParts.push("");

  // Headers: BASE_HEADERS ∪ activated-snippet headers, deduped.
  // `<omp.h>` only when we actually emit a call into the OpenMP API
  // (`omp_set_num_threads(N)` for numeric `--threads N >= 2`). The
  // `_Pragma("omp ...")` lines in the elementwise macros are
  // preprocessor-handled and need no header.
  const headers = new Set<string>(BASE_HEADERS);
  for (const h of collectRuntimeHeaders(state)) headers.add(h);
  if (typeof threads === "number" && threads > 1) headers.add("<omp.h>");

  const out: string[] = [];
  for (const h of headers) out.push(`#include ${h}`);
  out.push("");

  if (state.active.size > 0) {
    out.push(
      includeRuntime ? renderRuntimeBodies(state) : runtimePlaceholder(state)
    );
  }

  // Release `<complex.h>`'s lower-case macros so user code can shadow
  // ordinary identifiers like `I`, `complex`, `imaginary`. The runtime
  // snippets are emitted above this point, so they've already
  // expanded any macros they used; the user code below sees plain
  // identifiers. mtoc2's own complex-literal emit uses `_Complex_I`
  // (always defined by `<complex.h>` per C99 §7.3.1) so it doesn't
  // need the `I` macro either.
  out.push("#ifdef I");
  out.push("#undef I");
  out.push("#endif");
  out.push("#ifdef complex");
  out.push("#undef complex");
  out.push("#endif");
  out.push("#ifdef imaginary");
  out.push("#undef imaginary");
  out.push("#endif");
  out.push("");

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

/** Default initializer for a freshly-declared non-owned local. Owned
 *  types (tensors, structs, classes, handles) route through their
 *  `_empty()` helper instead and never hit this path; everything
 *  reaching here is scalar real numeric, so `0.0` always fits. */
function defaultInitFor(): string {
  return "0.0";
}

function activateOwnedRuntime(t: Type, state: RuntimeState): void {
  const h = requireOwnedHelpers(t);
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
/** Walk the body and collect every local (any kind) that needs a top-
 *  of-function predeclaration. Includes Assign LHSes, MultiAssignCall
 *  slot bindings, and For loop vars (the For node carries its own
 *  loop var so reads after the loop see the last iteration's value).
 *  Callers partition the result into owned / non-owned with `isOwned`. */
function collectAllLocals(stmts: IRStmt[]): { cName: string; ty: Type }[] {
  const seen = new Map<string, Type>();
  const order: string[] = [];
  const note = (cName: string, ty: Type): void => {
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
          // v1 restricts slots to scalar real numeric, so owned-typed
          // bindings won't appear here today; kept for the future
          // tensor-output extension.
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
          note(s.cVar, scalarDouble());
          visit(s.body);
          break;
      }
    }
  };
  visit(stmts);
  return order.map(cName => ({ cName, ty: seen.get(cName)! }));
}

/** Walk `stmts` once and split the result into owned vs non-owned
 *  locals. Every local is pre-declared at function top — owned with
 *  the per-type `_empty()` helper, scalars with the default init
 *  (`0.0` / `0`). The non-owned half also picks up For loop vars and
 *  multi-assign slot bindings so that a later read of a variable
 *  first written inside an If / While / For body (reachable via
 *  `mergeBranchEnvs` keeping partial-branch keys) doesn't reference
 *  an out-of-scope C local. */
function collectLocals(stmts: IRStmt[]): {
  owned: { cName: string; ty: Type }[];
  scalars: { cName: string; ty: Type }[];
} {
  const owned: { cName: string; ty: Type }[] = [];
  const scalars: { cName: string; ty: Type }[] = [];
  for (const local of collectAllLocals(stmts)) {
    if (isOwned(local.ty)) owned.push(local);
    else scalars.push(local);
  }
  return { owned, scalars };
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
      const h = requireOwnedHelpers(outTy);
      lines.push(`  ${cTypeFor(outTy)} ${cOut} = ${h.empty}();`);
    } else if (outTy !== undefined) {
      lines.push(`  ${cTypeFor(outTy)} ${cOut} = ${defaultInitFor()};`);
    } else {
      lines.push(`  double ${cOut} = 0.0;`);
    }
  }
  // Pre-declare every body local at function top (excluding outputs
  // and params, both of which are already declared elsewhere —
  // outputs above, params in the function signature). Without the
  // paramNames filter, a body that reassigns an owned param
  // (`function f(xs); xs = xs(:); ...`) would emit a duplicate
  // `mtoc2_tensor_t xs = mtoc2_tensor_empty();` and the C compiler
  // would reject the redeclaration.
  const isLocalDeclSite = (o: { cName: string }): boolean =>
    !outputCNames.has(o.cName) && !paramNames.has(o.cName);
  const fnLocals = collectLocals(fn.body);
  const owned = fnLocals.owned.filter(isLocalDeclSite);
  for (const o of owned) {
    activateOwnedRuntime(o.ty, state);
    const h = requireOwnedHelpers(o.ty);
    lines.push(`  ${cTypeFor(o.ty)} ${o.cName} = ${h.empty}();`);
  }
  for (const o of fnLocals.scalars.filter(isLocalDeclSite)) {
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
  // Tail closure: sret writes (multi-output) + scope-exit frees +
  // `return [value];`. Called inline at every `ReturnFromFunction`
  // site and at the fall-through bottom. Single source of truth so
  // the two callers can't drift on cleanup order. Activate the
  // owned `_free` (and multi-output `_assign`) snippets eagerly so
  // they ship even when every path is an early return.
  for (const o of [...owned, ...ownedParams]) activateOwnedRuntime(o.ty, state);
  if (isMulti) {
    for (let i = 0; i < nOutputs; i++) {
      const outTy = fn.outputTypes[i];
      if (outTy && isOwned(outTy)) activateOwnedRuntime(outTy, state);
    }
  }
  const fnReturnTail: EmitReturnTail = indent => {
    const tail: string[] = [];
    // Multi-output: write each output through its sret pointer
    // BEFORE the scope-exit free walk so the writes can read the
    // live locals before any tensor frees would zero them.
    //   Scalar slots: bare struct copy (`*_mtoc2_o<i> = <local>`).
    //   Owned slots:  ownership transfer via the kind's `_assign`
    //                 helper. The local's scope-exit free is
    //                 suppressed below (`outputCNames` skip).
    if (isMulti) {
      for (let i = 0; i < nOutputs; i++) {
        const outTy = fn.outputTypes[i];
        if (outTy && isOwned(outTy)) {
          const h = requireOwnedHelpers(outTy);
          tail.push(`${indent}${h.assign}(_mtoc2_o${i}, ${fn.cOutputs[i]});`);
        } else {
          tail.push(`${indent}*_mtoc2_o${i} = ${fn.cOutputs[i]};`);
        }
      }
    }
    for (const o of [...owned, ...ownedParams]) {
      // Skip freeing the single-output return value — its buffer is
      // about to transfer to the caller via return-by-value.
      if (nOutputs === 1 && o.cName === fn.cOutputs[0]) continue;
      // Multi-output owned slots are moved-out by the sret writes
      // above; freeing them here would double-free the buffer the
      // caller now owns.
      if (isMulti && outputCNames.has(o.cName)) continue;
      const h = requireOwnedHelpers(o.ty);
      tail.push(`${indent}${h.free}(&${o.cName});`);
    }
    if (isVoidFn || isMulti) {
      tail.push(`${indent}return;`);
    } else {
      tail.push(`${indent}return ${fn.cOutputs[0]};`);
    }
    return tail.join("\n");
  };
  const bodyText = emitBody(
    fn.body,
    "  ",
    state,
    futureTouches,
    fnOwnedTypes,
    fnReturnTail
  );
  if (bodyText.length > 0) lines.push(bodyText);
  lines.push(fnReturnTail("  "));
  lines.push(`}`);
  return lines.join("\n");
}

/** Emits the function/scope's exit cleanup + return statements at a
 *  given indent. Called from two places: at every `ReturnFromFunction`
 *  site (inline cleanup — no goto), and at the fall-through bottom of
 *  the function. Single source of truth so the two callers can't
 *  drift on which locals get freed in what order.
 *
 *  Why inline rather than goto-to-a-shared-tail: c2js can't translate
 *  C `goto`, and we want a single C emit that works for both targets.
 *  Inlining produces some duplication when a function has many early
 *  returns and many owned locals, but typical mtoc2 functions are
 *  small and the C compiler dedupes-by-tail-merge anyway. */
type EmitReturnTail = (indent: string) => string;

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
  ownedTypes: ReadonlyMap<string, Type>,
  emitReturnTail: EmitReturnTail
): string {
  const out: string[] = [];
  for (const s of stmts) {
    const header = irStmtHeader(s);
    if (header !== null) {
      out.push(`${indent}/* ${header} */`);
    }
    const line = emitStmt(
      s,
      indent,
      state,
      futureTouches,
      ownedTypes,
      emitReturnTail
    );
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
      const h = requireOwnedHelpers(ty);
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
  ownedTypes: ReadonlyMap<string, Type>,
  emitReturnTail: EmitReturnTail
): string | null {
  switch (s.kind) {
    case "ExprStmt":
      return `${indent}${emitExpr(s.expr, state)};`;
    case "Assign": {
      if (isOwned(s.ty)) {
        // Pure-elementwise same-shape tensor RHS goes through the
        // fused inline-loop emitter — same generated work as the
        // helper-call path for a depth-1 expression, but lets the
        // (phase-2) inliner produce deeper expressions that share a
        // single iter loop. See `emitTensorFused.ts`.
        if (s.kind === "Assign" && isFusableAssign(s)) {
          activateOwnedRuntime(s.ty, state);
          return emitTensorAssignFused(s, indent, state);
        }
        activateOwnedRuntime(s.ty, state);
        const h = requireOwnedHelpers(s.ty);
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
        const h = requireOwnedHelpers(s.leafTy);
        const rhs = emitOwnedRhs(s.rhs, state);
        return `${indent}${h.assign}(&${slot}, ${rhs});`;
      }
      const rhs = emitExpr(s.rhs, state);
      return `${indent}${slot} = ${rhs};`;
    }
    case "IndexStore": {
      const offset = emitNdScalarOffset(state, s.indices, s.base.cName);
      const rhs = emitExpr(s.rhs, state);
      const baseIsComplex = isNumeric(s.base.ty) && s.base.ty.isComplex;
      const rhsIsComplex = isNumeric(s.rhs.ty) && s.rhs.ty.isComplex;
      if (baseIsComplex) {
        // Both lanes must be written. The offset expression may have
        // side effects (function calls, autoinc, etc.), so hoist it to
        // a local. RHS may be real (project imag → 0) or complex
        // (split via `mtoc2_creal/cimag`).
        useRuntimeByName(state, "mtoc2_cscalar");
        if (rhsIsComplex) {
          const lines: string[] = [];
          lines.push(`${indent}{`);
          lines.push(`${indent}  long _mtoc2_off = ${offset};`);
          lines.push(`${indent}  double _Complex _mtoc2_rhs = ${rhs};`);
          lines.push(
            `${indent}  ${s.base.cName}.real[_mtoc2_off] = mtoc2_creal(_mtoc2_rhs);`
          );
          lines.push(
            `${indent}  ${s.base.cName}.imag[_mtoc2_off] = mtoc2_cimag(_mtoc2_rhs);`
          );
          lines.push(`${indent}}`);
          return lines.join("\n");
        }
        const lines: string[] = [];
        lines.push(`${indent}{`);
        lines.push(`${indent}  long _mtoc2_off = ${offset};`);
        lines.push(`${indent}  ${s.base.cName}.real[_mtoc2_off] = ${rhs};`);
        lines.push(`${indent}  ${s.base.cName}.imag[_mtoc2_off] = 0.0;`);
        lines.push(`${indent}}`);
        return lines.join("\n");
      }
      return `${indent}${s.base.cName}.real[${offset}] = ${rhs};`;
    }
    case "IndexSliceStore":
      return emitIndexSliceStore(s, indent, state);
    case "If": {
      const lines: string[] = [];
      lines.push(`${indent}if (${emitCondToBoolExpr(s.cond, state)}) {`);
      const thenText = emitBody(
        s.thenBody,
        indent + "  ",
        state,
        futureTouches,
        ownedTypes,
        emitReturnTail
      );
      if (thenText.length > 0) lines.push(thenText);
      if (s.elseBody.length > 0) {
        if (s.elseBody.length === 1 && s.elseBody[0].kind === "If") {
          const inner = emitStmt(
            s.elseBody[0],
            indent,
            state,
            futureTouches,
            ownedTypes,
            emitReturnTail
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
            ownedTypes,
            emitReturnTail
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
      lines.push(`${indent}while (${emitCondToBoolExpr(s.cond, state)}) {`);
      const bodyText = emitBody(
        s.body,
        indent + "  ",
        state,
        futureTouches,
        ownedTypes,
        emitReturnTail
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
      // `collectLocals`, so the rebind here is a plain
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
        ownedTypes,
        emitReturnTail
      );
      if (bodyText.length > 0) lines.push(bodyText);
      lines.push(`${indent}  }`);
      lines.push(`${indent}}`);
      return lines.join("\n");
    }
    case "ReturnFromFunction":
      return emitReturnTail(indent);
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
      // pre-declared at function top by `collectLocals`. Ignored slots
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
            const h = requireOwnedHelpers(slot.ty);
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
          const h = requireOwnedHelpers(slot.ty);
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
    const h = requireOwnedHelpers(e.ty);
    return `${h.copy}(${e.cName})`;
  }
  if (e.kind === "MemberLoad" && isOwned(e.ty)) {
    activateOwnedRuntime(e.ty, state);
    const h = requireOwnedHelpers(e.ty);
    return `${h.copy}(${emitMemberLoadBare(e, state)})`;
  }
  if (e.kind === "HandleCaptureLoad" && isOwned(e.ty)) {
    activateOwnedRuntime(e.ty, state);
    const h = requireOwnedHelpers(e.ty);
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

/** Lower a scalar cond expression to a C bool expression. Complex
 *  scalars use the numbl/MATLAB `creal(z) != 0 || cimag(z) != 0` rule
 *  via the `mtoc2_cnonzero` helper; real scalars compare against `0.0`. */
function emitCondToBoolExpr(e: IRExpr, state: RuntimeState): string {
  const c = emitExpr(e, state);
  if (isNumeric(e.ty) && e.ty.isComplex) {
    useRuntimeByName(state, "mtoc2_cscalar");
    return `mtoc2_cnonzero(${c})`;
  }
  return `${c} != 0.0`;
}

function emitExpr(e: IRExpr, state: RuntimeState): string {
  switch (e.kind) {
    case "NumLit":
      return formatDouble(e.value);
    case "ImagLit":
      useRuntimeByName(state, "mtoc2_cscalar");
      return `mtoc2_cmake(0.0, ${formatDouble(e.value)})`;
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
      const isComplex = isNumeric(e.ty) && e.ty.isComplex;
      if (isComplex) {
        // Two parallel `double[]` arrays — real parts and imag parts.
        // Real-typed cells project to `(re, 0.0)`; complex cells
        // split via `mtoc2_creal` / `mtoc2_cimag`. This avoids ever
        // passing `double _Complex *` arrays around (which c2js
        // can't translate), and keeps each compound literal a plain
        // real-double array.
        const reParts: string[] = [];
        const imParts: string[] = [];
        for (const el of e.elements) {
          const c = emitExpr(el, state);
          if (isNumeric(el.ty) && el.ty.isComplex) {
            useRuntimeByName(state, "mtoc2_cscalar");
            reParts.push(`mtoc2_creal(${c})`);
            imParts.push(`mtoc2_cimag(${c})`);
          } else {
            reParts.push(c);
            imParts.push("0.0");
          }
        }
        const reFlat = reParts.join(", ");
        const imFlat = imParts.join(", ");
        if (rows === 1) {
          useRuntimeByName(state, "mtoc2_tensor_from_row_complex");
          return `mtoc2_tensor_from_row_complex((double[]){${reFlat}}, (double[]){${imFlat}}, ${cols})`;
        }
        useRuntimeByName(state, "mtoc2_tensor_from_matrix_complex");
        return `mtoc2_tensor_from_matrix_complex((double[]){${reFlat}}, (double[]){${imFlat}}, ${rows}, ${cols})`;
      }
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
      // Lowerer-synthesized bare-`toc(t0);` print form (1-arg handle
      // variant). Same activation path as `toc_print`.
      if (
        e.name === "toc_handle_print" &&
        e.cName === "mtoc2_toc_handle_print"
      ) {
        useRuntimeByName(state, "mtoc2_tic_toc");
        const argC = emitExpr(e.args[0], state);
        return `mtoc2_toc_handle_print(${argC})`;
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
      if (isNumeric(e.base.ty) && e.base.ty.isComplex) {
        // Compose the complex value from both lanes via `mtoc2_cmake`
        // so the c2js side reuses its `{re, im}` JS impl. Avoid
        // recomputing the offset twice by hoisting through a GCC
        // statement-expression — the offset may include autoinc /
        // bounds-checked sub-calls we don't want to re-evaluate.
        useRuntimeByName(state, "mtoc2_cscalar");
        return `({ long _mtoc2_off = ${offset}; mtoc2_cmake(${e.base.cName}.real[_mtoc2_off], ${e.base.cName}.imag[_mtoc2_off]); })`;
      }
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
 *  `_mtoc2_src_<i>` local for Scalar slots).
 *
 *  `cleanups`, when provided, is populated with lines that must run
 *  after the iter loop (currently used for LogicalMask slots to free
 *  the precomputed source-index buffer). The caller is expected to
 *  emit these lines immediately after closing the slot iteration
 *  loops and before the GCC statement-expression's yield expression. */
function emitSliceSlotSetup(
  state: RuntimeState,
  lines: string[],
  indent: string,
  slotsTyped: ReadonlyArray<IndexSliceArg>,
  baseCName: string,
  cleanups?: string[]
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
    } else if (slot.kind === "LogicalMask") {
      // Per-axis logical-mask gather. Scan the mask once at setup time
      // and fill a `long[]` index buffer with the 0-based source-axis
      // positions where the mask is truthy. The truthy count is the
      // per-slot iteration count; per-iter the source index is the
      // i-th entry of the buffer. Buffer is freed after the iter loop
      // via `cleanups`.
      if (slot.expr.kind !== "Var") {
        throw new Error(
          "emit internal: LogicalMask slot expr must be a Var after ANF"
        );
      }
      useRuntimeByName(state, "mtoc2_logical_mask_indices");
      useRuntimeByName(state, "mtoc2_alloc");
      const maskCName = slot.expr.cName;
      const maskTy = slot.expr.ty;
      const maskDimsProd: string[] = [];
      if (maskTy.kind === "Numeric") {
        for (let j = 0; j < maskTy.dims.length; j++) {
          maskDimsProd.push(`${maskCName}.dims[${j}]`);
        }
      }
      const maskNumelExpr =
        maskDimsProd.length === 0 ? "0L" : maskDimsProd.join(" * ");
      const loc = locStringOf(slot.span);
      lines.push(`${indent}long _mtoc2_mask_n_${i} = ${maskNumelExpr};`);
      lines.push(
        `${indent}long *_mtoc2_idx_${i} = (long *)mtoc2_alloc(sizeof(long) * (_mtoc2_mask_n_${i} > 0 ? (size_t)_mtoc2_mask_n_${i} : 1));`
      );
      lines.push(
        `${indent}long _mtoc2_n_${i} = mtoc2_logical_mask_indices(${maskCName}, ${baseCName}.dims[${i}], ${i}, ${loc}, _mtoc2_idx_${i});`
      );
      if (cleanups) {
        cleanups.push(`${indent}free(_mtoc2_idx_${i});`);
      }
      slotSrc.push(`_mtoc2_idx_${i}[${kVar}]`);
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

/** Emit a single-slot linear Range slice's setup block: pushes locals
 *  `_mtoc2_start`/`_mtoc2_end`/`_mtoc2_n`, gates a
 *  `mtoc2_check_linear_range` call on a non-empty range, and returns a
 *  function that maps a loop-counter expression to the corresponding
 *  source/destination buffer offset. Shared by `emitIndexSliceProducer`
 *  (read) and `emitIndexSliceStore` (write). */
function emitLinearRangeSetup(
  slot: Extract<IndexSliceArg, { kind: "Range" }>,
  baseCName: string,
  lines: string[],
  indent: string,
  state: RuntimeState
): (kVar: string) => string {
  if (slot.step.kind !== "NumLit") {
    throw new Error("emit internal: index-slot Range step must be NumLit");
  }
  useRuntimeByName(state, "mtoc2_loop_count");
  useRuntimeByName(state, "mtoc2_oob_abort");
  const startStr = emitExpr(slot.start, state);
  const endStr = emitExpr(slot.end, state);
  const stepStr = formatDouble(slot.step.value);
  const loc = locStringOf(slot.span);
  lines.push(`${indent}double _mtoc2_start = ${startStr};`);
  lines.push(`${indent}double _mtoc2_end = ${endStr};`);
  lines.push(
    `${indent}long _mtoc2_n = mtoc2_loop_count(_mtoc2_start, _mtoc2_end, ${stepStr});`
  );
  // Single-slot range slice indexes linearly over numel(base), not
  // against a single axis dim. Skip the check on an empty range
  // (MATLAB allows `v(5:4)` to yield 1×0).
  lines.push(`${indent}if (_mtoc2_n > 0) {`);
  lines.push(`${indent}  long _mtoc2_first = (long)_mtoc2_start;`);
  lines.push(
    `${indent}  long _mtoc2_last = (long)(_mtoc2_start + ${stepStr} * (double)(_mtoc2_n - 1));`
  );
  lines.push(
    `${indent}  mtoc2_check_linear_range(&${baseCName}, _mtoc2_first, _mtoc2_last, ${loc});`
  );
  lines.push(`${indent}}`);
  return k => `(long)(_mtoc2_start + ${stepStr} * (double)${k}) - 1L`;
}

/** Emit a "lhs/rhs element count mismatch" runtime check for a tensor
 *  RHS in a slice store. Assumes `_mtoc2_n` is already declared as the
 *  lhs slice element count. Pushes `_mtoc2_rhs_n` and the abort branch;
 *  uses `exit(1)` rather than `abort()` so the CLI's
 *  `process.exit(run.status ?? 0)` sees a non-zero status (SIGABRT
 *  surfaces as `signal`, which the CLI would treat as a clean run). */
function emitTensorRhsSizeCheck(
  rhs: Extract<IRExpr, { kind: "Var" }>,
  lines: string[],
  indent: string
): void {
  const rhsParts: string[] = [];
  if (rhs.ty.kind === "Numeric") {
    for (let i = 0; i < rhs.ty.dims.length; i++) {
      rhsParts.push(`${rhs.cName}.dims[${i}]`);
    }
  }
  lines.push(`${indent}long _mtoc2_rhs_n = ${rhsParts.join(" * ")};`);
  lines.push(`${indent}if (_mtoc2_n != _mtoc2_rhs_n) {`);
  lines.push(
    `${indent}  fprintf(stderr, "mtoc2: Subscripted assignment dimension mismatch (lhs slice has %ld elements, rhs has %ld)\\n", _mtoc2_n, _mtoc2_rhs_n);`
  );
  lines.push(`${indent}  exit(1);`);
  lines.push(`${indent}}`);
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
  const baseIsComplex = isNumeric(e.base.ty) && e.base.ty.isComplex;
  if (baseIsComplex) {
    useRuntimeByName(state, "mtoc2_tensor_alloc_nd_complex");
  } else {
    useRuntimeByName(state, "mtoc2_tensor_alloc_nd");
  }
  const allocFn = baseIsComplex
    ? "mtoc2_tensor_alloc_nd_complex"
    : "mtoc2_tensor_alloc_nd";
  const baseCName = e.base.cName;
  const lines: string[] = [];

  // Per-element copy: real lane unconditionally; imag lane only when
  // base is complex (its `imag` is non-NULL).
  const copyElem = (dstK: string, srcK: string): string =>
    baseIsComplex
      ? `_mtoc2_t.real[${dstK}] = ${baseCName}.real[${srcK}]; _mtoc2_t.imag[${dstK}] = ${baseCName}.imag[${srcK}];`
      : `_mtoc2_t.real[${dstK}] = ${baseCName}.real[${srcK}];`;

  if (e.index.length === 1) {
    // Single-slot linear form.
    const slot = e.index[0];
    let count: string;
    let srcIndexFor: (kVar: string) => string;
    let resultRows: string;
    let resultCols: string;
    let linearCleanup: string | null = null;
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
      srcIndexFor = emitLinearRangeSetup(slot, baseCName, lines, "", state);
      count = "_mtoc2_n";
      // Single-slot range: row-vec → row, col-vec → col, matrix/N-D → row.
      const isColVec = e.base.ty.kind === "Numeric" && isColVecTy(e.base.ty);
      if (isColVec) {
        resultRows = "_mtoc2_n";
        resultCols = "1";
      } else {
        resultRows = "1";
        resultCols = "_mtoc2_n";
      }
    } else if (slot.kind === "LogicalMask") {
      // Single-slot linear logical-mask read: scan the mask once,
      // collect 0-based positions where it's truthy, then walk the
      // buffer. Each truthy mask position must be < numel(base);
      // `mtoc2_logical_mask_indices` aborts otherwise. Result shape
      // mirrors single-slot Range: row-vec base → row; col-vec base
      // → col; matrix / N-D base → column vector.
      if (slot.expr.kind !== "Var") {
        throw new Error(
          "emit internal: LogicalMask slot expr must be a Var after ANF"
        );
      }
      useRuntimeByName(state, "mtoc2_logical_mask_indices");
      useRuntimeByName(state, "mtoc2_alloc");
      const maskCName = slot.expr.cName;
      const maskTy = slot.expr.ty;
      const maskDimsProd: string[] = [];
      if (maskTy.kind === "Numeric") {
        for (let j = 0; j < maskTy.dims.length; j++) {
          maskDimsProd.push(`${maskCName}.dims[${j}]`);
        }
      }
      const maskNumelExpr =
        maskDimsProd.length === 0 ? "0L" : maskDimsProd.join(" * ");
      const baseDimsProd: string[] = [];
      if (e.base.ty.kind === "Numeric") {
        for (let j = 0; j < e.base.ty.dims.length; j++) {
          baseDimsProd.push(`${baseCName}.dims[${j}]`);
        }
      }
      const baseNumelExpr =
        baseDimsProd.length === 0 ? "0L" : baseDimsProd.join(" * ");
      const loc = locStringOf(slot.span);
      lines.push(`long _mtoc2_mask_n = ${maskNumelExpr};`);
      lines.push(`long _mtoc2_base_n = ${baseNumelExpr};`);
      lines.push(
        `long *_mtoc2_idx = (long *)mtoc2_alloc(sizeof(long) * (_mtoc2_mask_n > 0 ? (size_t)_mtoc2_mask_n : 1));`
      );
      lines.push(
        `long _mtoc2_n = mtoc2_logical_mask_indices(${maskCName}, _mtoc2_base_n, -1, ${loc}, _mtoc2_idx);`
      );
      count = "_mtoc2_n";
      srcIndexFor = k => `_mtoc2_idx[${k}]`;
      const isRowBase = e.base.ty.kind === "Numeric" && isRowVecTy(e.base.ty);
      if (isRowBase) {
        resultRows = "1";
        resultCols = "_mtoc2_n";
      } else {
        resultRows = "_mtoc2_n";
        resultCols = "1";
      }
      linearCleanup = `free(_mtoc2_idx);`;
    } else {
      throw new Error(
        "emit internal: single-slot Scalar IndexSlice should have routed to IndexLoad"
      );
    }
    lines.push(
      `mtoc2_tensor_t _mtoc2_t = ${allocFn}(2, (long[]){${resultRows}, ${resultCols}});`
    );
    lines.push(`for (long _mtoc2_k = 0; _mtoc2_k < ${count}; _mtoc2_k++) {`);
    lines.push(`  ${copyElem("_mtoc2_k", srcIndexFor("_mtoc2_k"))}`);
    lines.push(`}`);
    if (linearCleanup !== null) lines.push(linearCleanup);
    lines.push(`_mtoc2_t;`);
    return `({ ${lines.join(" ")} })`;
  }

  // Multi-slot per-axis form.
  const ndim = e.index.length;
  const cleanups: string[] = [];
  const slotSrc = emitSliceSlotSetup(
    state,
    lines,
    "",
    e.index,
    baseCName,
    cleanups
  );
  const resultRank =
    e.ty.kind === "Numeric" ? Math.max(2, e.ty.dims.length) : 2;
  const dimsList: string[] = [];
  for (let i = 0; i < resultRank; i++) {
    dimsList.push(i < ndim ? `_mtoc2_n_${i}` : `1L`);
  }
  lines.push(
    `mtoc2_tensor_t _mtoc2_t = ${allocFn}(${resultRank}, (long[]){${dimsList.join(", ")}});`
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
  lines.push(copyElem("_mtoc2_dst_off", "_mtoc2_src_off"));
  for (let i = ndim - 1; i >= 0; i--) {
    lines.push(`}`);
  }
  for (const c of cleanups) lines.push(c);
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
  const baseIsComplex = isNumeric(s.base.ty) && s.base.ty.isComplex;
  const rhsIsComplex = isNumeric(s.rhs.ty) && s.rhs.ty.isComplex;
  if (baseIsComplex) {
    useRuntimeByName(state, "mtoc2_cscalar");
  }
  // Per-element write template — handles 4 cases:
  //   real base                 → write real lane only
  //   complex base, real rhs    → real lane = src, imag lane = 0
  //   complex base, complex rhs scalar → split via creal/cimag
  //   complex base, complex rhs tensor → copy both lanes from source
  // The `src*` arguments name the per-iteration C expressions for
  // accessing the RHS (either a scalar local or `rhsTensor.real[k]`/
  // `rhsTensor.imag[k]`).
  const writeAt = (
    dstK: string,
    srcReal: string,
    srcImag: string | undefined
  ): string => {
    if (!baseIsComplex) {
      return `${baseCName}.real[${dstK}] = ${srcReal};`;
    }
    const imagExpr = srcImag !== undefined ? srcImag : "0.0";
    return (
      `${baseCName}.real[${dstK}] = ${srcReal}; ` +
      `${baseCName}.imag[${dstK}] = ${imagExpr};`
    );
  };
  const lines: string[] = [];
  lines.push(`${indent}{`);

  if (s.index.length === 1) {
    const slot = s.index[0];
    let dstOffsetFor: (kVar: string) => string;
    let linearStoreCleanup: string | null = null;
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
      dstOffsetFor = emitLinearRangeSetup(
        slot,
        baseCName,
        lines,
        `${indent}  `,
        state
      );
    } else if (slot.kind === "LogicalMask") {
      // Single-slot linear logical-mask write: precompute the buffer of
      // 0-based truthy positions, then walk it.
      if (slot.expr.kind !== "Var") {
        throw new Error(
          "emit internal: LogicalMask slot expr must be a Var after ANF"
        );
      }
      useRuntimeByName(state, "mtoc2_logical_mask_indices");
      useRuntimeByName(state, "mtoc2_alloc");
      const maskCName = slot.expr.cName;
      const maskTy = slot.expr.ty;
      const maskDimsProd: string[] = [];
      if (maskTy.kind === "Numeric") {
        for (let j = 0; j < maskTy.dims.length; j++) {
          maskDimsProd.push(`${maskCName}.dims[${j}]`);
        }
      }
      const maskNumelExpr =
        maskDimsProd.length === 0 ? "0L" : maskDimsProd.join(" * ");
      const baseDimsProd: string[] = [];
      if (s.base.ty.kind === "Numeric") {
        for (let j = 0; j < s.base.ty.dims.length; j++) {
          baseDimsProd.push(`${baseCName}.dims[${j}]`);
        }
      }
      const baseNumelExpr =
        baseDimsProd.length === 0 ? "0L" : baseDimsProd.join(" * ");
      const loc = locStringOf(slot.span);
      lines.push(`${indent}  long _mtoc2_mask_n = ${maskNumelExpr};`);
      lines.push(`${indent}  long _mtoc2_base_n = ${baseNumelExpr};`);
      lines.push(
        `${indent}  long *_mtoc2_idx = (long *)mtoc2_alloc(sizeof(long) * (_mtoc2_mask_n > 0 ? (size_t)_mtoc2_mask_n : 1));`
      );
      lines.push(
        `${indent}  long _mtoc2_n = mtoc2_logical_mask_indices(${maskCName}, _mtoc2_base_n, -1, ${loc}, _mtoc2_idx);`
      );
      dstOffsetFor = k => `_mtoc2_idx[${k}]`;
      linearStoreCleanup = `${indent}  free(_mtoc2_idx);`;
    } else {
      throw new Error(
        "emit internal: single-slot Scalar IndexSliceStore should have routed to IndexStore"
      );
    }

    if (rhsIsScalar) {
      const rhsExpr = emitExpr(s.rhs, state);
      let srcReal: string;
      let srcImag: string | undefined;
      if (rhsIsComplex) {
        lines.push(`${indent}  double _Complex _mtoc2_rhs = ${rhsExpr};`);
        srcReal = "mtoc2_creal(_mtoc2_rhs)";
        srcImag = "mtoc2_cimag(_mtoc2_rhs)";
      } else {
        lines.push(`${indent}  double _mtoc2_rhs = ${rhsExpr};`);
        srcReal = "_mtoc2_rhs";
        srcImag = undefined;
      }
      lines.push(
        `${indent}  for (long _mtoc2_k = 0; _mtoc2_k < _mtoc2_n; _mtoc2_k++) {`
      );
      lines.push(`${indent}    long _mtoc2_dst = ${dstOffsetFor("_mtoc2_k")};`);
      lines.push(`${indent}    ${writeAt("_mtoc2_dst", srcReal, srcImag)}`);
      lines.push(`${indent}  }`);
    } else {
      if (s.rhs.kind !== "Var") {
        throw new Error(
          `emit internal: IndexSliceStore tensor RHS must be a Var (got ${s.rhs.kind})`
        );
      }
      emitTensorRhsSizeCheck(s.rhs, lines, `${indent}  `);
      lines.push(
        `${indent}  for (long _mtoc2_k = 0; _mtoc2_k < _mtoc2_n; _mtoc2_k++) {`
      );
      lines.push(`${indent}    long _mtoc2_dst = ${dstOffsetFor("_mtoc2_k")};`);
      // RHS imag lane: prefer the source's imag when it has one;
      // otherwise write 0 (real-typed tensor RHS into complex base).
      const srcImag =
        baseIsComplex && rhsIsComplex
          ? `${s.rhs.cName}.imag[_mtoc2_k]`
          : undefined;
      lines.push(
        `${indent}    ${writeAt("_mtoc2_dst", `${s.rhs.cName}.real[_mtoc2_k]`, srcImag)}`
      );
      lines.push(`${indent}  }`);
    }
    if (linearStoreCleanup !== null) lines.push(linearStoreCleanup);
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

  let scalarSrcReal: string | undefined;
  let scalarSrcImag: string | undefined;
  if (rhsIsScalar) {
    const rhsExpr = emitExpr(s.rhs, state);
    if (rhsIsComplex) {
      lines.push(`${indent}  double _Complex _mtoc2_rhs = ${rhsExpr};`);
      scalarSrcReal = "mtoc2_creal(_mtoc2_rhs)";
      scalarSrcImag = "mtoc2_cimag(_mtoc2_rhs)";
    } else {
      lines.push(`${indent}  double _mtoc2_rhs = ${rhsExpr};`);
      scalarSrcReal = "_mtoc2_rhs";
    }
  } else {
    if (s.rhs.kind !== "Var") {
      throw new Error(
        `emit internal: IndexSliceStore tensor RHS must be a Var (got ${s.rhs.kind})`
      );
    }
    emitTensorRhsSizeCheck(s.rhs, lines, `${indent}  `);
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
      `${indent}  ${innerInd}${writeAt("_mtoc2_dst", scalarSrcReal!, scalarSrcImag)}`
    );
  } else {
    const rhs = s.rhs as Extract<IRExpr, { kind: "Var" }>;
    lines.push(
      `${indent}  ${innerInd}long _mtoc2_k = ${formatNdOffset(
        Array.from({ length: ndim }, (_, i) => `_mtoc2_k_${i}`),
        j => `_mtoc2_n_${j}`
      )};`
    );
    const srcImag =
      baseIsComplex && rhsIsComplex ? `${rhs.cName}.imag[_mtoc2_k]` : undefined;
    lines.push(
      `${indent}  ${innerInd}${writeAt("_mtoc2_dst", `${rhs.cName}.real[_mtoc2_k]`, srcImag)}`
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

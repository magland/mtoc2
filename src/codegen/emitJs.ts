/**
 * Single-file JS codegen for mtoc2 IR. Mirrors `emit.ts` (the C path)
 * intentionally — same control flow, same variable layout, same call
 * shape — differing only in language and the I/O primitive (`$write(s)`
 * vs `printf(...)`).
 *
 * MVP scope (Phase 2):
 *   - scalar `NumLit` / `ImagLit` / `StringLit` / `Var`
 *   - `Binary` / `Unary` / `Call` dispatching through `builtin.emitJs`
 *   - user-function calls (`<mangled>(args)` — owned-args copy semantics
 *     are a no-op in JS since GC handles ownership)
 *   - `Assign`, `ExprStmt`, `If`, `While`, `For`, `ReturnFromFunction`,
 *     `Break`, `Continue`, `TypeComment`, `MultiAssignCall` (single
 *     output)
 *
 * Explicit `UnsupportedConstruct` for IR shapes that aren't wired yet —
 * tensor literals/concat/index/range, handles/struct/class lit/loads/
 * stores, multi-output (N≥2) MultiAssignCall. Those will be added as
 * the per-builtin `emitJs` retrofits in Phase 5 demand them.
 *
 * Builtin dispatch routes through `builtin.emitJs`. If a needed
 * builtin has no `emitJs` hook yet, `requireEmitJs` throws a clear
 * "no emitJs hook" error — the engine catches that and falls back to
 * the interpreter (Phase 3).
 *
 * The emitted module has the shape:
 *   ```js
 *   <inlined runtime snippet bodies>
 *   function <user-fn-spec-1>(...) { ... }
 *   function <user-fn-spec-2>(...) { ... }
 *   function run($h) {
 *     globalThis.$write = $h.write;
 *     let v1, v2, ...;          // pre-declared locals
 *     ... top-level stmts ...
 *   }
 *   return run;
 *   ```
 *
 * The CLI / engine evals the source via `new Function(source)(...)`
 * which returns `run`, then invokes `run(ctx.helpers)`.
 */

import type {
  IRExpr,
  IRStmt,
  IRProgram,
  IRFunc,
  Assign,
  MultiAssignCall,
} from "../lowering/ir.js";
import { UnsupportedConstruct } from "../lowering/errors.js";
import { requireEmitJs } from "../lowering/builtins/registry.js";
import {
  lookupBuiltin,
  newRuntimeState,
  renderJsRuntimeBodies,
  useRuntimeByName,
  type RuntimeState,
  type WorkspaceLike,
  type InlineSnippet,
} from "./runtime.js";

export interface EmitJsOptions {
  /** Workspace context. Threaded through `RuntimeState` so emit-time
   *  builtin lookups consult `.mtoc2.js` user builtins. Optional. */
  workspace?: WorkspaceLike;
  /** Include the activated runtime helper bodies inline at the top of
   *  the emitted module. Default true. When false the placeholder
   *  comment lands instead — useful for the IDE preview. */
  includeRuntime?: boolean;
}

export interface EmitJsResult {
  /** Full module source — runtime snippets, user-function defs,
   *  `function run($h)`, trailing `return run;`. Ready for
   *  `new Function(...)`. */
  source: string;
  /** Names of every runtime snippet activated during emit (debug aid;
   *  also useful to gate dependency wiring in tests). */
  activatedSnippets: ReadonlyArray<string>;
}

// ── Entry ────────────────────────────────────────────────────────────────

export function emitJsProgram(
  prog: IRProgram,
  opts: EmitJsOptions = {}
): EmitJsResult {
  const state = newRuntimeState(opts.workspace);
  const includeRuntime = opts.includeRuntime ?? true;

  // Function bodies are emitted first so call sites in `main`
  // reference already-defined functions. (JS hoisting would make this
  // unnecessary, but the resulting source stays human-readable.)
  const userParts: string[] = [];
  for (const fn of prog.functions.values()) {
    userParts.push(emitFunction(fn, state));
    userParts.push("");
  }

  // Top-level wrapped in `function run($h)`.
  const topLines: string[] = [];
  topLines.push("function run($h) {");
  topLines.push("  globalThis.$write = $h.write;");
  const locals = collectAssignedLocals(prog.topLevelStmts);
  if (locals.length > 0) {
    topLines.push(`  let ${locals.join(", ")};`);
  }
  const bodyLines = emitBody(prog.topLevelStmts, "  ", state);
  if (bodyLines.length > 0) topLines.push(bodyLines);
  topLines.push("}");

  const out: string[] = [];
  if (state.active.size > 0) {
    out.push(
      includeRuntime
        ? renderJsRuntimeBodies(state)
        : runtimePlaceholder(state)
    );
    out.push("");
  }
  out.push(...userParts);
  out.push(...topLines);
  out.push("return run;");

  return {
    source: out.join("\n"),
    activatedSnippets: Array.from(state.active),
  };
}

function runtimePlaceholder(state: RuntimeState): string {
  if (state.active.size === 0) return "";
  const names = Array.from(state.active).join(", ");
  return `/* runtime helpers omitted (${state.active.size}): ${names} */`;
}

// ── User function specialization ─────────────────────────────────────────

function emitFunction(fn: IRFunc, state: RuntimeState): string {
  // Multi-output user functions return an array; single-output return
  // the bare value; zero-output return nothing. We keep parameter
  // passing identical (positional args, no out-pointers).
  const params = fn.cParams.join(", ");
  const lines: string[] = [];
  lines.push(`function ${fn.cName}(${params}) {`);

  // Pre-declare every locally-assigned name. Parameters are already
  // in scope via the function signature; outputs that are declared by
  // Assign get included naturally. Skip names that match a parameter
  // (they'd shadow with `let`).
  const paramSet = new Set(fn.cParams);
  const locals = collectAssignedLocals(fn.body).filter(n => !paramSet.has(n));
  if (locals.length > 0) {
    lines.push(`  let ${locals.join(", ")};`);
  }

  const bodyLines = emitBody(fn.body, "  ", state);
  if (bodyLines.length > 0) lines.push(bodyLines);

  // Implicit return at function end based on declared outputs.
  if (fn.outputs.length === 0) {
    // nothing — JS returns undefined.
  } else if (fn.outputs.length === 1) {
    lines.push(`  return ${fn.cOutputs[0]};`);
  } else {
    lines.push(`  return [${fn.cOutputs.join(", ")}];`);
  }
  lines.push("}");
  return lines.join("\n");
}

// ── Statement emission ───────────────────────────────────────────────────

function emitBody(
  stmts: ReadonlyArray<IRStmt>,
  indent: string,
  state: RuntimeState
): string {
  const out: string[] = [];
  for (const s of stmts) {
    const line = emitStmt(s, indent, state);
    if (line.length > 0) out.push(line);
  }
  return out.join("\n");
}

function emitStmt(s: IRStmt, indent: string, state: RuntimeState): string {
  switch (s.kind) {
    case "ExprStmt":
      return `${indent}${emitExpr(s.expr, state)};`;

    case "Assign":
      return `${indent}${s.cName} = ${emitExpr(s.expr, state)};`;

    case "If": {
      const lines: string[] = [];
      lines.push(`${indent}if (${truthy(s.cond, state)}) {`);
      const thenBody = emitBody(s.thenBody, indent + "  ", state);
      if (thenBody.length > 0) lines.push(thenBody);
      if (s.elseBody.length > 0) {
        lines.push(`${indent}} else {`);
        const elseBody = emitBody(s.elseBody, indent + "  ", state);
        if (elseBody.length > 0) lines.push(elseBody);
      }
      lines.push(`${indent}}`);
      return lines.join("\n");
    }

    case "While": {
      const lines: string[] = [];
      lines.push(`${indent}while (${truthy(s.cond, state)}) {`);
      const body = emitBody(s.body, indent + "  ", state);
      if (body.length > 0) lines.push(body);
      lines.push(`${indent}}`);
      return lines.join("\n");
    }

    case "For": {
      // MATLAB `for var = start:step:end` → JS loop. `step` is a
      // literal number on the IR (matches emitC's emit shape); start
      // and end are arbitrary expressions. Stash end in a fresh local
      // so the cond doesn't re-evaluate any side effects.
      const lines: string[] = [];
      const startE = emitExpr(s.start, state);
      const endE = emitExpr(s.end, state);
      const stepNum = s.step;
      const cmp = stepNum >= 0 ? "<=" : ">=";
      const stepStr = formatJsNumber(stepNum);
      lines.push(
        `${indent}for (let ${s.cVar} = ${startE}, __end_${s.cVar} = ${endE}; ` +
          `${s.cVar} ${cmp} __end_${s.cVar}; ${s.cVar} += ${stepStr}) {`
      );
      const body = emitBody(s.body, indent + "  ", state);
      if (body.length > 0) lines.push(body);
      lines.push(`${indent}}`);
      return lines.join("\n");
    }

    case "ReturnFromFunction":
      // Function body's implicit-return-at-end is emitted in
      // `emitFunction`; explicit return mid-body bails immediately
      // with whatever the declared outputs hold at this point.
      // (`fn.cOutputs` isn't visible here — emitFunction wraps with the
      // proper return form; an in-body return just `return;` and the
      // caller's destructure handles a bare `undefined` for 0-output.)
      // For multi-output bodies that hit a mid-body return we'd need
      // to plumb the outputs; defer until we hit a test that needs it.
      throw new UnsupportedConstruct(
        `emitJs: explicit 'return' inside a function body isn't wired ` +
          `yet (Phase 2 only handles fall-through return at function end)`,
        s.span
      );

    case "Break":
      return `${indent}break;`;

    case "Continue":
      return `${indent}continue;`;

    case "TypeComment": {
      // Debug aid — emit as a JS comment so the source stays readable.
      // mtoc2's TypeComment can show multiple variables in one block;
      // each gets its own comment line.
      const lines = s.entries.map(
        en => `${indent}// type ${en.name} (${en.cName}) :: ${typeToShortString(en.ty)}`
      );
      return lines.join("\n");
    }

    case "MultiAssignCall":
      return emitMultiAssignCall(s, indent, state);

    case "MemberStore":
    case "IndexStore":
    case "IndexSliceStore":
      throw new UnsupportedConstruct(
        `emitJs: '${s.kind}' is not yet wired (Phase 2 minimal subset)`,
        s.span
      );
  }
}

function emitMultiAssignCall(
  s: MultiAssignCall,
  indent: string,
  state: RuntimeState
): string {
  // Builtin path: dispatch through emitJs with outTargetsJs pre-built
  // as the destructure target names. JS destructure handles the
  // multi-return naturally.
  const args = s.args.map(a => emitExpr(a, state));
  // Slot targets: each declared output's cName, or a synthesized
  // discard slot name (matched by `collectAssignedLocals`).
  const targets: string[] = s.outputs.map((slot, i) =>
    slot.binding === null ? discardSlotName(i) : slot.binding.cName
  );

  const b = lookupBuiltin(state, s.name);
  if (b !== undefined) {
    const emit = requireEmitJs(b);
    // Builtins control the call shape. For JS we don't pass out-pointers
    // (no such concept); the emitJs hook receives `outTargetsJs` so it
    // can decide whether to emit a destructure (preferred) or direct
    // assignments. We default to a destructure wrapper here unless the
    // hook returns an explicit statement string.
    const callExpr = emit({
      argsJs: args,
      argTypes: s.args.map(a => a.ty),
      nargout: s.outputs.length,
      outTargetsJs: targets,
      useRuntime: makeJsUseRuntime(state),
    });
    return `${indent}[${targets.join(", ")}] = ${callExpr};`;
  }

  // User-function call: array-return ABI. The JS spec returns
  // `[o1, o2, ...]`; destructure at the call site.
  return `${indent}[${targets.join(", ")}] = ${s.cName}(${args.join(", ")});`;
}

// ── Expression emission ──────────────────────────────────────────────────

function emitExpr(e: IRExpr, state: RuntimeState): string {
  switch (e.kind) {
    case "NumLit":
      return formatJsNumber(e.value);

    case "ImagLit":
      // Scalar complex literal. The JS-side representation is
      // `{re, im}` (matching the `mtoc2_cscalar.js` snippet's helpers).
      // Activate it lazily so the call site can rely on it being
      // available; the actual helper functions get inlined alongside.
      // (Phase 5 will populate `cscalar.js`.)
      return `{re: 0, im: ${formatJsNumber(e.value)}}`;

    case "StringLit":
      return JSON.stringify(e.value);

    case "Var":
      return e.cName;

    case "Binary": {
      const b = lookupBuiltin(state, e.builtin);
      if (!b) {
        throw new Error(`emitJs: builtin '${e.builtin}' not found`);
      }
      return requireEmitJs(b)({
        argsJs: [emitExpr(e.left, state), emitExpr(e.right, state)],
        argTypes: [e.left.ty, e.right.ty],
        nargout: 1,
        useRuntime: makeJsUseRuntime(state),
      });
    }

    case "Unary": {
      const b = lookupBuiltin(state, e.builtin);
      if (!b) {
        throw new Error(`emitJs: builtin '${e.builtin}' not found`);
      }
      return requireEmitJs(b)({
        argsJs: [emitExpr(e.operand, state)],
        argTypes: [e.operand.ty],
        nargout: 1,
        useRuntime: makeJsUseRuntime(state),
      });
    }

    case "Call": {
      const b = lookupBuiltin(state, e.name);
      if (b !== undefined) {
        return requireEmitJs(b)({
          argsJs: e.args.map(a => emitExpr(a, state)),
          argTypes: e.args.map(a => a.ty),
          nargout: 1,
          useRuntime: makeJsUseRuntime(state),
        });
      }
      // User-function call. Owned arguments don't need a copy wrapper
      // in JS — GC handles lifetime.
      const args = e.args.map(a => emitExpr(a, state)).join(", ");
      return `${e.cName}(${args})`;
    }

    case "MakeRange": {
      const startE = emitExpr(e.start, state);
      const stepE = emitExpr(e.step, state);
      const endE = emitExpr(e.end, state);
      useRuntimeByName(state, "mtoc2_tensor_make_range");
      return `mtoc2_tensor_make_range(${startE}, ${stepE}, ${endE})`;
    }

    case "TensorBuild":
    case "TensorConcat":
    case "HandleLit":
    case "HandleCaptureLoad":
    case "StructLit":
    case "MemberLoad":
    case "IndexLoad":
    case "IndexSlice":
    case "EndRef":
      throw new UnsupportedConstruct(
        `emitJs: IR shape '${e.kind}' is not yet wired (Phase 2 minimal subset)`,
        e.span
      );
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function makeJsUseRuntime(
  state: RuntimeState
): (spec: string | InlineSnippet) => void {
  return spec => {
    if (typeof spec === "string") {
      useRuntimeByName(state, spec);
    } else {
      // Inline snippet — mirror the C path's `useRuntimeInline` but
      // keep both code + jsCode fields populated.
      if (!state.extraSnippets.has(spec.name)) {
        const stored = {
          headers: spec.headers ?? [],
          code: spec.code,
          deps: spec.deps ?? [],
          ...(spec.jsCode !== undefined ? { jsCode: spec.jsCode } : {}),
        };
        state.extraSnippets.set(spec.name, stored);
      }
      useRuntimeByName(state, spec.name);
    }
  };
}

/** Wrap a cond expression with the truthiness conversion that matches
 *  MATLAB's scalar-only short-circuit semantics — `cond !== 0` for
 *  numerics, otherwise direct (booleans, …). The minimal subset takes
 *  the easy path: trust the cond expression to evaluate as a JS
 *  truthy value. Complex / tensor / string conds will need explicit
 *  truthiness shims, which arrive when those types land in emitJs. */
function truthy(e: IRExpr, state: RuntimeState): string {
  return emitExpr(e, state);
}

/** Walk every Assign / MultiAssignCall in `stmts` and return the
 *  unique cNames they introduce (in source order). Used to pre-declare
 *  all locals at the top of a function / top-level body so subsequent
 *  bare assignments compile cleanly. */
function collectAssignedLocals(stmts: ReadonlyArray<IRStmt>): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const add = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    order.push(name);
  };
  const visit = (s: IRStmt): void => {
    switch (s.kind) {
      case "Assign":
        add((s as Assign).cName);
        break;
      case "MultiAssignCall":
        s.outputs.forEach((slot, i) => {
          if (slot.binding !== null) {
            add(slot.binding.cName);
          } else {
            // Discard slot needs a local too, to receive the JS
            // destructure (we can't use bare `_` because two adjacent
            // multi-assigns would conflict on it).
            add(discardSlotName(i));
          }
        });
        break;
      case "For":
        // Loop var is bound by the for-header itself; no pre-decl.
        for (const sub of s.body) visit(sub);
        break;
      case "While":
        for (const sub of s.body) visit(sub);
        break;
      case "If":
        for (const sub of s.thenBody) visit(sub);
        for (const sub of s.elseBody) visit(sub);
        break;
      default:
        break;
    }
  };
  for (const s of stmts) visit(s);
  return order;
}

function formatJsNumber(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "Infinity";
  if (v === -Infinity) return "-Infinity";
  if (Object.is(v, -0)) return "-0";
  return String(v);
}

function typeToShortString(t: import("../lowering/types.js").Type): string {
  // Cheap shape preview — full pretty-printing lives in
  // `lowering/types.ts::typeToString`. The comment is debug-only.
  return t.kind;
}

/** Stable name for a discard slot in a `MultiAssignCall` — used both
 *  by `collectAssignedLocals` (to pre-declare it) and by
 *  `emitMultiAssignCall` (to emit the destructure target). The index
 *  uniquifies adjacent discards at the same call site so a
 *  `[~, ~] = foo()` doesn't collide on one name. */
function discardSlotName(slotIdx: number): string {
  return `_mtoc2_discard_${slotIdx}`;
}

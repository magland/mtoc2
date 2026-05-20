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
import { isColVecTy, isRowVecTy } from "../lowering/types.js";
import { requireEmitJs } from "../builtins/registry.js";
import {
  lookupBuiltin,
  newRuntimeState,
  renderJsRuntimeBodies,
  useRuntimeByName,
  type RuntimeState,
  type WorkspaceLike,
  type InlineSnippet,
} from "./runtime.js";
import { emitTensorConcatJs } from "./emitTensorConcatJs.js";

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
      includeRuntime ? renderJsRuntimeBodies(state) : runtimePlaceholder(state)
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

  // Stash the current function's output cNames on the state so any
  // in-body `ReturnFromFunction` can emit `return <fn outputs>` with
  // the matching shape (bare value / array / nothing). Cleared after.
  const prevOutputs = state.currentFnOutputs;
  state.currentFnOutputs = fn.cOutputs;
  const bodyLines = emitBody(fn.body, "  ", state);
  state.currentFnOutputs = prevOutputs;
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

function emitReturnFromFunction(state: RuntimeState, indent: string): string {
  const outs = state.currentFnOutputs;
  if (outs === undefined || outs.length === 0) {
    return `${indent}return;`;
  }
  if (outs.length === 1) {
    return `${indent}return ${outs[0]};`;
  }
  return `${indent}return [${outs.join(", ")}];`;
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
      // Mirror the C path's loop shape so JS output stays
      // bit-identical to numbl: snapshot start/end once at loop
      // entry, derive the iteration count via `mtoc2_loop_count`,
      // and rebind the loop var via `mtoc2_range_value` per iter.
      // This keeps the loop body insensitive to mid-body mutations
      // of `start`/`end` (matching MATLAB) and leaves the loop var
      // at its last actual iterated value after the loop ends.
      // `s.cVar` is pre-declared at function top by
      // `collectAssignedLocals` so reads after the loop see it.
      useRuntimeByName(state, "mtoc2_loop_count");
      useRuntimeByName(state, "mtoc2_range_value");
      const lines: string[] = [];
      const startE = emitExpr(s.start, state);
      const endE = emitExpr(s.end, state);
      const stepStr = formatJsNumber(s.step);
      lines.push(`${indent}{`);
      lines.push(`${indent}  const _mtoc2_for_start = ${startE};`);
      lines.push(`${indent}  const _mtoc2_for_end = ${endE};`);
      lines.push(
        `${indent}  const _mtoc2_for_n = mtoc2_loop_count(_mtoc2_for_start, _mtoc2_for_end, ${stepStr});`
      );
      lines.push(
        `${indent}  for (let _mtoc2_for_i = 0; _mtoc2_for_i < _mtoc2_for_n; _mtoc2_for_i++) {`
      );
      lines.push(
        `${indent}    ${s.cVar} = mtoc2_range_value(_mtoc2_for_start, ${stepStr}, _mtoc2_for_end, _mtoc2_for_n, _mtoc2_for_i);`
      );
      const body = emitBody(s.body, indent + "    ", state);
      if (body.length > 0) lines.push(body);
      lines.push(`${indent}  }`);
      lines.push(`${indent}}`);
      return lines.join("\n");
    }

    case "ReturnFromFunction":
      // Mid-body return: bail with whatever the declared outputs hold
      // right now. `emitFunction` stashes the active fn's cOutputs on
      // `state.currentFnOutputs` so the return form here matches the
      // function-end return (bare value / array / nothing).
      return emitReturnFromFunction(state, indent);

    case "Break":
      return `${indent}break;`;

    case "Continue":
      return `${indent}continue;`;

    case "TypeComment": {
      // Debug aid — emit as a JS comment so the source stays readable.
      // mtoc2's TypeComment can show multiple variables in one block;
      // each gets its own comment line.
      const lines = s.entries.map(
        en =>
          `${indent}// type ${en.name} (${en.cName}) :: ${typeToShortString(en.ty)}`
      );
      return lines.join("\n");
    }

    case "MultiAssignCall":
      return emitMultiAssignCall(s, indent, state);

    case "IndexStore": {
      if (s.base.ty.kind === "Numeric" && s.base.ty.isComplex) {
        throw new UnsupportedConstruct(
          `emitJs: complex IndexStore not yet wired (Phase 5)`,
          s.span
        );
      }
      useRuntimeByName(state, "mtoc2_scalar_index");
      const baseName = s.base.cName;
      const idxs = s.indices.map(ix => emitExpr(ix, state));
      let offset: string;
      if (idxs.length === 1) {
        offset = `mtoc2_idx_lin_js(${baseName}, ${idxs[0]})`;
      } else {
        const terms: string[] = [];
        for (let i = 0; i < idxs.length; i++) {
          const checked = `mtoc2_idx_axis_js(${baseName}, ${i}, ${idxs[i]})`;
          if (i === 0) {
            terms.push(checked);
          } else {
            const strides: string[] = [];
            for (let j = 0; j < i; j++) strides.push(`${baseName}.shape[${j}]`);
            terms.push(`${checked} * ${strides.join(" * ")}`);
          }
        }
        offset = terms.join(" + ");
      }
      const rhs = emitExpr(s.rhs, state);
      return `${indent}${baseName}.data[${offset}] = ${rhs};`;
    }

    case "MemberStore":
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

    case "StringLit": {
      // Match the interpreter's RuntimeValue conventions so JS-side
      // builtin call hooks (disp, error, fprintf, …) see the same shape
      // regardless of which backend executes them: `String` → bare JS
      // string; `Char` → `{mtoc2Tag:"char", value:"..."}` wrapper.
      const lit = JSON.stringify(e.value);
      if (e.ty.kind === "Char") {
        return `({mtoc2Tag: "char", value: ${lit}})`;
      }
      return lit;
    }

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

    case "TensorBuild": {
      // Real-only path for now (complex would mirror the C side's
      // split re/im arrays once the JS complex tensor runtime lands).
      const [rows, cols] = e.shape;
      const ty = e.ty;
      if (ty.kind === "Numeric" && ty.isComplex) {
        throw new UnsupportedConstruct(
          `emitJs: complex TensorBuild not yet wired (Phase 5)`,
          e.span
        );
      }
      const flat = e.elements.map(el => emitExpr(el, state)).join(", ");
      if (rows === 1) {
        useRuntimeByName(state, "mtoc2_tensor_from_row");
        return `mtoc2_tensor_from_row([${flat}], ${cols})`;
      }
      useRuntimeByName(state, "mtoc2_tensor_from_matrix");
      return `mtoc2_tensor_from_matrix([${flat}], ${rows}, ${cols})`;
    }

    case "IndexLoad": {
      // Scalar tensor read: `v(i)` or `M(i, j)`. ANF guarantees the
      // base is a bare Var; bounds-checking happens at runtime via
      // the shared `scalar_index.js` helpers.
      if (e.base.kind !== "Var") {
        throw new Error(
          `emitJs internal: IndexLoad base must be a Var after ANF (got ${e.base.kind})`
        );
      }
      if (e.base.ty.kind === "Numeric" && e.base.ty.isComplex) {
        throw new UnsupportedConstruct(
          `emitJs: complex IndexLoad not yet wired (Phase 5)`,
          e.span
        );
      }
      useRuntimeByName(state, "mtoc2_scalar_index");
      const baseName = e.base.cName;
      const idxs = e.indices.map(ix => emitExpr(ix, state));
      let offset: string;
      if (idxs.length === 1) {
        offset = `mtoc2_idx_lin_js(${baseName}, ${idxs[0]})`;
      } else {
        const terms: string[] = [];
        for (let i = 0; i < idxs.length; i++) {
          const checked = `mtoc2_idx_axis_js(${baseName}, ${i}, ${idxs[i]})`;
          if (i === 0) {
            terms.push(checked);
          } else {
            const strides: string[] = [];
            for (let j = 0; j < i; j++) strides.push(`${baseName}.shape[${j}]`);
            terms.push(`${checked} * ${strides.join(" * ")}`);
          }
        }
        offset = terms.join(" + ");
      }
      return `${baseName}.data[${offset}]`;
    }

    case "EndRef": {
      if (e.baseTy.kind !== "Numeric") {
        throw new Error("emitJs internal: EndRef with non-numeric baseTy");
      }
      if (e.axis === "linear") return `${e.baseCName}.data.length`;
      return `${e.baseCName}.shape[${e.axis}]`;
    }

    case "TensorConcat": {
      const ty = e.ty;
      if (ty.kind === "Numeric" && ty.isComplex) {
        throw new UnsupportedConstruct(
          `emitJs: complex TensorConcat not yet wired (Phase 5)`,
          e.span
        );
      }
      return emitTensorConcatJs(e, state, emitExpr);
    }

    case "IndexSlice":
      return emitIndexSliceJs(e, state);

    case "HandleLit":
    case "HandleCaptureLoad":
    case "StructLit":
    case "MemberLoad":
      throw new UnsupportedConstruct(
        `emitJs: IR shape '${e.kind}' is not yet wired (Phase 2 minimal subset)`,
        e.span
      );
  }
}

function emitIndexSliceJs(
  e: Extract<IRExpr, { kind: "IndexSlice" }>,
  state: RuntimeState
): string {
  if (e.base.kind !== "Var") {
    throw new Error(
      `emitJs internal: IndexSlice base must be a Var after ANF (got ${e.base.kind})`
    );
  }
  if (e.base.ty.kind === "Numeric" && e.base.ty.isComplex) {
    throw new UnsupportedConstruct(
      `emitJs: complex IndexSlice not yet wired (Phase 5)`,
      e.span
    );
  }
  useRuntimeByName(state, "mtoc2_tensor_alloc_nd");
  const baseName = e.base.cName;

  // Single-slot linear form. Covers `v(:)`, `v(a:b)`, `v(idx_vec)`,
  // `v(mask)`. Multi-slot Scalar single-slot reads route through
  // IndexLoad, not IndexSlice, so we don't see them here.
  if (e.index.length === 1) {
    const slot = e.index[0];
    const baseNum = e.base.ty.kind === "Numeric" ? e.base.ty : undefined;
    const isColVec = baseNum !== undefined && isColVecTy(baseNum);
    const isRowVec = baseNum !== undefined && isRowVecTy(baseNum);
    if (slot.kind === "Colon") {
      return (
        `(() => { ` +
        `const _mtoc2_n = ${baseName}.data.length; ` +
        `const _mtoc2_t = mtoc2_tensor_alloc_nd(2, [_mtoc2_n, 1]); ` +
        `for (let _mtoc2_k = 0; _mtoc2_k < _mtoc2_n; _mtoc2_k++) ` +
        `_mtoc2_t.data[_mtoc2_k] = ${baseName}.data[_mtoc2_k]; ` +
        `return _mtoc2_t; ` +
        `})()`
      );
    }
    if (slot.kind === "Range") {
      useRuntimeByName(state, "mtoc2_loop_count");
      useRuntimeByName(state, "mtoc2_range_value");
      const s = emitExpr(slot.start, state);
      const st = emitExpr(slot.step, state);
      const en = emitExpr(slot.end, state);
      const rows = isColVec ? "_mtoc2_n" : "1";
      const cols = isColVec ? "1" : "_mtoc2_n";
      return (
        `(() => { ` +
        `const _mtoc2_s = ${s}; const _mtoc2_e = ${en}; const _mtoc2_st = ${st}; ` +
        `const _mtoc2_n = mtoc2_loop_count(_mtoc2_s, _mtoc2_e, _mtoc2_st); ` +
        `const _mtoc2_t = mtoc2_tensor_alloc_nd(2, [${rows}, ${cols}]); ` +
        `for (let _mtoc2_k = 0; _mtoc2_k < _mtoc2_n; _mtoc2_k++) { ` +
        `const _mtoc2_v = mtoc2_range_value(_mtoc2_s, _mtoc2_st, _mtoc2_e, _mtoc2_n, _mtoc2_k); ` +
        `_mtoc2_t.data[_mtoc2_k] = ${baseName}.data[Math.trunc(_mtoc2_v) - 1]; ` +
        `} ` +
        `return _mtoc2_t; ` +
        `})()`
      );
    }
    if (slot.kind === "Scalar") {
      // Single-slot Scalar should have routed to IndexLoad; this is
      // a safety net.
      throw new UnsupportedConstruct(
        `emitJs internal: single-slot Scalar IndexSlice should route to IndexLoad`,
        e.span
      );
    }
    if (slot.kind === "IndexVec") {
      const idx = emitExpr(slot.expr, state);
      const rows = isRowVec ? "1" : "_mtoc2_n";
      const cols = isRowVec ? "_mtoc2_n" : "1";
      return (
        `(() => { ` +
        `const _mtoc2_ix = ${idx}; ` +
        `const _mtoc2_ixd = _mtoc2_ix.mtoc2Tag === "tensor" ? _mtoc2_ix.data : [_mtoc2_ix]; ` +
        `const _mtoc2_n = _mtoc2_ixd.length; ` +
        `const _mtoc2_t = mtoc2_tensor_alloc_nd(2, [${rows}, ${cols}]); ` +
        `for (let _mtoc2_k = 0; _mtoc2_k < _mtoc2_n; _mtoc2_k++) ` +
        `_mtoc2_t.data[_mtoc2_k] = ${baseName}.data[Math.trunc(_mtoc2_ixd[_mtoc2_k]) - 1]; ` +
        `return _mtoc2_t; ` +
        `})()`
      );
    }
    // LogicalMask — wire when needed.
    throw new UnsupportedConstruct(
      `emitJs: IndexSlice single-slot '${slot.kind}' not yet wired`,
      e.span
    );
  }

  // Multi-slot per-axis form. Each slot maps to a per-axis count and
  // a per-iteration 1-based source-index expression. The result is
  // allocated with the slot counts as its dims (rank-2 floor; trailing
  // exact-1 axes already collapsed by the lowerer's transfer).
  const ndim = e.index.length;
  const setup: string[] = [];
  const idxFns: string[] = [];
  const dims: string[] = [];
  for (let i = 0; i < ndim; i++) {
    const slot = e.index[i];
    if (slot.kind === "Colon") {
      setup.push(`const _mtoc2_n_${i} = ${baseName}.shape[${i}] ?? 1;`);
      dims.push(`_mtoc2_n_${i}`);
      idxFns.push(`(_mtoc2_k_${i} + 1)`);
    } else if (slot.kind === "Range") {
      useRuntimeByName(state, "mtoc2_loop_count");
      useRuntimeByName(state, "mtoc2_range_value");
      const s = emitExpr(slot.start, state);
      const st = emitExpr(slot.step, state);
      const en = emitExpr(slot.end, state);
      setup.push(
        `const _mtoc2_s_${i} = ${s}, _mtoc2_e_${i} = ${en}, _mtoc2_st_${i} = ${st};`
      );
      setup.push(
        `const _mtoc2_n_${i} = mtoc2_loop_count(_mtoc2_s_${i}, _mtoc2_e_${i}, _mtoc2_st_${i});`
      );
      dims.push(`_mtoc2_n_${i}`);
      idxFns.push(
        `mtoc2_range_value(_mtoc2_s_${i}, _mtoc2_st_${i}, _mtoc2_e_${i}, _mtoc2_n_${i}, _mtoc2_k_${i})`
      );
    } else if (slot.kind === "Scalar") {
      const v = emitExpr(slot.expr, state);
      setup.push(`const _mtoc2_s_${i} = ${v};`);
      setup.push(`const _mtoc2_n_${i} = 1;`);
      dims.push(`1`);
      idxFns.push(`_mtoc2_s_${i}`);
    } else if (slot.kind === "IndexVec") {
      const idxE = emitExpr(slot.expr, state);
      setup.push(
        `const _mtoc2_ix_${i} = ${idxE}; ` +
          `const _mtoc2_ixd_${i} = _mtoc2_ix_${i}.mtoc2Tag === "tensor" ? _mtoc2_ix_${i}.data : [_mtoc2_ix_${i}];`
      );
      setup.push(`const _mtoc2_n_${i} = _mtoc2_ixd_${i}.length;`);
      dims.push(`_mtoc2_n_${i}`);
      idxFns.push(`_mtoc2_ixd_${i}[_mtoc2_k_${i}]`);
    } else {
      throw new UnsupportedConstruct(
        `emitJs: IndexSlice multi-slot '${slot.kind}' not yet wired`,
        e.span
      );
    }
  }
  // Pad to rank-2 floor with trailing 1s in the result shape.
  const resultDims = dims.slice();
  while (resultDims.length < 2) resultDims.push("1");

  const lines: string[] = [];
  for (const s of setup) lines.push(s);
  lines.push(
    `const _mtoc2_t = mtoc2_tensor_alloc_nd(${resultDims.length}, [${resultDims.join(", ")}]);`
  );
  for (let i = ndim - 1; i >= 0; i--) {
    lines.push(
      `for (let _mtoc2_k_${i} = 0; _mtoc2_k_${i} < _mtoc2_n_${i}; _mtoc2_k_${i}++) {`
    );
  }
  // Column-major source offset: sum_i (idxFn[i] - 1) * stride[i] where
  // stride[i] = product of base.shape[0..i).
  const srcTerms: string[] = [];
  for (let i = 0; i < ndim; i++) {
    const strideParts: string[] = [];
    for (let j = 0; j < i; j++) {
      strideParts.push(`(${baseName}.shape[${j}] ?? 1)`);
    }
    const stride = strideParts.length === 0 ? "1" : strideParts.join(" * ");
    srcTerms.push(`(Math.trunc(${idxFns[i]}) - 1) * ${stride}`);
  }
  // Column-major destination offset using the result's own dims.
  const dstTerms: string[] = [];
  for (let i = 0; i < ndim; i++) {
    const strideParts: string[] = [];
    for (let j = 0; j < i; j++) strideParts.push(dims[j]);
    const stride = strideParts.length === 0 ? "1" : strideParts.join(" * ");
    dstTerms.push(`_mtoc2_k_${i} * ${stride}`);
  }
  lines.push(`const _mtoc2_src_off = ${srcTerms.join(" + ")};`);
  lines.push(`const _mtoc2_dst_off = ${dstTerms.join(" + ")};`);
  lines.push(
    `_mtoc2_t.data[_mtoc2_dst_off] = ${baseName}.data[_mtoc2_src_off];`
  );
  for (let i = ndim - 1; i >= 0; i--) lines.push(`}`);
  lines.push(`return _mtoc2_t;`);
  return `(() => { ${lines.join(" ")} })()`;
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
        // Pre-declare the loop var at the enclosing function scope so
        // it stays visible after the loop ends (MATLAB-style).
        add(s.cVar);
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

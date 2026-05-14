/**
 * mtoc2 runtime helpers — small C snippets inlined into the generated
 * source on demand.
 *
 * Each helper lives in its own .h file under `runtime/` so it can be
 * edited with normal C tooling (clangd, syntax highlighting). The .h
 * sources are inlined into `runtime/snippets.gen.ts` by
 * `scripts/build_runtime_snippets.ts`; this module reads them from
 * there (rather than the filesystem at load time) so the translator
 * bundles in the browser.
 *
 * Each helper is referenced by a stable name (e.g. "mtoc2_disp_double").
 * Snippets can declare other snippets they depend on; the activator
 * pulls dependencies in first.
 */

import { SNIPPETS } from "./runtime/snippets.gen.js";

export interface RuntimeSnippet {
  /** Standard-library headers parsed out of the source file. */
  headers: ReadonlyArray<string>;
  /** Body of the snippet (definitions only — `#include`s removed). */
  code: string;
  /** Other helpers (by name) this snippet depends on. The activator
   *  pulls these in first so their definitions come before this
   *  snippet's. Cycles are not supported — keep the graph acyclic. */
  deps: ReadonlyArray<string>;
}

/**
 * Parse a raw snippet source string into its `headers` and `code` parts.
 *
 * The strict `#include` pattern accepted is:
 *   optional-whitespace `#` optional-whitespace `include`
 *   whitespace `<header>` or `"header"` optional-trailing-whitespace
 *
 * Any line whose trimmed form starts with `#include` but does NOT match
 * that pattern is rejected.
 */
export function parseSnippetSource(raw: string): {
  headers: string[];
  code: string;
} {
  const headers: string[] = [];
  const bodyLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*#\s*include\s+(<[^>]+>|"[^"]+")\s*$/);
    if (m) {
      headers.push(m[1]);
    } else if (/^\s*#\s*include\b/.test(line)) {
      throw new Error(
        `runtime snippet: unexpected #include form: ${JSON.stringify(line)}; ` +
          `expected '#include <header>' or '#include "header"' with no trailing content`
      );
    } else {
      bodyLines.push(line);
    }
  }
  while (bodyLines.length && bodyLines[0].trim() === "") bodyLines.shift();
  while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === "")
    bodyLines.pop();
  return { headers, code: bodyLines.join("\n") + "\n" };
}

function loadSnippet(
  filename: string,
  deps: ReadonlyArray<string> = []
): RuntimeSnippet {
  const raw = SNIPPETS[filename];
  if (raw === undefined) {
    throw new Error(
      `runtime snippet '${filename}' not found in snippets.gen.ts; ` +
        `re-run 'npm run build:snippets' after adding the .h file`
    );
  }
  const { headers, code } = parseSnippetSource(raw);
  return { headers, code, deps };
}

// ── Registry ──────────────────────────────────────────────────────────

/** Snippet name → snippet definition. The name is the C identifier the
 *  emitted code calls (e.g. `mtoc2_disp_double`). */
const REGISTRY: ReadonlyMap<string, RuntimeSnippet> = new Map<
  string,
  RuntimeSnippet
>([
  ["mtoc2_format_double", loadSnippet("format_double.h")],
  ["mtoc2_disp_double", loadSnippet("disp_double.h", ["mtoc2_format_double"])],

  // ── Text (string + char tensor) ───────────────────────────────────
  // Two distinct owned kinds: `mtoc2_string_t` (scalar handle,
  // double-quoted) and `mtoc2_char_tensor_t` (1×N row-vector of bytes,
  // single-quoted). Each ships the four owned-value helpers
  // (empty/assign/copy/free) plus a literal builder that points at
  // a `.rodata` C string (no allocation). The non-owning
  // `mtoc2_text_view_t` adapter lets read-only helpers (disp, future
  // error/strcmp/fprintf) walk either source uniformly.
  ["mtoc2_string_t", loadSnippet("string.h")],
  ["mtoc2_string_empty", loadSnippet("string_empty.h", ["mtoc2_string_t"])],
  ["mtoc2_string_free", loadSnippet("string_free.h", ["mtoc2_string_t"])],
  [
    "mtoc2_string_assign",
    loadSnippet("string_assign.h", ["mtoc2_string_t", "mtoc2_string_free"]),
  ],
  ["mtoc2_string_copy", loadSnippet("string_copy.h", ["mtoc2_string_t"])],
  [
    "mtoc2_string_from_literal",
    loadSnippet("string_from_literal.h", ["mtoc2_string_t"]),
  ],
  ["mtoc2_char_tensor_t", loadSnippet("char_tensor.h")],
  [
    "mtoc2_char_tensor_empty",
    loadSnippet("char_tensor_empty.h", ["mtoc2_char_tensor_t"]),
  ],
  [
    "mtoc2_char_tensor_free",
    loadSnippet("char_tensor_free.h", ["mtoc2_char_tensor_t"]),
  ],
  [
    "mtoc2_char_tensor_assign",
    loadSnippet("char_tensor_assign.h", [
      "mtoc2_char_tensor_t",
      "mtoc2_char_tensor_free",
    ]),
  ],
  [
    "mtoc2_char_tensor_copy",
    loadSnippet("char_tensor_copy.h", ["mtoc2_char_tensor_t"]),
  ],
  [
    "mtoc2_char_tensor_from_literal",
    loadSnippet("char_tensor_from_literal.h", ["mtoc2_char_tensor_t"]),
  ],
  [
    "mtoc2_text_view_t",
    loadSnippet("text_view.h", ["mtoc2_string_t", "mtoc2_char_tensor_t"]),
  ],
  ["mtoc2_disp_text", loadSnippet("disp_text.h", ["mtoc2_text_view_t"])],

  // ── Format engine + fprintf ───────────────────────────────────────
  // `format_engine.h` is the numbl-compatible printf walker shared by
  // fprintf and (future) sprintf. It declares `mtoc2_fprintf_arg_t`
  // (a tagged union) for arg transport; codegen builds a per-call
  // compound-literal array. Depends on the tensor type for the tensor-
  // flattening slot kind and on the text view for the format string.
  [
    "mtoc2_format_engine",
    loadSnippet("format_engine.h", ["mtoc2_text_view_t", "mtoc2_tensor_t"]),
  ],
  ["mtoc2_fprintf", loadSnippet("fprintf.h", ["mtoc2_format_engine"])],
  ["mtoc2_error_fmt", loadSnippet("error_fmt.h", ["mtoc2_format_engine"])],

  // ── Tensor (real, multi-element) ──────────────────────────────────
  // Storage shape + alloc + the four "owned value" helpers (copy,
  // assign, free, plus the `from_row`/`from_matrix` literal builders).
  // Matches mtoc's runtime — no refcount, no COW; the codegen
  // invariant is "every tensor RHS is freshly owned, every Var read
  // wraps in mtoc2_tensor_copy".
  ["mtoc2_alloc", loadSnippet("alloc.h")],
  ["mtoc2_tensor_t", loadSnippet("tensor.h")],
  [
    "mtoc2_tensor_alloc",
    loadSnippet("tensor_alloc.h", ["mtoc2_tensor_t", "mtoc2_alloc"]),
  ],
  ["mtoc2_tensor_empty", loadSnippet("tensor_empty.h", ["mtoc2_tensor_t"])],
  [
    "mtoc2_tensor_copy",
    loadSnippet("tensor_copy.h", [
      "mtoc2_tensor_t",
      "mtoc2_alloc",
      "mtoc2_tensor_empty",
    ]),
  ],
  ["mtoc2_tensor_assign", loadSnippet("tensor_assign.h", ["mtoc2_tensor_t"])],
  ["mtoc2_tensor_free", loadSnippet("tensor_free.h", ["mtoc2_tensor_t"])],
  [
    "mtoc2_tensor_from_row",
    loadSnippet("tensor_from_row.h", ["mtoc2_tensor_alloc"]),
  ],
  [
    "mtoc2_tensor_from_matrix",
    loadSnippet("tensor_from_matrix.h", ["mtoc2_tensor_alloc"]),
  ],
  // ND alloc + fill helpers — additive to the 2-D `mtoc2_tensor_alloc`
  // fast path. `zeros`/`ones` builtins emit calls into these regardless
  // of rank (the C compiler inlines the small fill loop just fine).
  [
    "mtoc2_tensor_alloc_nd",
    loadSnippet("tensor_alloc_nd.h", ["mtoc2_tensor_t", "mtoc2_alloc"]),
  ],
  [
    "mtoc2_tensor_zeros_nd",
    loadSnippet("tensor_zeros_nd.h", ["mtoc2_tensor_alloc_nd"]),
  ],
  [
    "mtoc2_tensor_ones_nd",
    loadSnippet("tensor_ones_nd.h", ["mtoc2_tensor_alloc_nd"]),
  ],
  // Single-eval companion to the `_nd` helpers for the
  // `zeros(n)` / `ones(n)` n×n shorthand when `n` is a runtime
  // expression. Taking the dim by parameter avoids duplicating any
  // side-effecting source-level expression.
  [
    "mtoc2_tensor_zeros_square",
    loadSnippet("tensor_zeros_square.h", ["mtoc2_tensor_zeros_nd"]),
  ],
  [
    "mtoc2_tensor_ones_square",
    loadSnippet("tensor_ones_square.h", ["mtoc2_tensor_ones_nd"]),
  ],
  [
    "mtoc2_reshape_nd",
    loadSnippet("tensor_reshape_nd.h", ["mtoc2_tensor_alloc_nd"]),
  ],
  // 2-D non-conjugate transpose. The `.'` and `'` unary operators
  // both map here (the conjugate variant matters only for complex
  // tensors, which mtoc2 doesn't yet have).
  [
    "mtoc2_tensor_transpose",
    loadSnippet("tensor_transpose.h", ["mtoc2_tensor_t", "mtoc2_alloc"]),
  ],
  // `size(t)` row-vector form. The `size(t, k)` scalar form emits
  // inline C; this snippet covers only the variadic-shape return.
  [
    "mtoc2_tensor_size_row",
    loadSnippet("tensor_size.h", ["mtoc2_tensor_t", "mtoc2_alloc"]),
  ],
  // Generic axis-flip: `flipud` → axis 0, `fliplr` → axis 1,
  // `flip(t, k)` → axis (k-1). All three source-level builtins share
  // this helper.
  [
    "mtoc2_tensor_flip",
    loadSnippet("tensor_flip.h", ["mtoc2_tensor_t", "mtoc2_alloc"]),
  ],
  // `assert(cond, msg)` runtime check (scalar cond). The truthy fast
  // path returns immediately; failure writes the message to stderr
  // and aborts.
  ["mtoc2_assert_scalar", loadSnippet("assert_fail.h")],
  // Elementwise logical ops on real tensors. `~` (unary not) is the
  // only resident today; `|` / `&` will share the same snippet when
  // they land. Result tensors are logical-typed; the storage is still
  // `double` (the type system carries the logical flag).
  [
    "mtoc2_tensor_logical_real",
    loadSnippet("tensor_logical_real.h", ["mtoc2_tensor_t", "mtoc2_alloc"]),
  ],
  [
    "mtoc2_disp_tensor",
    loadSnippet("disp_tensor.h", ["mtoc2_tensor_t", "mtoc2_format_double"]),
  ],

  // ── Elementwise binary/unary on real tensors ──────────────────────
  // One snippet covers all 11 funcs (4×_tt, 4×_ts, 2×_st, 1×uminus).
  // Builtins activate by op-specific synthetic name; all map to the
  // same underlying snippet via dep, so dedupe is automatic.
  [
    "mtoc2_tensor_elemwise_real",
    loadSnippet("tensor_elemwise_real.h", ["mtoc2_tensor_t", "mtoc2_alloc"]),
  ],

  // Elementwise binary functions on real tensors — `mod`, `rem`,
  // `atan2`, `hypot`. Sibling of `tensor_elemwise_real.h` but the
  // kernel is `FN(a,b)` instead of `a OP b`. Carried in its own
  // snippet so the four function builtins activate it independent
  // of the infix-op set.
  [
    "mtoc2_tensor_elemwise_real_fn",
    loadSnippet("tensor_elemwise_real_fn.h", ["mtoc2_tensor_t", "mtoc2_alloc"]),
  ],

  // Elementwise unary math on real tensors (`cos`/`sin`/`sqrt`/`abs`/
  // `log`/…). One shared snippet defines `mtoc2_tensor_<name>` for
  // every per-name helper; every unary math builtin activates this
  // single snippet via its runtimeDeps.
  [
    "mtoc2_tensor_unary_real_math",
    loadSnippet("tensor_unary_real_math.h", ["mtoc2_tensor_t", "mtoc2_alloc"]),
  ],

  // ── Reductions (sum/prod/mean/min/max/any/all on real tensors) ────
  // One shared snippet defines every `_all` + `_dim` variant via
  // C-side macros; the per-name entries below pull it in transitively
  // so any reducer builtin's `runtimeDeps` activates the whole pack
  // (dedupe is automatic via the snippet activator).
  [
    "mtoc2_tensor_reduce_real",
    loadSnippet("tensor_reduce_real.h", [
      "mtoc2_tensor_t",
      "mtoc2_alloc",
      "mtoc2_tensor_alloc_nd",
    ]),
  ],
  [
    "mtoc2_sum_all",
    { headers: [], code: "", deps: ["mtoc2_tensor_reduce_real"] },
  ],
  [
    "mtoc2_sum_dim",
    { headers: [], code: "", deps: ["mtoc2_tensor_reduce_real"] },
  ],
  [
    "mtoc2_prod_all",
    { headers: [], code: "", deps: ["mtoc2_tensor_reduce_real"] },
  ],
  [
    "mtoc2_prod_dim",
    { headers: [], code: "", deps: ["mtoc2_tensor_reduce_real"] },
  ],
  [
    "mtoc2_mean_all",
    { headers: [], code: "", deps: ["mtoc2_tensor_reduce_real"] },
  ],
  [
    "mtoc2_mean_dim",
    { headers: [], code: "", deps: ["mtoc2_tensor_reduce_real"] },
  ],
  [
    "mtoc2_min_all",
    { headers: [], code: "", deps: ["mtoc2_tensor_reduce_real"] },
  ],
  [
    "mtoc2_min_dim",
    { headers: [], code: "", deps: ["mtoc2_tensor_reduce_real"] },
  ],
  [
    "mtoc2_max_all",
    { headers: [], code: "", deps: ["mtoc2_tensor_reduce_real"] },
  ],
  [
    "mtoc2_max_dim",
    { headers: [], code: "", deps: ["mtoc2_tensor_reduce_real"] },
  ],
  [
    "mtoc2_any_all",
    { headers: [], code: "", deps: ["mtoc2_tensor_reduce_real"] },
  ],
  [
    "mtoc2_any_dim",
    { headers: [], code: "", deps: ["mtoc2_tensor_reduce_real"] },
  ],
  [
    "mtoc2_all_all",
    { headers: [], code: "", deps: ["mtoc2_tensor_reduce_real"] },
  ],
  [
    "mtoc2_all_dim",
    { headers: [], code: "", deps: ["mtoc2_tensor_reduce_real"] },
  ],

  // ── length / numel (tensor → scalar shape queries) ───────────────
  ["mtoc2_length", loadSnippet("length.h", ["mtoc2_tensor_t"])],
  ["mtoc2_numel", loadSnippet("numel.h", ["mtoc2_tensor_t"])],

  // ── Indexing / slicing / range-as-value ──────────────────────────
  // `mtoc2_loop_count` powers every `start:step:end` count computation
  // (single-slot slice reads/writes, multi-slot per-axis setup, and the
  // MakeRange value-form helper).
  ["mtoc2_loop_count", loadSnippet("loop_count.h")],
  ["mtoc2_range_value", loadSnippet("range_value.h")],
  // OOB family — `mtoc2_idx_axis`, `mtoc2_idx_lin`, and
  // `mtoc2_check_axis_range` share `mtoc2_oob_abort`; activated as
  // one snippet so any IndexLoad/IndexStore/IndexSlice site that
  // pulls in one bounds-check fn pulls in the others' definitions
  // for free.
  ["mtoc2_oob_abort", loadSnippet("oob.h", ["mtoc2_tensor_t"])],
  [
    "mtoc2_tensor_make_range",
    loadSnippet("tensor_make_range.h", [
      "mtoc2_tensor_t",
      "mtoc2_tensor_alloc_nd",
      "mtoc2_loop_count",
      "mtoc2_range_value",
    ]),
  ],

  // ── tic / toc (wall-clock stopwatch) ─────────────────────────────
  // One snippet covers `mtoc2_tic`, `mtoc2_toc`, and the bare-`toc;`
  // print form `mtoc2_toc_print`. Activated by the `tic`/`toc`
  // builtins and (for the print form) by the lowerer when a bare
  // `toc;` ExprStmt synthesizes a direct Call to `mtoc2_toc_print`.
  ["mtoc2_tic_toc", loadSnippet("tictoc.h")],
]);

export function getRuntimeSnippet(name: string): RuntimeSnippet {
  const s = REGISTRY.get(name);
  if (!s) {
    throw new Error(`runtime snippet '${name}' not registered`);
  }
  return s;
}

// ── Activation state + topological emit ────────────────────────────────

export interface RuntimeState {
  /** Insertion-ordered set of activated snippet names. */
  active: Set<string>;
  /** Counter for `MultiAssignCall` discard-temp suffixes so adjacent
   *  multi-output call sites don't collide on `_mtoc2_discard_<N>_<i>`
   *  names. Incremented each time a multi-output call is emitted. */
  multiAssignCallCounter: number;
}

export function newRuntimeState(): RuntimeState {
  return { active: new Set(), multiAssignCallCounter: 0 };
}

/** Activate a snippet by its registered name. Pulls its `deps` in first
 *  so they appear before it in the final emission order. Idempotent. */
export function useRuntimeByName(state: RuntimeState, name: string): void {
  if (state.active.has(name)) return;
  const s = getRuntimeSnippet(name);
  for (const d of s.deps) useRuntimeByName(state, d);
  state.active.add(name);
}

/** All headers required by the activated snippets, in insertion order. */
export function collectRuntimeHeaders(state: RuntimeState): string[] {
  const headers = new Set<string>();
  for (const name of state.active) {
    const s = getRuntimeSnippet(name);
    for (const h of s.headers) headers.add(h);
  }
  return Array.from(headers);
}

/** Concatenated bodies (definitions) of activated snippets, in
 *  activation (dep-respecting) order. */
export function renderRuntimeBodies(state: RuntimeState): string {
  if (state.active.size === 0) return "";
  const bodies: string[] = [];
  for (const name of state.active) {
    const s = getRuntimeSnippet(name);
    bodies.push(s.code);
  }
  return bodies.join("\n");
}

/** Stable always-emitted header set — every translation includes these
 *  so the user-level code can rely on stdio/math without each builtin
 *  re-declaring them. Kept tiny on purpose. */
export const BASE_HEADERS: ReadonlyArray<string> = [
  "<stdio.h>",
  "<stdlib.h>",
  "<math.h>",
];

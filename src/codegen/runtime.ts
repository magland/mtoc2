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
    loadSnippet("tensor_copy.h", ["mtoc2_tensor_t", "mtoc2_alloc"]),
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
  [
    "mtoc2_disp_tensor",
    loadSnippet("disp_tensor.h", ["mtoc2_tensor_t", "mtoc2_format_double"]),
  ],
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
}

export function newRuntimeState(): RuntimeState {
  return { active: new Set() };
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

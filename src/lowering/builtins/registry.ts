/**
 * Builtin registry — the contract every mtoc2 builtin (and future user
 * `.mtoc2.js` function) implements.
 *
 *   transfer(argTypes, nargout) — given input types and the number of
 *     outputs the call site wants, return one Type per output. When
 *     every input is exact, set `exact` on the returned type(s) so the
 *     lowerer can key specialization on the value (and fold `if`
 *     conditions). Throws plain `Error` / `TypeError` /
 *     `UnsupportedConstruct` on bad input — no source span; the
 *     framework attaches the call-site span via `withSpan`.
 *
 *   emit({argsC, argTypes, nargout, outArgsC?, useRuntime}) — emit the
 *     full C call string. For nargout=1 that's a C expression
 *     (`(a + b)`, `mtoc2_tensor_plus_tt(a, b)`); for nargout≥2 it's
 *     the complete helper invocation including out-pointer args
 *     (`mtoc2_sort_real_2(a, &v, &i)`). Activate any runtime snippets
 *     this emit-output references by calling `useRuntime(name)`.
 *
 *   elementwise? — when true, `emit` must also produce a correct
 *     scalar C expression when called with scalar-form argsC and
 *     scalar argTypes. The framework uses this for same-shape tensor
 *     fusion (and, later, broadcasting / reduction-inner / mask /
 *     stencil fusion). Absence = "do not fuse me; use my regular
 *     emit on the full tensor types."
 */

import type { Type } from "../types.js";

export interface Builtin {
  /** Source-level name (registry key). */
  name: string;

  /** Output type(s) for an `nargout`-output call. Returned array
   *  length must equal `nargout`. Throws on bad arg count, bad arg
   *  types, or unsupported nargout (plain Error / TypeError /
   *  UnsupportedConstruct — no source span). Pure: safe to invoke as
   *  a probe (the framework calls this for bare-identifier 0-arg
   *  detection). */
  transfer(argTypes: Type[], nargout: number): Type[];

  /** Emit C for this call. Returns the full string ready to splice
   *  into the surrounding context:
   *    - nargout=1: a C *expression*
   *    - nargout≥2: a full call including out-pointer args, e.g.
   *      `mtoc2_sort_real_2(a, &v, &i)`. `outArgsC` holds those
   *      pre-built `&v`, `&i` strings in the order the call site
   *      requested. */
  emit(args: EmitArgs): string;

  /** Elementwise = result is computed pointwise from corresponding
   *  slots of each input. Implies `emit`, called with scalar
   *  `argTypes` and scalar-form `argsC`, returns a scalar C
   *  expression suitable for inlining at one slot of a fused loop.
   *  The framework uses this to fuse tensor-Assign elementwise ops
   *  (and, later, broadcasting and other fusion modes). */
  elementwise?: boolean;
}

export interface EmitArgs {
  /** Per-arg C expression. In fused contexts this is scalar form
   *  (e.g. `<var>.real[i]`); in the regular path it's whatever the
   *  framework's `emitExpr` produced. */
  argsC: string[];
  /** Per-arg type. In fused contexts the framework supplies the
   *  scalar version of each tensor operand's type; `emit` reads
   *  these to pick its branch the same way it does for a scalar call
   *  site. */
  argTypes: Type[];
  /** Number of outputs requested at the call site. */
  nargout: number;
  /** Out-pointer C expressions for multi-output calls (length =
   *  nargout when nargout≥2; otherwise empty/undefined). The
   *  framework pre-builds these as `&v`, `&i`, … so `emit` just
   *  splices them in. */
  outArgsC?: string[];
  /** Activate a runtime C snippet by name. Idempotent; the framework
   *  dedupes and orders deps automatically. */
  useRuntime(name: string): void;
}

// ── Registry ────────────────────────────────────────────────────────────

const REGISTRY = new Map<string, Builtin>();

export function registerBuiltin(b: Builtin): void {
  // Overwrite rather than throw on duplicate: the registration list is
  // static and a real duplicate is obvious at the call site, while a throw
  // here breaks Vite HMR (the registry module instance survives reloads
  // but importers re-run their registration side-effects).
  REGISTRY.set(b.name, b);
}

export function getBuiltin(name: string): Builtin | undefined {
  return REGISTRY.get(name);
}

/** Names of every registered builtin. Drives Monaco syntax highlighting. */
export function allBuiltinNames(): readonly string[] {
  return Array.from(REGISTRY.keys());
}

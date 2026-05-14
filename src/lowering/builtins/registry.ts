/**
 * Builtin registry. Each builtin is a fused (transfer + codegenC) pair:
 *
 *   transfer(argTypes, span) — given input types, return the output
 *     type. When all inputs are exact, return a type whose `exact` is
 *     populated (the lowerer then emits a literal IR node instead of
 *     a call). transfer is the single source of truth for type rules
 *     AND compile-time evaluation for this builtin.
 *
 *   codegenC(argsC, argTypes) — return the C expression that evaluates
 *     this builtin at runtime. Not invoked when transfer returned an
 *     exact-tagged type (the lowerer short-circuits to a literal).
 */

import type { Span } from "../../parser/index.js";
import type { Type } from "../types.js";

export interface Builtin {
  /** Source-level name. */
  name: string;
  /** Arity (exact match for MVP). */
  arity: number;
  /** Transfer function: returns output type (with exact when fold-able). */
  transfer(argTypes: Type[], span: Span): Type;
  /** Emit C expression. The caller wraps it as a statement when needed. */
  codegenC(argsC: string[], argTypes: Type[]): string;
  /** Runtime-snippet names this builtin's codegenC output calls into.
   *  Registered names live in `src/codegen/runtime.ts`'s REGISTRY.
   *  The emitter activates each on every codegenC site so deps are
   *  pulled into the final output in topological order. */
  runtimeDeps?: ReadonlyArray<string>;
}

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

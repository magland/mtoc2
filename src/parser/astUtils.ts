/**
 * Small AST helpers consumed by both the lowerer and the interpreter.
 * Pure functions over the numbl AST shape — no dependency on the
 * lowering / runtime layers.
 */

import type { Expr } from "./index.js";

/** Walk a member-chain rooted in an `Ident` and return the dotted
 *  identifier (`pkg.fn`, `pkg.sub.fn`, `ClassName.staticMethod`).
 *  Returns null if the chain bottoms out at something that isn't a
 *  plain identifier (e.g. a function call result, a tensor literal).
 *
 *  Used to disambiguate package calls (`pkg.foo(x)` — dotted lookup)
 *  from instance-method calls (`obj.method(x)` — receiver dispatch):
 *  the qualified name is only meaningful when every segment in the
 *  chain is a plain ident.
 *
 *  This helper says nothing about whether the dotted name *resolves*
 *  to anything — that's the caller's job (consult the env / workspace
 *  / class registry). It only structurally extracts the dotted form. */
export function tryExtractDottedName(e: Expr): string | null {
  if (e.type === "Ident") return e.name;
  if (e.type === "Member") {
    const base = tryExtractDottedName(e.base);
    if (base) return `${base}.${e.name}`;
  }
  return null;
}

/**
 * Backward dataflow over the lowered IR computing per-statement
 * "future-touch" sets for owned-heap-value variables — currently
 * just multi-element tensors (`isOwned` in types.ts). An owned `v`'s
 * future-touch set at statement `s` is the union of vars touched
 * (read OR written) by any successor of `s` in the structured CFG.
 *
 * Drives the "early free" emission in emit.ts: an owned `v` whose
 * last touch is statement `s` (i.e. `v` is in
 * `(uses ∪ defs)(s)` but NOT in `futureTouchOut(s)`) gets a
 * `mtoc2_tensor_free(&v)` immediately after `s`'s C output, rather
 * than waiting for scope exit.
 *
 * Why "touch" (uses ∪ defs) rather than standard liveness (uses with
 * kill on def)? Reassignment goes through `mtoc2_tensor_assign(&v,
 * ...)`, which already releases the prior buffer. If `v`'s next
 * interaction is a reassignment, an early-free at the previous use
 * would be redundant — better to let the assign helper handle it.
 * The future-touch set captures exactly that: a redef counts as a
 * future touch and suppresses the early-free emission.
 *
 * Only owned variables are tracked; scalar `double` locals live in
 * C automatic storage and have no heap to release.
 *
 * Loops resolve by fixpoint over the body's "after-body-last" set.
 * Break / Continue / ReturnFromFunction consult the enclosing
 * context for their target's future touches.
 *
 * Direct port of mtoc's `src/codegen/liveness.ts`, adapted for
 * mtoc2's simpler IR (no Disp/Error/Assert/Fprintf/MultiAssignCall/
 * IndexStore/etc. yet).
 */

import type { IRExpr, IRStmt } from "../lowering/ir.js";
import { isOwned, type Type } from "../lowering/types.js";
import { forEachSubExpr, forEachTopLevelExpr } from "../lowering/walk.js";

/** Per-statement future-touch sets, keyed by the IRStmt object
 *  reference. Each entry holds the set of owned C-names that may be
 *  touched (read or written) at any successor of the statement. */
export type FutureTouchMap = ReadonlyMap<IRStmt, ReadonlySet<string>>;

interface TouchCtx {
  /** Future touches reachable from a `Break` (the post-loop point). */
  readonly breakOut: ReadonlySet<string>;
  /** Future touches reachable from a `Continue` (the loop header). */
  readonly continueOut: ReadonlySet<string>;
  /** Future touches reachable from a `ReturnFromFunction`. The owned
   *  outputs are added via `ownedOutputCNames` below. */
  readonly returnOut: ReadonlySet<string>;
  /** The function's owned output C-names. For a single-output owned
   *  function this is one element (the sret'd buffer); for an N≥2-
   *  output function it's one entry per owned output slot. Used to
   *  keep each output alive through ReturnFromFunction and through
   *  the fall-through end of the function body. Empty for main and
   *  for functions with no owned outputs. */
  readonly ownedOutputCNames: ReadonlySet<string>;
  /** Mutated map of per-statement future-touch sets (the output). */
  readonly futureTouchOut: Map<IRStmt, ReadonlySet<string>>;
}

/** Owned C-names read by an IR expression. Only owned `Var` nodes
 *  contribute; scalars and literals do not. */
export function collectOwnedVarsInExpr(e: IRExpr, out: Set<string>): void {
  forEachSubExpr(e, sub => {
    if (sub.kind === "Var" && isOwned(sub.ty)) out.add(sub.cName);
  });
}

/** Top-level owned uses for a statement — owned vars read at this
 *  statement's level (NOT recursing into control-flow bodies; nested
 *  uses are accounted for in the body's per-stmt future-touch results). */
export function topLevelOwnedUses(s: IRStmt): Set<string> {
  const out = new Set<string>();
  forEachTopLevelExpr(s, e => collectOwnedVarsInExpr(e, out));
  return out;
}

/** Top-level owned defs for a statement — `Assign` to an owned-typed
 *  LHS contributes. `MultiAssignCall` slots with an owned binding also
 *  contribute (each named slot is effectively an Assign of the call's
 *  i-th output). */
export function topLevelOwnedDefs(s: IRStmt): Set<string> {
  const out = new Set<string>();
  if (s.kind === "Assign" && isOwned(s.ty)) {
    out.add(s.cName);
  } else if (s.kind === "MultiAssignCall") {
    for (const slot of s.outputs) {
      if (slot.binding !== null && isOwned(slot.ty)) {
        out.add(slot.binding.cName);
      }
    }
  }
  return out;
}

function setEquals(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function unionInto(target: Set<string>, src: ReadonlySet<string>): void {
  for (const v of src) target.add(v);
}

/** Walks `stmts` backward. Records each stmt's `futureTouchOut` (=
 *  the future-touch set after that stmt's program point) into
 *  `ctx.futureTouchOut`. Returns the future-touch set before stmt 0. */
function touchSeq(
  stmts: ReadonlyArray<IRStmt>,
  futureAfter: ReadonlySet<string>,
  ctx: TouchCtx
): Set<string> {
  let carry: Set<string> = new Set(futureAfter);
  for (let i = stmts.length - 1; i >= 0; i--) {
    const s = stmts[i];
    ctx.futureTouchOut.set(s, new Set(carry));
    carry = touchStmt(s, carry, ctx);
  }
  return carry;
}

function touchStmt(
  s: IRStmt,
  futureAfter: ReadonlySet<string>,
  ctx: TouchCtx
): Set<string> {
  switch (s.kind) {
    case "Assign":
    case "ExprStmt":
    case "MemberStore":
    case "MultiAssignCall":
    case "IndexStore":
    case "IndexSliceStore": {
      const out = new Set(futureAfter);
      unionInto(out, topLevelOwnedUses(s));
      unionInto(out, topLevelOwnedDefs(s));
      return out;
    }
    case "If": {
      // Each arm contributes touches reachable from inside it. The
      // implicit-else fall-through arm contributes `futureAfter`
      // straight through. Top-level cond uses are touched at the
      // if-stmt itself before any arm runs.
      const armIns: ReadonlySet<string>[] = [];
      armIns.push(touchSeq(s.thenBody, futureAfter, ctx));
      armIns.push(
        s.elseBody.length > 0
          ? touchSeq(s.elseBody, futureAfter, ctx)
          : new Set(futureAfter)
      );
      const out = new Set(futureAfter);
      for (const a of armIns) unionInto(out, a);
      unionInto(out, topLevelOwnedUses(s));
      return out;
    }
    case "While":
    case "For": {
      // Fixpoint on the "after-body-last" set. After body[last],
      // control either returns to the loop header (continue) or
      // exits to `futureAfter` (break / cond becomes false). Either
      // way, body[last]'s future-touch set must include the touches
      // in the next iteration plus `futureAfter`.
      let bodyAfter = new Set<string>(futureAfter);
      // Lattice is finite; fixpoint always converges. Cap iterations
      // defensively.
      for (let iter = 0; iter < 64; iter++) {
        const innerCtx: TouchCtx = {
          ...ctx,
          breakOut: futureAfter,
          continueOut: bodyAfter,
        };
        const bodyIn = touchSeq(s.body, bodyAfter, innerCtx);
        const newBodyAfter = new Set<string>(futureAfter);
        unionInto(newBodyAfter, bodyIn);
        unionInto(newBodyAfter, topLevelOwnedUses(s));
        if (setEquals(newBodyAfter, bodyAfter)) break;
        bodyAfter = newBodyAfter;
      }
      const out = new Set(bodyAfter);
      unionInto(out, topLevelOwnedUses(s));
      return out;
    }
    case "Break":
      return new Set(ctx.breakOut);
    case "Continue":
      return new Set(ctx.continueOut);
    case "ReturnFromFunction": {
      // The early-return path itself has no successors, but the
      // function's owned output C-names (if any) are "used" at this
      // return — the codegen emits the sret writes (or `return cOut;`
      // for a single owned output) after the `mtoc2_return:` label.
      // Mark them as touched so the dataflow doesn't decide an output
      // local is dead one stmt earlier and emit a stray early-free.
      const out = new Set(ctx.returnOut);
      for (const c of ctx.ownedOutputCNames) out.add(c);
      return out;
    }
    case "TypeComment":
      // Pure annotation — no uses, no defs, no effect on the
      // future-touch set.
      return new Set(futureAfter);
  }
}

/** Compute per-statement future-touch sets for a body of statements.
 *  For function bodies whose output slots include owned values, pass
 *  one `{ cName, ty }` per owned output. The analyzer seeds the body-
 *  end future-touch with each owned-output C-name — otherwise the
 *  implicit return / sret writes would see the final defs as "last
 *  touches" and emit stray early-frees of the values we're about to
 *  transfer to the caller. Pass an empty array for main, scalar-
 *  returning functions, or functions with no owned outputs. */
export function computeFutureTouches(
  stmts: ReadonlyArray<IRStmt>,
  ownedOutputs: ReadonlyArray<{ cName: string; ty: Type }> = []
): FutureTouchMap {
  const futureTouchOut = new Map<IRStmt, ReadonlySet<string>>();
  const empty: ReadonlySet<string> = new Set();
  const bodyEnd = new Set<string>();
  const ownedOutputCNames = new Set<string>();
  for (const o of ownedOutputs) {
    if (isOwned(o.ty)) {
      bodyEnd.add(o.cName);
      ownedOutputCNames.add(o.cName);
    }
  }
  const ctx: TouchCtx = {
    breakOut: empty,
    continueOut: empty,
    returnOut: empty,
    ownedOutputCNames,
    futureTouchOut,
  };
  touchSeq(stmts, bodyEnd, ctx);
  return futureTouchOut;
}

/** After emitting `s`, return the set of owned C-names that should
 *  be freed immediately (no future touch). Helper for emit.ts.
 *
 *  Note: the scope-exit free walk still emits frees for every owned
 *  local unconditionally. Early-frees null out the buffers, so the
 *  scope-exit free of an already-freed variable is a no-op
 *  (`free(NULL)` is well-defined). The redundancy is a small
 *  cosmetic cost in the generated C; a proper "guaranteed-freed on
 *  every path" analysis (so we can skip the scope-exit free) is a
 *  future optimization. */
export function earlyFreeCandidates(
  s: IRStmt,
  futureTouches: FutureTouchMap
): Set<string> {
  const after = futureTouches.get(s) ?? new Set<string>();
  const candidates = new Set<string>();
  for (const v of topLevelOwnedUses(s)) {
    if (!after.has(v)) candidates.add(v);
  }
  for (const v of topLevelOwnedDefs(s)) {
    if (!after.has(v)) candidates.add(v);
  }
  return candidates;
}

/** Forward dataflow: which owned C-names are guaranteed to be in the
 *  empty/NULL state at the end of `stmts`. Used to skip redundant
 *  scope-exit frees when every reaching path through the body has
 *  already early-freed (or never assigned) the variable.
 *
 *  Rules per stmt:
 *  - `Assign(v, ...)` where `isOwned(v.ty)`: `v` is now non-NULL.
 *    Remove from set.
 *  - Any stmt that triggers an early-free of `v`: `v` is now NULL.
 *    Add to set.
 *  - `If`: recurse into both arms; intersect end-sets.
 *  - `While` / `For`: recurse into body assuming it MAY run; intersect
 *    body-end with entry (since the loop may run 0 times).
 *  - `Break` / `Continue` / `ReturnFromFunction`: end-of-block-on-this-
 *    path; we approximate as "no effect on current" — sound because
 *    the only consumer of the result is the body's fall-through end. */
export function nullAtScopeExit(
  stmts: ReadonlyArray<IRStmt>,
  entryNullAt: ReadonlySet<string>,
  futureTouches: FutureTouchMap
): Set<string> {
  let current = new Set(entryNullAt);
  for (const s of stmts) {
    switch (s.kind) {
      case "Assign": {
        if (isOwned(s.ty)) current.delete(s.cName);
        for (const v of earlyFreeCandidates(s, futureTouches)) {
          current.add(v);
        }
        break;
      }
      case "ExprStmt": {
        for (const v of earlyFreeCandidates(s, futureTouches)) {
          current.add(v);
        }
        break;
      }
      case "MemberStore":
      case "IndexStore":
      case "IndexSliceStore": {
        // The base buffer is mutated in place (still allocated post-
        // store); only react to early-free candidates here.
        for (const v of earlyFreeCandidates(s, futureTouches)) {
          current.add(v);
        }
        break;
      }
      case "MultiAssignCall": {
        // Each named owned slot is now non-NULL after the call (the
        // callee wrote into it via the sret pointer). Ignored owned
        // slots stay NULL because the discard temp is local to the
        // call's `{}` block.
        for (const slot of s.outputs) {
          if (slot.binding !== null && isOwned(slot.ty)) {
            current.delete(slot.binding.cName);
          }
        }
        for (const v of earlyFreeCandidates(s, futureTouches)) {
          current.add(v);
        }
        break;
      }
      case "If": {
        const thenEnd = nullAtScopeExit(s.thenBody, current, futureTouches);
        const elseEnd = nullAtScopeExit(s.elseBody, current, futureTouches);
        current = intersect(thenEnd, elseEnd);
        for (const v of earlyFreeCandidates(s, futureTouches)) {
          current.add(v);
        }
        break;
      }
      case "While":
      case "For": {
        // Loop may run 0+ times. The "0 iter" path leaves nullAt as
        // the entry state. The "1+ iter" path applies the body's
        // effects to its own entry (= the current set at loop-header
        // time). Intersect both to be safe.
        const bodyEnd = nullAtScopeExit(s.body, current, futureTouches);
        current = intersect(current, bodyEnd);
        for (const v of earlyFreeCandidates(s, futureTouches)) {
          current.add(v);
        }
        break;
      }
      case "Break":
      case "Continue":
      case "ReturnFromFunction":
        // Control jumps elsewhere; doesn't influence the fall-through
        // end-of-block. Leave `current` as-is.
        break;
      case "TypeComment":
        // Pure annotation; no effect on null-at-exit dataflow.
        break;
    }
  }
  return current;
}

function intersect(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>
): Set<string> {
  const out = new Set<string>();
  for (const v of a) if (b.has(v)) out.add(v);
  return out;
}

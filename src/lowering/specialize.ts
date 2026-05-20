/**
 * User-function specialization machinery.
 *
 * `specializeUserFunction` is the single chokepoint that turns a
 * parsed `function` AST into an `IRFunc` against a specific arg-type
 * tuple, with the spec cache keyed on `(file, argTypes, nargout)`.
 * Every expression-context user-function call (bare-name, packaged
 * `pkg.foo`, instance / static class methods, method-via-arg-type,
 * handle dispatch) routes through `buildUserFunctionCall`, which
 * calls `specializeUserFunction` for the spec lookup and synthesizes
 * the matching `Call` IR node.
 *
 * Lives in its own module so the new user-defined `.js` function
 * feature has a clear integration surface: a sidecar can either
 * register a builtin (which doesn't need this path at all) or
 * synthesize a `decl: FuncStmt` and reuse the existing spec discipline.
 */

import type { Stmt } from "../parser/index.js";
import type { Span } from "../parser/index.js";
import { TypeError } from "./errors.js";
import type { IRExpr, IRFunc, IRStmt } from "./ir.js";
import {
  type Type,
  canonicalizeType,
  hashType,
  sanitizeCIdent,
  UNKNOWN,
  VOID,
} from "./types.js";
import type { Lowerer } from "./lower.js";
import { cIdentForUserName } from "./lower.js";

type FuncStmt = Extract<Stmt, { type: "Function" }>;

/** Build a single-output `Call` IR node against a user-function AST,
 *  specializing the body on the arg-type tuple. Single chokepoint for
 *  every expression-context user-function call: bare-name calls,
 *  packaged (`pkg.foo`) calls, instance / static class methods,
 *  method-call-via-arg-type, and handle dispatch. Each caller is
 *  still responsible for the verdict-specific bookkeeping (resolver
 *  routing, prepending the receiver to args for instance methods,
 *  rejecting >=2-output methods if its dispatch path doesn't yet
 *  support truncation, …) — but the spec lookup + output-type
 *  derivation + IR construction is uniform here.
 *
 *  For 0-output declarations the resulting `Call` has `ty = VOID`,
 *  which the caller (`lowerExprStmt`) must accept as bare-statement
 *  use only. For >=1-output declarations the spec truncates to
 *  nargout=1 and the result type is the (possibly Unknown if the
 *  body didn't assign the output) first declared output.
 *
 *  The N≥2-output path uses a separate `MultiAssignCall` IR node
 *  built by `lowerMultiAssign` — this helper is single-output only. */
export function buildUserFunctionCall(
  this: Lowerer,
  decl: FuncStmt,
  callArgs: IRExpr[],
  callName: string,
  span: Span,
  opts: {
    specSource?: string;
    definingFile?: string;
  } = {}
): IRExpr {
  const argTypes = callArgs.map(a => a.ty);
  const nargout = decl.outputs.length === 0 ? 0 : 1;
  const spec = specializeUserFunction.call(
    this,
    decl,
    argTypes,
    opts.specSource,
    opts.definingFile,
    undefined,
    nargout,
    span
  );
  const ty: Type =
    decl.outputs.length === 0
      ? VOID
      : (spec.outputTypes[0] ?? { kind: "Unknown" });
  return {
    kind: "Call",
    cName: spec.cName,
    name: callName,
    args: callArgs,
    ty,
    span,
  };
}

/** Specialize a user function (or method, or anonymous-function
 *  synth) on the given arg-type tuple. The C mangling salts by the
 *  defining file so two files defining a same-named subfunction get
 *  distinct mangled names.
 *
 *  Caller is responsible for passing `definingFile` — for top-level
 *  functions resolved through the workspace, that's the resolver's
 *  verdict file; for class methods it's the class's file; for
 *  anonymous-function synth ASTs it's the file where `@(...)` was
 *  written. */
export function specializeUserFunction(
  this: Lowerer,
  decl: FuncStmt,
  argTypes: Type[],
  /** Optional override for the specialization-key source-name half.
   *  Class methods pass `<className>__<methodName>` so the mangled C
   *  name disambiguates two methods of the same source-level name
   *  on different classes. Defaults to `decl.name`. */
  specSource?: string,
  /** File the function definition lives in. Salts the spec key so
   *  cross-file homonyms get distinct C names. Defaults to the
   *  function's source span's file. */
  definingFile?: string,
  /** When set, the named output gets a synthetic first assignment to
   *  `initExpr` (an already-lowered IR expression) prepended to the
   *  body. The user's constructor body then sees the receiver
   *  initialized with the class defaults. */
  preSeedOutput?: { name: string; ty: Type; initExpr: IRExpr },
  /** Per-call-site `nargout`: the number of outputs the caller
   *  requested. Salts the spec key so two callers requesting
   *  different output counts get distinct specializations. Defaults
   *  to `decl.outputs.length` (the declared count) when the caller
   *  can't supply a more specific value (e.g. cross-file resolver
   *  paths that don't yet thread this through). Inside the body, the
   *  `nargout` identifier folds to this value via the
   *  `callFrameStack`. */
  nargout?: number,
  /** Span of the call site, used to attribute arity / output-
   *  assignment errors. Defaults to `decl.span` (the function
   *  definition) when omitted — but every translation-time call site
   *  should supply its own span so the user sees the bad call, not
   *  the definition. */
  callSiteSpan?: Span
): IRFunc {
  const errSpan = callSiteSpan ?? decl.span;
  if (argTypes.length !== decl.params.length) {
    throw new TypeError(
      `function '${decl.name}' expects ${decl.params.length} arg(s), got ${argTypes.length}`,
      errSpan
    );
  }
  const source = specSource ?? decl.name;
  const file = definingFile ?? decl.span.file ?? this.currentFile;
  // Per-specialization `nargout`: defaults to the declared count so
  // resolver paths that don't yet thread the caller's request still
  // produce a working specialization (matches numbl's "max possible
  // nargout" interpretation when the call site isn't statically
  // known). Callers that DO know — `lowerMultiAssign`,
  // `lowerFuncCall`, ExprStmt drop-all — supply the precise count so
  // the spec key shards correctly.
  const effectiveNargout = nargout ?? decl.outputs.length;
  // Hash the (file, argTypes, nargout) triple together so the C name
  // salts by all three. Keep the human-readable prefix
  // (`apply__<hex>`) — the hash collapses everything that doesn't
  // matter.
  const hashInput = `${file}|${argTypes.map(canonicalizeType).join("|")}|nargout=${effectiveNargout}`;
  const key = `${sanitizeCIdent(source)}__${hashType(hashInput)}`;
  const cached = this.specializations.get(key);
  if (cached) {
    // A still-empty placeholder means we're hitting the spec while
    // its outer specializeUserFunction is still lowering the body —
    // i.e. a recursive self-call (or mutual-recursive entry to the
    // same key from a sibling specializer that's still pending).
    // Track so the outer call can re-lower the body once the final
    // outputTypes are known, swapping out the heuristic seed.
    if (cached.body.length === 0) {
      this.recursiveSpecsConsumed.add(key);
    }
    return cached;
  }

  // Per-spec output list: truncate to the caller's requested nargout.
  // A 3-output function called as `[a] = f(...)` or `x = f(...)`
  // becomes a 1-output specialization (single-output C ABI); a bare
  // `f(...)` becomes a 0-output (void) spec. The body's assignments
  // to trailing outputs are kept but unused — the nargout fold may
  // dead-code them via `if nargout >= N` branches.
  const effectiveOutputs = decl.outputs.slice(0, effectiveNargout);
  // Pre-seed each output's type with the i-th param's type (or
  // Unknown when fewer params than outputs). This is the placeholder's
  // `outputTypes` value that recursive self-calls will read while the
  // body is mid-lowering. For the common recursion shape — output
  // kind matches input kind, as in `factorial` / `fib` — the seed is
  // already correct and the body type-checks first try. For other
  // shapes the post-lowering compare below catches the mismatch and
  // re-lowers once with the actual types.
  const seedOutputs: Type[] = effectiveOutputs.map(
    (_, i) => argTypes[i] ?? UNKNOWN
  );
  const placeholder: IRFunc = {
    name: decl.name,
    cName: key,
    params: decl.params.slice(),
    cParams: decl.params.map(cIdentForUserName),
    paramTypes: argTypes,
    outputs: effectiveOutputs.slice(),
    cOutputs: effectiveOutputs.map(cIdentForUserName),
    outputTypes: seedOutputs,
    body: [],
    span: decl.span,
  };
  this.specializations.set(key, placeholder);

  // Save outer state. The try/finally guarantees state is restored
  // even if body lowering throws — otherwise a TypeError /
  // UnsupportedConstruct from the body would leak this function's env
  // / tempCounter / currentFile / callFrameStack to the caller.
  const savedEnv = this.env;
  const savedTempCounter = this.tempCounter;
  const savedCurrentFile = this.currentFile;
  this.currentFile = file;
  this.callFrameStack.push({
    nargin: argTypes.length,
    nargout: effectiveNargout,
  });

  // Lower the body once with the current placeholder.outputTypes.
  // Returns the freshly-built body + the actual output types read
  // from env. Resets env/tempCounter so a re-lower starts from the
  // same clean state as the first pass.
  const lowerBodyOnce = (): { body: IRStmt[]; outputTypes: Type[] } => {
    this.env = new Map();
    this.tempCounter = 0;
    // Bind params. The C name goes through `cIdentForUserName` so a
    // user-source `function r = f(struct)` doesn't reference the C
    // keyword `struct` for reads of `struct` inside the body.
    for (let i = 0; i < decl.params.length; i++) {
      const pName = decl.params[i];
      this.env.set(pName, {
        cName: cIdentForUserName(pName),
        ty: argTypes[i],
      });
    }
    // Class constructors pre-seed their output (the receiver) with
    // the default-valued class instance via an injected first stmt,
    // so the body can read `obj.x` / write `obj.x = ...` against an
    // initialized slot from the very first source statement.
    let initStmts: IRStmt[] = [];
    if (preSeedOutput !== undefined) {
      this.requireValueType(
        preSeedOutput.initExpr,
        `constructor init for '${preSeedOutput.name}'`
      );
      const initStmt = this.recordAssignment(
        preSeedOutput.name,
        preSeedOutput.initExpr,
        decl.span
      );
      initStmts = [initStmt];
    }

    const body = [...initStmts, ...this.lowerStmts(decl.body)];

    // Output types come from the final env value of each effective
    // output name. Trailing outputs the caller dropped via nargout
    // truncation aren't checked — they may legitimately be left
    // unassigned by a `if nargout >= N` body branch.
    const outputTypes: Type[] = effectiveOutputs.map(o => {
      const e = this.env.get(o);
      if (!e) {
        throw new TypeError(
          `function '${decl.name}': output '${o}' was never assigned`,
          errSpan
        );
      }
      return e.ty;
    });
    return { body, outputTypes };
  };

  try {
    let { body, outputTypes } = lowerBodyOnce();

    // If a recursive self-call consumed the placeholder's seeded
    // outputTypes during the first pass AND the actual outputs the
    // body produced differ from the seed, the recursive Call IR
    // nodes built in pass 1 carry the (now-stale) seed type. Update
    // the placeholder with the actual outputs and re-lower the body
    // so the recursive Call IR picks up the refined type. Capped at
    // one retry — a function whose output type still hasn't
    // stabilized after two passes is either mutually recursive in a
    // pathological way or has a genuinely unknowable output type;
    // either way, the second pass's result is what we ship.
    if (
      this.recursiveSpecsConsumed.has(key) &&
      !sameOutputTypes(seedOutputs, outputTypes)
    ) {
      placeholder.outputTypes = outputTypes;
      const second = lowerBodyOnce();
      body = second.body;
      outputTypes = second.outputTypes;
    }

    const out: IRFunc = {
      ...placeholder,
      body,
      outputTypes,
    };
    this.specializations.set(key, out);
    return out;
  } catch (err) {
    // Body lowering threw — drop the placeholder so a future call
    // with the same key (e.g. after the user fixes the error and
    // re-translates against the same Lowerer instance) re-attempts
    // specialization instead of returning the empty placeholder.
    this.specializations.delete(key);
    throw err;
  } finally {
    this.env = savedEnv;
    this.tempCounter = savedTempCounter;
    this.currentFile = savedCurrentFile;
    this.callFrameStack.pop();
    // Clear the recursion-consumed marker for this key so a later
    // unrelated spec on the same Lowerer doesn't spuriously re-lower.
    this.recursiveSpecsConsumed.delete(key);
  }
}

/** True iff two output-type lists are canonically equal. Used to
 *  decide whether a recursive specialization's body needs re-lowering
 *  after the heuristic seed produced different output types than the
 *  actual body finalizes to. */
function sameOutputTypes(
  a: ReadonlyArray<Type>,
  b: ReadonlyArray<Type>
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (canonicalizeType(a[i]) !== canonicalizeType(b[i])) return false;
  }
  return true;
}

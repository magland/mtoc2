# CLAUDE.md

Project instructions for agents working in mtoc2.

## What this project is

mtoc2 is a static numbl-to-C translator. It accepts a strict subset of what
numbl can run and emits a single C file you can compile with `cc`. The type
system threads **exact-value tracking** through every scalar — builtin
transfer functions compute exact results when all inputs are exact, and the
canonical type form includes the exact value, so each distinct exact-input
gets its own function specialization. Codegen emits runtime C for
arithmetic / comparisons / builtin calls / Ident reads regardless of
whether their `exact` is known; the **only** place the lowerer turns an
exact value into a compile-time decision is the `if` / `elseif` condition,
where a known-`exact` cond takes or drops the branch before the IR reaches
codegen.

This is a from-scratch rewrite of mtoc. Build up only what we're certain
about. Don't port mtoc features speculatively.

## Project anchor: numbl

**numbl** is a runtime interpreter for the same MATLAB-style language. It
defines the dialect mtoc2 accepts. Two roles:

- **Implementation**: mtoc2 imports numbl's parser directly via sibling-
  relative path (`../numbl/src/numbl-core/parser/...` — see
  `src/parser/index.ts`). No vendoring. Drift is caught at `tsc` time. The
  numbl SHA we last validated against lives in `NUMBL_VERSION`.
- **Testing**: numbl's CLI is the cross-runner oracle. Every `.m` script in
  `test_scripts/` runs through both numbl and mtoc2; stdouts must match
  byte-for-byte.

During development numbl lives at `../numbl` (sibling directory) and is
available to read. When a question comes up about how the dialect should
behave, the answer is "what numbl does" — read the relevant file under
`../numbl/src/numbl-core/`.

The long-term plan is that numbl's own JIT path goes away and numbl uses
mtoc2 for compiled execution. Keep mtoc2's type system clean enough to
eventually serve that role.

## Scope

mtoc2 is a _static_ translator. Anything outside the supported subset raises
`UnsupportedConstruct` with a source span. Today's scope:

- **Scalar real `double`** — arithmetic, comparisons, `if`/`while`/`for`,
  user functions with type-tuple specialization. Functions may declare
  0, 1, or N≥2 outputs. A 0-output call returns the `Void` type and
  can only appear as the expression of an `ExprStmt` (e.g. `foo();`
  at top level or inside another function body). A 1-output call uses
  the return-by-value C ABI; an N≥2-output call uses `void` + one
  `T *_mtoc2_o<i>` out-pointer per output and is invoked only via
  `[a, b, ...] = foo(x)` or as a bare statement `foo(x);` (drop-all).
  v1 restricts N≥2-output slots to scalar real numeric. Multi-output
  class methods and handle dispatch are not yet supported.
- **Real tensors** — mtoc-style "always-copy" model: `mtoc2_tensor_t`
  struct with `mtoc2_tensor_assign` / `mtoc2_tensor_copy` /
  `mtoc2_tensor_free`; no refcount, no COW. Every tensor source-literal
  lowers to a `TensorBuild` IR node (column-major flat array of element
  expressions), materialized at the use-site via `mtoc2_tensor_from_row`
  / `mtoc2_tensor_from_matrix`. (Special case: a 1×1 tensor literal
  `[x]` lowers to the inner scalar — same as MATLAB.) Rank-N tensors
  (up to `MTOC2_MAX_NDIM = 8`) are constructed via `zeros` / `ones`
  with statically-known dims; bracket syntax stays 2-D-only.
- **Tensor arithmetic** — elementwise `+` `-` `.*` `./` `-` (unary)
  on same-shape tensors and tensor-with-scalar-broadcast. Each op
  emits a per-op runtime helper call
  (`mtoc2_tensor_<op>_tt` / `_ts` / `_st`). Matrix `*` `/` (i.e.
  `mtimes` / `mrdivide` between two tensors) is not yet supported.
- **Reduction**: `sum` on vectors via `mtoc2_sum`; matrix→row-vector
  reduction deferred. `length` / `numel` emit `mtoc2_length` /
  `mtoc2_numel` runtime calls (for scalar args, codegen emits the
  literal `1.0` directly since the C arg is a bare `double`).
- **disp** routes on shape: scalar → `mtoc2_disp_double`,
  multi-element tensor → `mtoc2_disp_tensor`.
- **Indexing & slicing** — scalar reads/writes (`v(i)`, `M(i,j)`,
  `T(i,j,k)`, `v(end)`, `M(end,end-1)`), range/colon slice reads/writes
  (`v(:)`, `v(a:b)`, `M(:, j)`, `T(:, :, i) = page`), and range-as-
  value (`v = 1:n`, `(1:5)*2`, etc.). Scalar offsets are computed via
  the shared column-major formula `emitNdScalarOffset`; slice reads
  allocate a freshly-owned result via `mtoc2_tensor_alloc_nd` and
  loop; slice writes mutate the base buffer in place with a runtime
  count check on tensor RHS. Range-as-value lowers to a `MakeRange`
  IR node and emits via `mtoc2_tensor_make_range`. Logical/vector-of-
  indices indexing (`a(mask)`, `a(idx_vec)`) is not yet supported.
- **Wall-clock stopwatch**: `tic` / `toc` (0-arg each) emit
  `mtoc2_tic()` / `mtoc2_toc()` via the `mtoc2_tic_toc` runtime
  snippet (POSIX `clock_gettime(CLOCK_MONOTONIC)`). The bare-`toc;`
  ExprStmt is special-cased in `lowerExprStmt` to emit
  `mtoc2_toc_print()`, which prints
  `Elapsed time is %.6f seconds.\n` and matches numbl's
  `nargout === 0` branch. Value-returning forms (`t = toc`,
  `toc + 0`, etc.) take the standard builtin path. The cross-runner
  honors a per-script `% mtoc2-test-mask: <regex>` comment block
  so the elapsed-seconds line can be normalized before byte-for-
  byte comparison (see [docs/testing.md](docs/testing.md)). The
  tic-handle form `toc(t0)` is rejected with a span — use the
  no-arg form. `lowerIdent` recognizes bare-name reads of 0-arity
  builtins, so `tic`/`toc` work both as identifiers (`t = toc`)
  and as zero-paren calls (`tic;`).
- **Function handles** — `@user_func` (named) and `@(...) <body>`
  (anonymous). Dispatch is static: every `h(args)` call site reads
  the handle variable's `HandleType`, builds capture-args via
  `HandleCaptureLoad`, and routes through `specializeUserFunction`.
  Captures may be scalar real numeric, tensor, struct, class
  instance, or another handle; handles are owned and ship per-shape
  `_empty/_copy/_assign/_free` helpers, so owned-typed captures
  participate in the standard scope-exit-free / early-free lifecycle.
  Captures are deep-copied into the handle struct at the `@(...)`
  site (MATLAB by-value snapshot semantics). `@builtin`, String /
  Void / Unknown captures, and `~` params are rejected with a span.
- **Workspace files** — every `.m` file in the project (active file
  plus siblings on the search path) is registered with a `Workspace`
  at translate time. Cross-file calls (a sibling's filename used as
  a function name, a workspace `classdef`, etc.) are resolved through
  numbl's `resolveFunction` directly — see
  [src/workspace/workspace.ts](src/workspace/workspace.ts). The CLI
  walks the entry's directory recursively, descending only into
  `+pkg/` namespace dirs and `@Class/` class dirs; the web IDE passes
  flat file names. MATLAB precedence rules (local-to-main beats
  workspace beats builtin) are inherited from numbl rather than
  reimplemented.
- **Package functions** — `+pkg/foo.m` registers as the qualified
  workspace function `pkg.foo`; nested `+pkg/+sub/foo.m` →
  `pkg.sub.foo`. Call sites `pkg.foo(args)` and `pkg.sub.foo(args)`
  parse as `MethodCall` AST nodes; `lowerMethodCall` extracts the
  dotted chain (via `tryExtractDottedName`), confirms the leftmost
  segment isn't an in-scope variable (MATLAB env-shadow rule), and
  routes the qualified name through `workspace.resolve` — exactly
  the same path as a bare-name workspace function call. The
  specialization spec source uses the qualified name, so two packages
  with same-basename functions mangle to distinct readable C names
  (`pkg_foo__<hex>` vs `other_foo__<hex>`). `@pkg.foo` works as a
  function handle. `import pkg.foo` / `import pkg.*` statements are
  not yet supported — calls must be fully qualified.

Not yet supported: matrix multiplication / division, logical / vector-
of-indices indexing (`a(mask)`, `a(idx_vec)`), member-rooted indexing
(`obj.r(1, :, :)`, `obj.f(i) = rhs`), indexed-delete (`a(2:5) = []`),
unknown-shape constructors (`zeros(n)` where `n` is a runtime-only
scalar), general broadcast (non-scalar mismatched shapes), complex,
strings, chars, builtin handles, `private/` directories, `@Class/`
folders, `import` statements, `.numbl.js` user functions. Expanding
scope is gated by the cross-runner.

## Docs are part of the change

Every change should keep `README.md` and `docs/` accurate. If you:

- Add a builtin → mention it (and its runtime deps) in `docs/architecture.md`
  if the registration pattern is new.
- Add or tighten an `UnsupportedConstruct` / `TypeError` site → if it's
  user-visible, capture it where users will look.
- Change the IR / pipeline / runtime helper system → reflect it in
  `docs/architecture.md`.
- Change the type lattice → update `docs/type_system.md`.
- Change the test layout → update `docs/testing.md`.

Avoid hard-coding line numbers. Refer to subsystems and file _roles_ so
docs survive routine refactors.

## Test discipline

A change is "done" when all of these are clean:

- `npx tsc`
- `npx tsx scripts/run_test_scripts.ts` (cross-runner, full pass)
- `npx vitest run` (if vitest cases exist for the area)
- `npm run lint`
- `npm run format:check`

Two layers, strict separation:

- **Cross-runner** (`scripts/run_test_scripts.ts`) compares mtoc2 and numbl
  byte-for-byte over every `.m` in `test_scripts/`. New end-to-end tests
  go here as `.m` files (auto-discovered). Don't add per-script entries
  to vitest.
- **Vitest** is reserved for unit-level assertions (emitted-C shapes,
  error attribution, type-system invariants). Not used yet — add a
  `tests/` directory when there's something worth covering at that level.

If a divergence between mtoc2 and numbl is a real numbl bug, file it
upstream; don't paper over it in mtoc2.

## Owned-value codegen invariant

Tensors (and future owned types: strings, structs, classes) follow mtoc's
"always-copy, free-at-scope-exit" model:

- Every owned-typed C expression produces a **freshly-owned** value
  (`mtoc2_tensor_from_row(...)`, `mtoc2_tensor_copy(v)`, op result, or a
  function return).
- Every owned local is **pre-declared at function top** via
  `mtoc2_tensor_empty()` (NULL-pointer state). Every Assign — first or
  subsequent — uses `mtoc2_tensor_assign(&v, rhs)`. First-call free of
  NULL is a no-op; uniform path.
- A tensor `Var` read inside an **Assign RHS** wraps in
  `mtoc2_tensor_copy(v)` so the receiver gets a freshly-owned value the
  assign helper can consume. A tensor `Var` read in a non-owning context
  (e.g. `disp` arg) passes the struct bare — no buffer copy.
- Scope exit / before every `ReturnFromFunction` emits
  `mtoc2_tensor_free(&v)` for each owned local — but **only when the
  forward `nullAtScopeExit` dataflow can't prove the buffer is already
  NULL** along every reaching path. Combined with the early-free
  emission (see below), most variables get a single free at their
  last use; scope-exit frees only fire when the analysis can't rule
  out a live buffer (e.g., a tensor reassigned in a loop body whose
  final iteration leaves an allocated buffer).
- **Early-free**: a backward "future-touch" dataflow
  (`src/codegen/liveness.ts`) computes per-stmt sets of owned C-names
  that may be touched (read or written) at any successor. After each
  stmt, owned names in `(uses ∪ defs)(s) − futureTouchOut(s)` get an
  immediate `mtoc2_tensor_free(&v)`. Reassignment counts as a future
  touch (the assign helper handles its own free), so an early-free
  isn't emitted if the next interaction is a redef.
- An owned-producing sub-expression (TensorBuild, tensor-typed
  Binary/Unary/Call) inside any larger expression is **A-normalized**
  at lowering time: hoisted to a fresh `_mtoc2_t<N>` temp Assign and
  replaced with a Var of the temp. After ANF the IR invariant is:
  owned-producing expressions appear only as direct Assign RHSs at
  owned consume sites; everywhere else they're Var reads. Mirrors
  mtoc's anf.ts pattern; the difference is that mtoc's elementwise
  ops fuse into a parent iter loop and aren't classified as owned
  producers, whereas mtoc2 always emits a per-op runtime helper that
  allocates fresh, so elementwise IS owned-producing here. (Inline
  iter-loop fusion is a future optimization.)

## Folding only at if-cond

Exact tracking still threads through the type system: builtin transfer
functions compute exact results when all inputs are exact, and the
specialization key includes `exact` so each distinct value triggers a
fresh specialization. But the lowerer **does not** substitute literals
for known-exact computations anywhere except the `if` / `elseif`
condition:

- `a = 2 + 3` lowers to a `Binary` IR node (with `ty.exact = 5`) and
  emits `double a = (2.0 + 3.0);` — the C compiler folds, not the
  lowerer.
- An Ident read of a scalar variable with `exact` always emits a `Var`,
  never a `NumLit`. The C variable holds the value at runtime.
- A tensor source-literal always lowers to `TensorBuild` and
  materializes at runtime. There is no `TensorLit` IR node.
- `length` / `numel` emit runtime helper calls; `sum` emits
  `mtoc2_sum`. None fold into a literal at codegen time.
- `disp(a)` always emits the runtime `mtoc2_disp_double` or
  `mtoc2_disp_tensor` helper — no compile-time formatting path.

The only fold site is `condToBool` in `lower.ts`, called from `lowerIf`:
when `cond.ty.exact` is a finite `number`, the corresponding branch is
returned directly and the surrounding `if` is not emitted. This lets
type-directed dead-branch elimination work (e.g. a user function
specialized for `x :: double=5` can have its `if x > 0` arm decided at
spec time) without baking constants into the user's emitted code.

## Always-materialize tensor Assign

Every tensor Assign emits C — there is no IR node for "compile-time-
only tensor data". TensorBuild RHSs materialize via
`mtoc2_tensor_from_row` / `mtoc2_tensor_from_matrix`; `Var` RHSs wrap
in `mtoc2_tensor_copy`; computed tensor RHSs (`Binary` / `Unary` /
`Call`) emit their per-op runtime helper. The C variable always holds
a freshly-owned tensor after the Assign.

## Testing- and debug-only directives

mtoc2 reuses numbl's `%!numbl:<name> <args>` directive AST as a
channel for translator-side hints. Numbl silently ignores any
unknown directive name, so cross-runner output is unaffected by all
three below.

- `%!numbl:opaque <var> [<var>...]` strips `exact` from each named
  variable in the current env. With the no-fold-at-codegen rule
  this is mostly a no-op for variables holding tensors (the runtime
  path is the default), but it still matters for `if`-cond folding
  on scalar vars: `x = 5; %!numbl:opaque x; if x > 0` forces the if
  to emit as a runtime branch instead of being statically taken.

- `%!numbl:showtype <var> [<var>...]` snapshots each variable's
  current type and emits one `/_ type <name> (<cName>) :: <type> _/`
  line in the generated C at the directive's source position. Debug
  aid only; no runtime effect. Lowers to a `TypeComment` IR node;
  walk / liveness / dataflow treat it as a no-op.

- `%!numbl:printtype <var> [<var>...]` is the stderr counterpart of
  `showtype`: same snapshot, written via the swappable
  `printTypeSink` hook (defaulting to `console.error`) as
  `<file>:<line>:<col>: type <name> :: <type>`. No IR node and no
  effect on emitted C — fires at lowering time, once per function
  specialization that the directive's body is lowered for.

Both `showtype` and `printtype` raise `UnsupportedConstruct` with
the directive's span if a named variable is not in scope. Both
reflect post-`opaque` stripping and loop-body widening because they
read the env at the lowering point.

## Architectural rules

- **Exact-tracking through the type lattice, fold only at if-cond**.
  Every scalar in the type system has an optional `exact` field; all
  builtin `transfer` fns propagate it when every input is exact. The
  exact value affects function specialization (it's part of the key)
  and the if-cond fold. It does NOT cause the lowerer to substitute
  literals for arithmetic / Ident reads / builtin calls — those always
  emit runtime IR. See the "Folding only at if-cond" section above.
- **No JitType reuse**. The type system in `src/lowering/types.ts` is
  written from scratch — not derived from numbl's `JitType`. numbl's JIT
  is on a path to retirement; mtoc2's lattice is meant to outlive it.
- **Every IR node carries a `Span`**. User-facing errors include it.
  Codegen-time errors should be rare and labeled "internal: should have
  been caught at lowering" — if one fires on a real program, hoist the
  check into lowering with a span.
- **One-pass lowering**. Loop bodies are lowered once. Any variable
  assigned inside a loop body has its `exact` stripped from env before
  the body is lowered (`stripExactFromEnv` + `collectAssignedNames`),
  otherwise the single pass would bake iteration-1 values into the
  emitted code.
- **Emit doc-comments alongside C**. `src/codegen/prettyIR.ts` renders
  each `IRFunc` to a multi-line block comment (name, mangled
  identifier, per-param and per-output types) and each `IRStmt` to a
  one-line numbl-like summary. The emitter places the function comment
  above every specialized definition and the stmt comment above every
  emitted statement. Synthetic ANF temps (`_mtoc2_t<N>`) and folded
  branches show through — these comments reflect the IR after
  lowering, not the original source.

## Naming

- Synthetic C identifiers and runtime helpers use the `mtoc2_` prefix
  (reserved). numbl forbids leading underscores in identifiers, so this
  namespace stays clean from user code.
- Specialization mangling: `<funcName>__<8-hex>` where the hex is the
  FNV-1a 32-bit hash of the canonicalized argument-type tuple. The
  canonical form **includes `exact`** — each distinct exact-value
  triggers its own specialization key.

## Runtime helpers

Each helper lives in its own `.h` file under `src/codegen/runtime/`,
edited with normal C tooling. `npm run build:snippets` inlines every
`.h` into `snippets.gen.ts` so the translator bundles in the browser.
Each `Builtin` declares its `runtimeDeps: string[]`; the emitter
activates them transitively and dedupes headers. Adding an `.h` means
re-running `build:snippets` and registering the snippet in
`src/codegen/runtime.ts`.

## Numbl import paths

mtoc2 imports numbl source via sibling-relative paths
(`../../numbl/src/numbl-core/...`). This makes mtoc2 dependent on numbl
being checked out at `../numbl`. The single root `tsconfig.json` doesn't
use composite/project-references because that mode requires every
transitively-imported file to be in `include`, which fights with the
sibling import. `tsc` (not `tsc -b`) is the typecheck command.

## What NOT to bring back from mtoc

The original mtoc carried a lot of complexity that mtoc2 is intentionally
deferring or rebuilding. Don't reflexively port:

- Old optimization toggles (`enableTempInlining`, `threads`, etc.).
- Native execution server. mtoc2 runs WASM-only in the browser; the CLI
  shells out to `cc` directly.
- Vendoring of the numbl parser via a sync script. mtoc2 imports
  directly.

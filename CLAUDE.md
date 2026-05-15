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
  N≥2-output slots accept any type for which `isMultiOutputSlotType`
  returns true — scalar real numeric plus every owned kind (tensor,
  struct, class instance, function handle, Char/String). Void /
  Unknown stay rejected. Multi-output class methods and handle
  dispatch are not yet supported.
- **Real tensors** — mtoc-style "always-copy" model: `mtoc2_tensor_t`
  struct with `mtoc2_tensor_assign` / `mtoc2_tensor_copy` /
  `mtoc2_tensor_free`; no refcount, no COW. Every tensor source-literal
  lowers to a `TensorBuild` IR node (column-major flat array of element
  expressions), materialized at the use-site via `mtoc2_tensor_from_row`
  / `mtoc2_tensor_from_matrix`. (Special case: a 1×1 tensor literal
  `[x]` lowers to the inner scalar — same as MATLAB.) When every
  element of a tensor literal is exact and the total fits the
  exact-array cap, the literal's type carries an `exact: Float64Array`
  so downstream type-driven folding (e.g. `reshape`'s Form B dim
  vector, `sum` on a known-data vector) can use it. Rank-N tensors
  (up to `MTOC2_MAX_NDIM = 8`) are constructed via `zeros` / `ones`;
  each shape arg may be exact (pins the axis at translate time, with
  exact fill data when the result fits the cap) or a runtime scalar
  (the corresponding axis is `unknown` in the result lattice and the
  runtime helper takes the value via the emitted dim list). The
  single-arg square form `zeros(n)` / `ones(n)` with a runtime `n`
  routes through `mtoc2_tensor_<kind>_square` so the source
  expression is evaluated exactly once. Bracket syntax stays 2-D-only.
  Bracket concat `[a, b; c, d]` accepts cells with runtime-only dims
  (e.g. `[v; v(1)]` where `v` is a column vector of unknown length).
  The IR's `TensorConcat` carries per-row heights and per-cell cols as
  `number | null`; codegen takes a static fast path when everything is
  known and a dynamic path (running `long` row/col accumulators, with
  `.dims[k]` queried per cell) otherwise.
- **Reshape**: `reshape(A, d1, …, dN)` (Form A) and
  `reshape(A, [d1, …, dN])` (Form B). 1..`MTOC2_MAX_NDIM` axes total,
  trailing exact singletons stripped down to a 2-axis minimum. Form
  A dims may be exact or dynamic (same discipline as `zeros`/`ones`
  — dynamic axes leave the result lattice's slot as `unknown`); Form
  B's dim vector itself must still be statically known. Element-
  count check at translate time when the input shape AND every new
  dim is statically known; deferred to `mtoc2_reshape_nd` (which
  aborts on mismatch) otherwise. Output type carries the same
  `exact: Float64Array` (column-major reinterpret) when input has
  it, the new shape is fully exact, and the result fits the cap.
  Form A accepts a single `[]` auto-infer slot
  (`reshape(A, [], 3)`); the lowerer fills it from
  `numel(A) / prod(others)` when both are known statically, otherwise
  the runtime helper sees a `-1L` sentinel and resolves the slot at
  call time. Form B (`reshape(A, [d1,…,dN])`) still rejects an
  internal `[]` placeholder — the dim vector itself must be a static
  constant.
- **Tensor arithmetic** — elementwise `+` `-` `.*` `./` `-` (unary)
  on same-shape tensors, tensor-with-scalar-broadcast, and
  MATLAB-style implicit expansion between tensors of different
  (but compatible) shapes. Each op emits a per-op runtime helper
  call (`mtoc2_tensor_<op>_tt` / `_ts` / `_st` / `_bcast_tt`). The
  `_bcast_tt` path activates when at least one axis is statically
  1 on one side but not the other, or when ndims differ and the
  shorter shape needs trailing-1 padding; otherwise codegen takes
  the faster `_tt` path. The transfer folds when every input is
  exact and the output fits the cap. Matrix `*` (`mtimes` on
  two tensors) is supported for real 2-D operands via
  `mtoc2_tensor_mtimes_real`; the 1×k \* k×1 inner-product case
  routes through a scalar-returning variant so the type system's
  scalar-result classification stays sound. Matrix `/`
  (`mrdivide` between two tensors) is not yet supported.
- **Reductions** (`sum`, `prod`, `mean`, `min`, `max`, `any`, `all`)
  on real-numeric scalars / vectors / matrices / N-D tensors. Three
  call forms per op: default (`sum(A)` — first non-singleton dim
  via `chooseDefaultAxis` on mtoc2's `DimInfo` lattice plus
  concrete shape when set); explicit dim (`sum(A, dim)`, or
  `min(A, [], dim)` / `max(A, [], dim)` because of MATLAB's slot
  layout); and the literal `'all'` flag that collapses every axis
  to a single scalar. Shared transfer/codegen lives in
  `src/lowering/builtins/reduction/_shape.ts`; the C-side helpers
  are macro-generated into `src/codegen/runtime/tensor_reduce_real.h`,
  defining one `mtoc2_<name>_all` (scalar return) and one
  `mtoc2_<name>_dim` (tensor return) per op. The transfer folds
  exact tensors up to `EXACT_ARRAY_MAX_ELEMENTS`; above the cap (or
  on opaque input) codegen routes to the runtime. Deferred: the
  elementwise 2-arg form `min(A, B)` / `max(A, B)`, the multi-
  output `[v, i] = min(x)` index-returning form, the
  `'omitnan'` / `'includenan'` flag, complex input, runtime
  (non-exact) integer `dim`, and reducers on a genuinely
  ambiguous lattice (`[notOne, unknown]` without an explicit
  `dim`). `length` / `numel` are not reducers and stay routed
  through `mtoc2_length` / `mtoc2_numel` (codegen emits the
  literal `1.0` for scalar args since the C arg is a bare
  `double`).
- **disp** routes on shape: scalar → `mtoc2_disp_double`,
  multi-element tensor → `mtoc2_disp_tensor`.
- **Indexing & slicing** — scalar reads/writes (`v(i)`, `M(i,j)`,
  `T(i,j,k)`, `v(end)`, `M(end,end-1)`), range/colon slice reads/writes
  (`v(:)`, `v(a:b)`, `M(:, j)`, `T(:, :, i) = page`), per-axis
  vector-of-indices gather reads (`M(:, idx_vec)`, `T(i_vec, :, j)`
  — the indexed axis is replaced by the numeric index tensor, which
  the runtime bounds-checks per access), and range-as-value
  (`v = 1:n`, `(1:5)*2`, etc.). Scalar offsets are computed via the
  shared column-major formula `emitNdScalarOffset`; slice reads
  allocate a freshly-owned result via `mtoc2_tensor_alloc_nd` and
  loop; slice writes mutate the base buffer in place with a runtime
  count check on tensor RHS. Range-as-value lowers to a `MakeRange`
  IR node and emits via `mtoc2_tensor_make_range`. Member-rooted
  reads (`obj.field(args)`) lower via a synthesized hoist: the
  property load lands in a fresh `_mtoc2_t<N>` temp and the index
  args run through the standard `IndexLoad` / `IndexSlice` path
  against that temp (see `lowerMemberRootedIndex` in
  `src/lowering/lower.ts`). Logical-mask indexing
  (`a(mask)`), linear-form vector-of-indices (`a(idx_vec)` in a
  single-slot context), vector-of-indices _writes_, and
  member-rooted _writes_ (`obj.f(i) = rhs`) are not yet supported.
- **`sort`** — stable ascending sort on a real 1-D vector
  (`b = sort(a)` or `[v, i] = sort(a)`). The two-output form is the
  first builtin to opt into the multi-output ABI: the `Builtin`
  registry entry sets `multiOutput.{minNargout, maxNargout, transfer,
cName}` and `lowerMultiAssign` routes through the same
  `MultiAssignCall` IR shape user functions use, with the helper's
  C name returned by `multiOutput.cName(argTypes, nargout)`.
  Multi-dimensional sorts (`sort(M, dim)`), `'descend'`, and the
  matrix-default-axis path are not yet supported.
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
- **Class folders** — `@ClassName/ClassName.m` is the classdef file
  (constructor + property declarations); sibling `@ClassName/foo.m`
  files are instance methods, one method per file. Numbl's
  `registerWorkspaceFiles` already detects this layout and populates
  `ClassInfo.externalMethodFiles` for each class; mtoc2's
  `Workspace.finalize` reuses that map directly — for each entry it
  pulls the parsed AST out of numbl's `fileASTCache` and passes the
  primary `Function` statement into `registerClassDef`'s `methods`
  table, so external methods join the same validation pipeline as
  in-body methods (outputs ≤ 1, no `get.`/`set.` accessors, no
  duplicates). Once registered, dispatch is identical to a method
  declared inside the classdef body: `obj.foo(args)` and `foo(obj)`
  both resolve through numbl's `resolveFunction` to a
  `classMethod` target and specialize via
  `classMethodSpecSource(className, methodName)`. Not yet supported:
  external constructor (`@ClassName/ClassName.m` constructor must
  live inside the classdef block), per-method local helper functions
  in external method files (numbl swaps them in via `withMethodScope`;
  mtoc2 has no equivalent).
- **Text** — two distinct owned kinds, matching numbl: `Char` (single-
  quoted `'foo'`, 1×N row of bytes; `length('foo') == 3`) and `String`
  (double-quoted `"foo"`, scalar handle; `length("foo") == 1`). Both
  back to per-kind C structs (`mtoc2_char_tensor_t` /
  `mtoc2_string_t`) that participate in the standard owned-value
  lifecycle (empty/assign/copy/free). Literal sources route through
  `_from_literal` builders that point at `.rodata` with `owned=0` so
  no allocation happens at the literal site. The non-owning
  `mtoc2_text_view_t` adapter lets read-only helpers (disp, error,
  fprintf, sprintf, assert-with-msg) walk either source kind via
  `mtoc2_text_from_string` / `mtoc2_text_from_char_tensor`. Concat
  via `[...]`, char arithmetic (`'A' + 1`), and `strcmp` are deferred
  until needed.
- **Formatted I/O** — `fprintf(fmt, args...)` (stdout; leading-fid
  form deferred), `error(msg)` / `error(fmt, args...)` /
  `error(id, fmt, ...)` (writes to stderr + abort), `sprintf` (char
  format returns Char, string format returns String), and the
  printf-style `assert(cond, fmt, args...)` form. All share the
  `format_engine.h` walker — numbl-compatible spec set
  (`d/i/u/f/e/E/g/G/x/X/o/s/c/%`), flags, precision, `*` width,
  escapes `\n/\t/\\`, column-major tensor flattening, and
  format-string cycling. Complex args are rejected at lowering.
  Argument transport is a per-call `mtoc2_fprintf_arg_t[]` compound
  literal; the shared `_format_args.ts` helper builds the slots and
  is the single source of truth for the slot tag values.
- **Plotting** — every plotting builtin (`plot`, `surf`, `imagesc`,
  `bar`, `errorbar`, `semilogx`, `semilogy`, `loglog`, `contour`,
  `quiver`, `stairs`, `scatter`, `histogram`, `figure`, `hold`,
  `title`, `xlabel`, `ylabel`, `zlabel`, `subplot`, `legend`,
  `colorbar`, `axis`, `xlim`, `ylim`, `drawnow`, `clf`, `pause`,
  … — see
  [src/lowering/builtins/plot/dispatch.ts](src/lowering/builtins/plot/dispatch.ts))
  routes through one shared lowering that emits a call to
  `mtoc2_plot_dispatch(name, n, args)`. The single C runtime
  helper writes one line of JSON per call to stdout, prefixed
  with the `\x1emtoc2:plot\t` ASCII RS sentinel and followed by
  `fflush(stdout)` — a wrapper / viewer process can split stdout
  on the prefix and feed records to numbl's existing plot module
  in real time. Argument transport reuses the
  `mtoc2_fprintf_arg_t` tagged union (DOUBLE / TEXT / TENSOR);
  complex / struct / class / handle / Void / Unknown args are
  rejected at translate. Plot calls are statement-only — they
  return `Void`, so the value-returning variants
  (`h = gcf`, `lim = xlim`, etc.) surface a clean type error.
  **The accepted name set is imported directly from numbl** —
  `PLOT_ALL_NAMES` in `numbl/src/numbl-core/runtime/plotBuiltinDispatch.ts`
  is the single source of truth (union of `PLOT_DISPATCH_NAMES`,
  the renderable subset, and `PLOT_STUB_NAMES`, the graphics-
  tooling no-ops like `gcf`/`xlim`/`drawnow`). Adding a builtin
  in numbl makes it accept in mtoc2 on the next `tsc` run; names
  absent from numbl raise `UnsupportedConstruct`.
  The cross-runner globally drops the plot-prefixed lines before
  the byte-for-byte stdout compare (numbl produces none of its
  own, so the drop is a no-op there). MATLAB command syntax
  (`hold on`, `figure 1`) is not supported — use the call form
  (`hold('on')`, `figure(1)`).
- **Short-circuit `&&` / `||`** — MATLAB-strict: scalar operands
  only. Tensor operands are rejected with a span. This is a
  deliberate divergence from numbl, which accepts tensors via
  `toBool`; mtoc2 matches MATLAB semantics so emitted C can use
  the native `&&`/`||` directly.
- **`nargin` / `nargout`** — pseudo-variable reads inside a user-
  function body fold to compile-time constants for the current
  specialization. The specialization key salts on `nargout`, so
  `[a]=f(x)`, `[a,b]=f(x)`, and `f(x);` against the same body
  produce distinct C specs.

Not yet supported: matrix division (`mrdivide` between two tensors),
logical-mask indexing (`a(mask)`), linear-form vector-of-indices
reads (`a(idx_vec)` in a single-slot context), vector-of-indices
_write_ (`a(idx_vec) = rhs`),
member-rooted index _write_ (`obj.f(i) = rhs`),
indexed-delete (`a(2:5) = []`), unknown-shape constructors
(`zeros(n)` where `n` is a runtime-only scalar), complex, text
concat (`[a, b]` of two chars), char arithmetic (`'A' + 1`),
`strcmp`, builtin handles, `private/` directories, `import`
statements, `.numbl.js` user functions. Expanding scope is gated by
the cross-runner.

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

**Keep the docs lean.** They're orientation material, not a reference
manual — the source is the reference. When in doubt, leave it out.
Add only what is:

- user-visible (a supported feature, a CLI flag, an error message
  users will hit), or
- a divergence from numbl that someone reading the cross-runner
  output would otherwise be confused by, or
- a load-bearing architectural rule a contributor needs to know
  before they edit the relevant subsystem, or
- a correction to something that is actively wrong.

Skip exhaustive enumerations (every builtin, every runtime helper
header, every IR node, every `UnsupportedConstruct` message),
internal helper names that aren't part of the contract, and "how
it's implemented" details that would rot on the next refactor. If
a fact lives one `grep` away in well-named code, it doesn't need
a doc entry.

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

  **Keep the script count low.** Per-script overhead is substantial —
  each entry spawns `tsx` for numbl, then `tsx` again for mtoc2, then
  `cc` to compile the emitted C, then runs the binary. A wall-time
  budget that should stay close to ~15s end-to-end means consolidating
  related cases into one file rather than minting a fresh script per
  feature or regression. Prefer the topic-file pattern (see
  [test_scripts/indexing.m](test_scripts/indexing.m)): a thin
  top-level block that calls a series of local functions, one per
  scenario. New regression cases join the existing topic file
  (an indexing regression goes into `indexing.m`, a tensor-arithmetic
  regression into `tensors.m`, etc.) unless the topic genuinely
  doesn't exist yet. Two reasons to start a fresh file: the topic is
  new, or the file needs its own `% mtoc2-test-mask:` /
  `% mtoc2-test-drop:` directive that would contaminate unrelated
  scripts.

- **Vitest** is reserved for unit-level assertions (emitted-C shapes,
  error attribution, type-system invariants). Cases live under `tests/`
  and run with `npx vitest run`. Don't add per-script entries to vitest.

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
  `mtoc2_tensor_free(&v)` for each owned local. The early-free pass
  (see below) NULLs the buffer at its last use, and every owned
  `_free` helper bottoms out at `free(NULL)` — so a scope-exit free
  of an already-freed local is redundant but safe. Frees are emitted
  unconditionally; an earlier `nullAtScopeExit` optimization tried
  to skip provably-NULL frees but didn't model early-return paths
  correctly and was removed.
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

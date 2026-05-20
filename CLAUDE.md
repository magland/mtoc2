# CLAUDE.md

Project instructions for agents working in mtoc2.

## What this project is

mtoc2 is a numbl-dialect compiler with three execution backends:

- **interpreter** — tree-walks the AST through builtin `call` hooks
- **js-aot** — lowers to IR, emits JS via builtin `emitJs` hooks,
  runs in-process
- **c-aot** — lowers to IR, emits C via builtin `emitC` hooks,
  compiles via `cc`

All three produce bit-identical stdout for any program they support.
A single builtin registry feeds every backend; each builtin
implements one required `transfer` (type inference) plus up to three
backend hooks (`call`, `emitJs`, `emitC`). When a backend lacks a
hook for a builtin it needs, that backend raises a clear error at
the call site.

The type system threads **exact-value tracking** through every
scalar — builtin `transfer` functions compute exact results when all
inputs are exact, and the canonical type form includes the exact
value, so each distinct exact-input gets its own function
specialization. None of the three backends substitutes a literal
for a known-exact computation, with one exception: the lowerer's
`if` / `elseif` condition fold (c-aot and js-aot only — the
interpreter walks the AST and never folds branches).

This is a from-scratch rewrite of mtoc. Build up only what we're
certain about. Don't port mtoc features speculatively.

## Project anchor: numbl

**numbl** is a runtime interpreter for the same MATLAB-style
language. It defines the dialect mtoc2 accepts. Two roles:

- **Implementation**: mtoc2 imports numbl's parser directly via
  sibling-relative path (`../numbl/src/numbl-core/parser/...` — see
  `src/parser/index.ts`). No vendoring. Drift is caught at `tsc`
  time. The numbl SHA we last validated against lives in
  `NUMBL_VERSION`.
- **Testing**: numbl's CLI is the cross-runner oracle. Every `.m`
  script in `test_scripts/` runs through both numbl and mtoc2's
  c-aot backend; stdouts must match byte-for-byte. The all-modes
  runner extends this to mtoc2's interpreter and js-aot backends.

During development numbl lives at `../numbl` (sibling directory) and
is available to read. When a question comes up about how the
dialect should behave, the answer is "what numbl does" — read the
relevant file under `../numbl/src/numbl-core/`.

The interpreter in particular adheres closely to numbl's
interpreter (`../numbl/src/numbl-core/interpreter/`) since that's
where the dialect's edge cases are most thoroughly worked out. When
adding interpreter coverage, the first question is "what does numbl
do here?", and the second is "how do I express the same thing
through mtoc2's builtin registry?"

The long-term plan is that numbl's own JIT path goes away and numbl
uses mtoc2 for compiled execution.

## Scope

mtoc2 is a typed compiler with a deliberately limited feature set —
anything outside scope raises `UnsupportedConstruct` with a source
span (or a `TypeError` for shape mismatches).

For the canonical list of what's supported, read
[test_scripts/](test_scripts/) — every topic file is a feature
inventory by example. Highlights:

- **Numerics**: scalar and N-D real / complex `double` (up to
  `MTOC2_MAX_NDIM = 8` axes); elementwise arith with broadcast;
  matrix `*`; comparisons; reductions; reshape / transpose / flip /
  sort; tic/toc; complex literals and most unary math.
- **Indexing**: scalar reads/writes, `:` and `start:end[:step]`
  slice reads/writes, vector-of-indices gather reads, range-as-value
  (`1:n`), member-rooted reads (`obj.field(args)`).
- **Control flow**: `if` / `elseif` / `else`, `while`, `for`,
  `break`, `continue`, `return`.
- **Functions**: user functions with 0/1/N≥2 outputs; type-tuple
  specialization (c-aot/js-aot); `nargin` / `nargout`; function
  handles (named `@foo` and anonymous `@(x) ...`); self-recursion
  (the lowerer's spec placeholder seeds `outputTypes` with the
  input-type and re-lowers once if the actual outputs differ —
  works when output kind matches input kind, which is the common
  `fact` / `fib` shape).
- **Workspace**: sibling `.m` files; `+pkg/` package functions;
  `@Class/` class folders with instance + static methods and
  external method files.
- **Text**: `Char` (`'foo'`, 1×N bytes) and `String` (`"foo"`,
  scalar handle), used as backing types for `fprintf` / `error` /
  `sprintf` / `assert` with the full numbl-compatible format
  engine.
- **Plotting**: every name in numbl's `PLOT_ALL_NAMES` accepts,
  emitting one JSON record per call (real-time consumable by a
  numbl plot viewer).

Several features still get explicit rejection: logical-mask indexing
(`a(mask)`), vector-of-indices writes (`a(idx_vec) = rhs`),
member-rooted index writes (`obj.f(i) = rhs`), indexed delete
(`a(2:5) = []`), char arithmetic (`'A' + 1`), `strcmp`, builtin
handles (`@disp`), `private/` directories, `import` statements, and
`.mtoc2.js` user functions with `cSources`. Expanding scope is
gated by the cross-runner.

Coverage parity across backends is uneven today — c-aot is the most
complete, js-aot and the interpreter have gaps documented in
[docs/architecture.md](docs/architecture.md) and tracked by the
all-modes runner. The principle is that all three backends share
`transfer`, so anything c-aot accepts also passes type-checking in
the other two; the gap is in `call` / `emitJs` coverage of complex
arithmetic, logical-mask indexing, and a few other paths.

## Three backends, one contract

Every builtin lives in its own file under
[src/builtins/defs/](src/builtins/defs/) and registers up to four
hooks via [`registerBuiltin`](src/builtins/registry.ts):

```ts
interface Builtin {
  name: string;
  transfer(argTypes: Type[], nargout: number): Type[]; // required
  emitC?(args: EmitCArgs): string; // c-aot
  emitJs?(args: EmitJsArgs): string; // js-aot
  call?(args: CallArgs): RuntimeValue[]; // interpreter
  elementwise?: boolean;
}
```

`transfer` is the source of truth for what's accepted and the shape
it produces. Each backend calls it on the same `argTypes`, so a
call that c-aot rejects also rejects in js-aot and the interpreter.
The interpreter enforces this in `invokeBuiltin` before falling
through to `call`. The c-aot and js-aot paths enforce it during
lowering.

Most arithmetic / math families are wired by a single factory
(`defineElemwiseRealBinary`, `defineUnaryRealMath`,
`defineReducer`) that produces transfer + all three backend hooks
from one small descriptor.

## Docs are part of the change

Every change should keep `docs/` accurate. If you:

- Add a builtin → mention it (and its runtime deps) in
  [docs/architecture.md](docs/architecture.md) if the registration
  pattern is new.
- Add or tighten an `UnsupportedConstruct` / `TypeError` site → if
  it's user-visible, capture it where users will look.
- Change the IR / pipeline / runtime helper system → reflect it in
  [docs/architecture.md](docs/architecture.md).
- Change the type lattice → update
  [docs/type_system.md](docs/type_system.md).
- Change the test layout → update
  [docs/testing.md](docs/testing.md).

Avoid hard-coding line numbers. Refer to subsystems and file
_roles_ so docs survive routine refactors.

**Keep the docs lean.** They're orientation material, not a
reference manual — the source is the reference. When in doubt,
leave it out. Add only what is:

- user-visible (a supported feature, a CLI flag, an error message
  users will hit), or
- a divergence from numbl that someone reading the cross-runner
  output would otherwise be confused by, or
- a load-bearing architectural rule a contributor needs to know
  before they edit the relevant subsystem, or
- a correction to something that is actively wrong.

Skip exhaustive enumerations (every builtin, every runtime helper
header, every IR node, every `UnsupportedConstruct` message),
internal helper names that aren't part of the contract, and
"how it's implemented" details that would rot on the next refactor.
If a fact lives one `grep` away in well-named code, it doesn't need
a doc entry.

## Test discipline

A change is "done" when all of these are clean:

- `npx tsc`
- `npx tsx scripts/run_test_scripts.ts` — c-aot vs numbl, the
  byte-for-byte oracle.
- `npx tsx scripts/run_test_scripts_all_modes.ts` — same scripts
  against all three mtoc2 backends (interpreter, js-aot, c-aot).
  Known backend gaps are declared per-script via
  `% mtoc2-test-xfail-<backend>:` so a clean run stays clean.
  Failures here mean a backend has rotted away from the others.
- `npx vitest run`
- `npm run lint`
- `npm run format:check`

Both runners are commit-time gates. The c-aot runner is the strict
oracle; the all-modes runner is what keeps the interpreter and
js-aot backends from quietly drifting as features land.

`MTOC_TEST_CHECK_LEAKS=1` opts both runners into AddressSanitizer +
LeakSanitizer on the c-aot path. Asan slows cc 3-5x, so this is
NOT part of the regular dev loop — run periodically (e.g. once a
day or before a release tag) to catch owned-value leaks.

Two test layers, strict separation:

- **Cross-runner**
  ([scripts/run_test_scripts.ts](scripts/run_test_scripts.ts))
  compares mtoc2 c-aot and numbl byte-for-byte over every `.m` in
  `test_scripts/`. New end-to-end tests go here as `.m` files
  (auto-discovered).

  **Keep the script count low.** Per-script overhead is
  substantial — each entry spawns `tsx` for numbl, then `tsx`
  again for mtoc2, then `cc` to compile the emitted C, then runs
  the binary. The all-modes runner does this on three mtoc2
  backends. Prefer the topic-file pattern (see
  [test_scripts/indexing.m](test_scripts/indexing.m)): a thin
  top-level block that calls a series of local `test_*`
  functions. New regression cases join the existing topic file
  unless the topic is genuinely new or the file needs its own
  `% mtoc2-test-mask:` / `% mtoc2-test-drop:` directive that would
  contaminate unrelated scripts.

- **Vitest** is reserved for unit-level assertions (emitted-C
  shapes, error attribution, type-system invariants). Cases live
  under [tests/](tests/) and run with `npx vitest run`. Don't add
  per-script entries to vitest.

If a divergence between mtoc2 and numbl is a real numbl bug, file
it upstream; don't paper over it in mtoc2.

## Owned-value codegen invariant (c-aot)

Tensors and the other owned types (strings, chars, structs,
classes, handles) follow mtoc's "always-copy, free-at-scope-exit"
model in the c-aot backend:

- Every owned-typed C expression produces a **freshly-owned** value
  (`mtoc2_tensor_from_row(...)`, `mtoc2_tensor_copy(v)`, op result,
  or a function return).
- Every owned local is **pre-declared at function top** via
  `mtoc2_tensor_empty()` (NULL-pointer state). Every Assign — first
  or subsequent — uses `mtoc2_tensor_assign(&v, rhs)`. First-call
  free of NULL is a no-op; uniform path.
- A tensor `Var` read inside an **Assign RHS** wraps in
  `mtoc2_tensor_copy(v)` so the receiver gets a freshly-owned value
  the assign helper can consume. A tensor `Var` read in a
  non-owning context (e.g. `disp` arg) passes the struct bare — no
  buffer copy.
- Scope exit / before every `ReturnFromFunction` emits
  `mtoc2_tensor_free(&v)` for each owned local. The early-free pass
  (see below) NULLs the buffer at its last use, and every owned
  `_free` helper bottoms out at `free(NULL)` — so a scope-exit free
  of an already-freed local is redundant but safe.
- **Early-free**: a backward "future-touch" dataflow
  ([src/codegen/liveness.ts](src/codegen/liveness.ts)) computes
  per-stmt sets of owned C-names that may be touched at any
  successor. After each stmt, owned names in
  `(uses ∪ defs)(s) − futureTouchOut(s)` get an immediate
  `mtoc2_tensor_free(&v)`. Reassignment counts as a future touch,
  so reassigns suppress redundant early-frees.
- An owned-producing sub-expression (TensorBuild, tensor-typed
  Binary/Unary/Call) inside any larger expression is
  **A-normalized** at lowering time: hoisted to a fresh
  `_mtoc2_t<N>` temp Assign and replaced with a Var of the temp.
  After ANF the IR invariant is: owned-producing expressions appear
  only as direct Assign RHSs at owned consume sites; everywhere
  else they're Var reads. This mirrors mtoc's `anf.ts`; mtoc2
  differs in that elementwise ops _are_ owned producers (we emit
  per-op runtime helpers that allocate fresh) where mtoc fuses them
  into the parent iter loop.

The js-aot and interpreter backends don't manage memory — JS GC
covers it — but they still respect ANF and Var-read shape so each
backend's hook sees the same call context.

## Folding only at if-cond

Exact tracking threads through the type system: builtin transfer
functions compute exact results when all inputs are exact, and the
specialization key includes `exact` so each distinct value triggers
a fresh specialization. But the lowerer **does not** substitute
literals for known-exact computations anywhere except the `if` /
`elseif` condition:

- `a = 2 + 3` lowers to a `Binary` IR node (with `ty.exact = 5`)
  and emits `double a = (2.0 + 3.0);` — the C compiler folds, not
  the lowerer.
- An Ident read of a scalar variable with `exact` always emits a
  `Var`, never a `NumLit`. The C variable holds the value at
  runtime.
- A tensor source-literal always lowers to `TensorBuild` and
  materializes at runtime. There is no `TensorLit` IR node.
- `length` / `numel` emit runtime helper calls; `sum` emits
  `mtoc2_sum`. None fold into a literal at codegen time.
- `disp(a)` always emits the runtime `mtoc2_disp_double` or
  `mtoc2_disp_tensor` helper — no compile-time formatting path.

The only fold site is `condToBool` in
[src/lowering/lower.ts](src/lowering/lower.ts), called from
`lowerIf`: when `cond.ty.exact` is a finite `number`, the
corresponding branch is returned directly and the surrounding `if`
is not emitted. This lets type-directed dead-branch elimination
work (e.g. a user function specialized for `x :: double=5` can have
its `if x > 0` arm decided at spec time) without baking constants
into the user's emitted code.

The interpreter doesn't lower or fold; it always walks the AST as
written.

## Always-materialize tensor Assign

Every tensor Assign emits code — there is no IR node for
"compile-time-only tensor data". TensorBuild RHSs materialize via
`mtoc2_tensor_from_row` / `mtoc2_tensor_from_matrix`; `Var` RHSs
wrap in `mtoc2_tensor_copy`; computed tensor RHSs (`Binary` /
`Unary` / `Call`) emit their per-op runtime helper. The C variable
always holds a freshly-owned tensor after the Assign.

## Testing- and debug-only directives

mtoc2 reuses numbl's `%!numbl:<name> <args>` directive AST as a
channel for translator-side hints. Numbl silently ignores any
unknown directive name, so cross-runner output is unaffected by all
three below.

- `%!numbl:opaque <var> [<var>...]` strips `exact` from each named
  variable in the current env. Mostly used for forcing the runtime
  path in `if`-cond folding tests: `x = 5; %!numbl:opaque x; if x

  > 0` then emits as a runtime branch instead of being statically
  > taken.

- `%!numbl:showtype <var> [<var>...]` snapshots each variable's
  current type and emits one
  `/* type <name> (<cName>) :: <type> */` line in the generated C
  at the directive's source position. Lowers to a `TypeComment`
  IR node; walk / liveness / dataflow treat it as a no-op.

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
  Every scalar has an optional `exact` field; all builtin `transfer`
  fns propagate it when every input is exact. The exact value
  affects function specialization (it's part of the key) and the
  if-cond fold. It does NOT cause the lowerer to substitute
  literals for arithmetic / Ident reads / builtin calls — those
  always emit runtime IR.
- **No JitType reuse**. The type system in
  [src/lowering/types.ts](src/lowering/types.ts) is written from
  scratch — not derived from numbl's `JitType`. numbl's JIT is on a
  path to retirement; mtoc2's lattice is meant to outlive it.
- **Every IR node carries a `Span`**. User-facing errors include it.
  Codegen-time errors should be rare and labeled "internal: should
  have been caught at lowering" — if one fires on a real program,
  hoist the check into lowering with a span.
- **One-pass lowering**. Loop bodies are lowered once. Any variable
  assigned inside a loop body has its `exact` stripped from env
  before the body is lowered, otherwise the single pass would bake
  iteration-1 values into the emitted code.
- **Interpreter follows numbl, not c-aot**. The interpreter is the
  always-available execution path and mirrors numbl's
  interpreter's structure (one class shell with sibling
  prototype-attached implementation files; see
  [src/interpreter/](src/interpreter/)). When in doubt about
  interpreter behavior, look at numbl's
  [interpreter/](../numbl/src/numbl-core/interpreter/) directory.
- **Emit doc-comments alongside C**.
  [src/codegen/prettyIR.ts](src/codegen/prettyIR.ts) renders each
  `IRFunc` and `IRStmt` to a numbl-like comment. The c-aot emitter
  places these above every specialized definition and statement.
  Synthetic ANF temps and folded branches show through.

## Naming

- Synthetic C identifiers and runtime helpers use the `mtoc2_`
  prefix (reserved). numbl forbids leading underscores in
  identifiers, so this namespace stays clean from user code.
- Specialization mangling: `<funcName>__<8-hex>` where the hex is
  the FNV-1a 32-bit hash of the canonicalized argument-type tuple.
  The canonical form **includes `exact`** — each distinct
  exact-value triggers its own specialization key.

## Runtime helpers

Each helper lives in its own `.h` file under
[src/builtins/runtime/](src/builtins/runtime/) (organized into topic
subfolders: `tensor/`, `tensor_ops/`, `text/`, `io/`, `indexing/`,
`plot/`, `system/`), with a paired `.js` sibling for the js-aot
backend / interpreter to load via the same registry. `npm run
build:snippets` inlines every `.h` and `.js` sibling into
`snippets.gen.ts` so the translator bundles in the browser.

Each `Builtin` declares its `runtimeDeps: string[]`; the c-aot
emitter activates them transitively and dedupes headers, and
js-aot does the same with the JS siblings. Adding a helper means
dropping the `.h`/`.js` into the topic folder that fits, re-running
`build:snippets`, and registering the snippet in
[src/codegen/runtime.ts](src/codegen/runtime.ts). The snippet
registry keys by basename, so basenames must stay globally unique.

## Numbl import paths

mtoc2 imports numbl source via sibling-relative paths
(`../../numbl/src/numbl-core/...`). This makes mtoc2 dependent on
numbl being checked out at `../numbl`. The single root
`tsconfig.json` doesn't use composite/project-references because
that mode requires every transitively-imported file to be in
`include`, which fights with the sibling import. `tsc` (not
`tsc -b`) is the typecheck command.

## What NOT to bring back from mtoc

The original mtoc carried a lot of complexity that mtoc2 is
intentionally deferring or rebuilding. Don't reflexively port:

- Old optimization toggles (`enableTempInlining`, `threads`, etc.).
- Native execution server. mtoc2 runs WASM-only in the browser; the
  CLI shells out to `cc` directly.
- Vendoring of the numbl parser via a sync script. mtoc2 imports
  directly.
- The c2js translator that used to live under `src/cjs/`. The
  js-aot backend (`src/codegen/emitJs.ts`) replaces it — one JS
  path through the builtin registry instead of two.

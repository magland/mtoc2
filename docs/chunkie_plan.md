# chunkie support plan — driving numbl parity

**Goal:** push mtoc2 toward numbl parity, using
`tmp/chunkie_ex01_circle.m` as the proving ground. The long-term
target is "anything numbl runs, mtoc2 runs" — chunkie is a
real-world MATLAB toolbox that, pulled in transitively from a
20-line driver, surfaces gaps in a realistic dependency order.
Closing the last gap means the driver runs end-to-end in all three
mtoc2 backends (interpreter, js-aot, c-aot), byte-for-byte aligned
with numbl. The interpreter is the first target for each new
feature; AOT support follows where static analysis permits.

The framing matters. Each gap that chunkie surfaces ships as a
**general feature** — implemented the way numbl implements it, with
full numbl-shaped semantics — not a narrow slice tailored to the
exact lines chunkie executes. Chunkie is the forcing function and
the cross-check; numbl is the spec. The features we add along the
way should benefit any future program, not just this one.

This document is the orientation for future agents working on that
path. The feature inventory below is the chunkie audit at the time
of writing — a map of work units, not a contract on scope. Phases
ship as useful units, gated by the cross-runner.

## Methodology

1. **Numbl is the oracle.** Before changing mtoc2 to support a new
   feature, run the snippet through numbl and read the relevant
   `../numbl/src/numbl-core/` source. Match numbl's behavior, not
   intuition. The shape of the feature mtoc2 grows is numbl's
   shape — including the corners chunkie doesn't exercise.

2. **Implement features in full, not in slices.** A chunkie gap
   surfaces a _feature class_ (a builtin family, an IR construct,
   a workspace rule). Implement that feature class the way numbl
   implements it — including the inputs, error modes, and edge
   cases chunkie itself doesn't touch — so a future program that
   uses the same feature differently still works. Example: if
   chunkie surfaces `sort(x, 'descend')`, land mode-arg support
   end-to-end (`'ascend'`, `'descend'`, the index-output overload
   if numbl supports it) — not just the literal call the chunkie
   line makes.

3. **One feature per topic file.** Each added feature class gets
   its own `.m` script (or subtests in an existing topic) under
   `test_scripts/`. The topic file should cover the feature's
   surface (success cases, edge cases, error cases) — not only
   the slice chunkie hit. The cross-runner and all-modes runner
   are the commit-time gates. **Do not** add
   `tmp/chunkie_ex01_circle.m` to `test_scripts/` until it
   actually passes end-to-end — the topic files are the staircase
   that gets us there.

4. **AOT-feasibility is judged per feature.** Some features the
   chunkie script needs (`try/catch`, cell comma-list expansion
   into multi-output, dynamic struct shape) may be interpreter-only
   for the foreseeable future. When a feature lands interpreter-
   first, the lowerer raises `UnsupportedConstruct` with a
   span-attributed message, and the all-modes runner's
   `% mtoc2-test-xfail-c-aot:` / `-js-aot:` directive marks the
   script xfail for those backends. The interpreter is the
   always-available execution path.

5. **Generality, bounded by the feature.** Implement features in
   the generality numbl supports, not the narrower slice chunkie
   happens to use. But don't bundle _unrelated_ features into the
   same phase — if the file that needs `strcmp` also has `regexp`,
   don't land `regexp` unless something else needs it. The unit
   of work is "the feature, as numbl does it," not "every call
   site in the file I happened to open."

6. **Refactor when a feature needs it; don't refactor speculatively.**
   If the next feature would land cleanly on top of a small
   restructure (extracting a helper, splitting an overloaded
   function, generalizing a sentinel), do the refactor as its own
   commit ahead of the feature commit. Don't bolt the feature onto
   a shape that fights it — that's how the code drifts toward the
   pre-rewrite mtoc. But also don't refactor "while you're in
   there" for areas the current feature doesn't touch; that's
   bloat.

## Done in this plan

- **Parse-error tolerance on workspace siblings.** `parseFiles`
  catches the parser's `SyntaxError` for every non-main file,
  emits a warning matching numbl's format (`Warning: skipping
<path> (syntax error at line N)`), and drops the file. The
  driver/active file's parse errors still propagate. Test:
  `test_scripts/addpath_bad_sibling/`. This was needed because
  chunkie contains files with parse errors that numbl silently
  skips.

- **External method file local helpers.** Per-method-file local
  helper functions (numbl's `withMethodScope` shape):
  `@<Class>/<method>.m` may declare top-level functions after the
  primary; the helpers are visible only inside that method file,
  so sibling external methods can reuse the same helper names
  without conflict. Implemented in all three backends —
  `Workspace.resolve` derives `{className, methodName}` from a
  call site whose file matches `@<Cls>/<m>.m`, then routes the
  `localFunction(classFile)` verdict to the right external file's
  body. The interpreter / lowerer thread the method's source file
  through dispatch so the resolver sees the right current file.
  Classdef-body subfunctions (top-level helpers in `<Class>.m`
  itself, visible to every method) are a separate feature class
  and still get an explicit reject. Test:
  `test_scripts/class_external_helpers/`.

- **`isfield` / `isscalar` + empty-as-absent-struct sentinel.**
  Two scalar-predicate builtins matching numbl's contract:
  `isfield(s, name)` returns `1` iff `s` is a struct or class
  instance with a field/property of that name, `0` otherwise —
  so `isfield([], 'foo')` is `0` and the `cparams = []` sentinel
  works without any "empty-as-struct" coercion (numbl has none
  either). `isscalar(x)` is `1` for any one-element numeric /
  logical / complex value or scalar string handle, `0` for char
  arrays (even `'a'`), structs, class instances, handles, and
  multi-element tensors. Both fold at type-check time: the
  struct's field set and the value's shape are known statically,
  so every supported call site reduces to a literal in the
  emitted code. `isfield` requires its name arg to be a Char or
  String with `.exact` set (the chunkie shape — runtime-only field
  names raise `UnsupportedConstruct`). Test:
  `test_scripts/scalar_predicates.m`.

- **Text + sort + tolerance scalars.** Five related builtin
  feature classes:
  - `strcmp(a, b)` / `strcmpi(a, b)` — scalar text equality
    (byte-equality / ASCII case-fold). Non-text args silently yield
    `0` per numbl; length mismatch is not an error. Cell-of-text
    vectorisation deferred until cells land. Test additions in
    `test_scripts/text.m`.
  - `sort(x, 'ascend' | 'descend')` — mode arg on the existing
    1×N / N×1 sort. Descending comparator preserves the stable
    tie-break on ascending original index in both directions
    (matches numbl). Test additions in `test_scripts/indexing.m`.
  - `dot(a, b)` — real-double dot product: vector × vector →
    scalar; matrix × matrix (same shape) → `[1, N]` row vector
    of column-wise dot products. Complex `dot` (numbl uses
    `sum(conj(a).*b)`) currently raises `UnsupportedConstruct`.
    Test additions in `test_scripts/math_builtins.m`.
  - `norm` extended to `norm(v, p)` / `norm(v, Inf)` /
    `norm(v, -Inf)` / `norm(v, 'fro')` / `norm(v, 'inf')` for
    real and complex vectors, scalar passthrough as `abs`. Matrix
    norms (numbl: `p ∈ {1, 2, Inf, 'fro'}`) still rejected with a
    clear `UnsupportedConstruct`. Test additions in
    `test_scripts/math_builtins.m`.

  - `uniquetol(x[, tol])` — first-occurrence dedup with absolute
    tolerance, default `1e-6`. Naive pairwise scan (NOT sort +
    adjacent dedup), preserving numbl's transitive-chaining
    behaviour. Row input → row output; otherwise column output.
    NaN survives as its own entry per scan. Multi-output
    `[c, ia, ic]` form, `'ByRows'`, and complex inputs are
    out of scope. Test: `test_scripts/uniquetol_basics.m`.

- **Multi-output handle calls + method-returning-self.**
  `[a, b, ...] = h(args)` where `h` is an in-scope handle variable
  now specializes the handle's target at the caller's nargout and
  emits the same `Call` / `MultiAssignCall` IR shape user-function
  calls produce. Both the truncation case (single-out call on a
  multi-output target) and the bare-statement case (`h(args);`
  with no lvalues) are wired. The previous "handle dispatch not
  supported" rejection in `dispatchHandleCall` is removed.
  Method-call-returning-self (`chnkr = chnkr.addchunk(nch)`) was
  verified to already work through existing class support. Test
  additions in `test_scripts/handles.m`.

- **Member-rooted indexed writes.** `obj.field(i, j) = rhs` and
  `obj.field(:, :, k) = rhs` work in all three backends for both
  struct values and class instances. `IndexStore` /
  `IndexSliceStore` gained an optional `fieldPath` / `leafTy`
  pair: the IR's `base` Var still names the OWNING root (struct /
  class) so liveness keeps tracking the root, and codegen targets
  the slot via `<rootCName>.<fieldPath...>` with the field's
  NumericType driving offset / complex-lane decisions. The
  interpreter clones the root struct + leaf tensor on the write
  path so pass-by-value semantics hold. The post-write env
  refresh widens the leaf field's NumericType (strip `exact`,
  sign → unknown). MultiAssign with member-rooted lvalues
  (`[chnkr.a, chnkr.b] = ...`) is still rejected — a separate
  sub-feature. Tests in `test_scripts/structs.m` and
  `test_scripts/classes.m`.

## Feature inventory

The chunkie driver (`tmp/chunkie_ex01_circle.m`) is short. Most of
the missing work lives transitively in `chunkerfunc.m`, the
`@chunker/` class folder, and the `+lege/` package. The list below
is the audit at the time of writing — recheck via numbl if
anything looks stale.

Each row is a **feature class**, not a per-call-site task. When
you pick one up, scope the implementation to numbl's behavior for
that whole feature (per methodology rule 2), not just the chunkie
slice. The chunkie reference is what surfaced the gap; the spec
is numbl.

### Surface (`chunkie_ex01_circle.m`)

| Feature                                                               | State                             |
| --------------------------------------------------------------------- | --------------------------------- |
| `addpath('<abs>')` in driver prologue                                 | done                              |
| `tic` / `toc`                                                         | done                              |
| `rad = 2; ctr = [1.0;-0.5];` (multi-stmt, column-vec literal)         | done                              |
| Anonymous handle capturing locals: `@(t) ctr + rad*[...]`             | done; re-verify capture-by-value  |
| `t(:).'` (linearize + transpose)                                      | done                              |
| `chunkerfunc(circfun)` — call into addpath'd `.m` returning a class   | depends on the @class/ work below |
| Plot family: `figure / clf / plot / hold / quiver / axis equal tight` | done (plot dispatch)              |

### Transitive (`chunkerfunc.m`, `@chunker/`, `+lege/`, `+chnk/`)

Grouped by the level of change required, roughly in dependency order.
Items higher in the list are prerequisites for items lower down.

| Group | Feature                                                                                    | Notes                                                                                                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Parse-error tolerance on workspace siblings                                                | done                                                                                                                                                                                          |
| 1     | External method file with local helper functions (`@chunker/arcresample.m`)                | done                                                                                                                                                                                          |
| 2     | Empty-matrix as struct sentinel: `cparams = []` then `isfield(cparams,'ta')` returns false | done (falls out of `isfield`'s "non-struct → false" branch; numbl has no `[]`-as-struct coercion either)                                                                                      |
| 2     | `isfield(s, 'name')` and `isscalar(x)` builtins                                            | done                                                                                                                                                                                          |
| 2     | `sort(x, 'ascend' / 'descend')` mode arg                                                   | done                                                                                                                                                                                          |
| 2     | `strcmpi(a, b)` and `strcmp(a, b)`                                                         | done                                                                                                                                                                                          |
| 2     | `uniquetol(x, tol)`                                                                        | done (first-occurrence naive scan — NOT sort+dedup, to preserve numbl's transitive-chaining behaviour). Multi-output `[c, ia, ic]` form deferred.                                             |
| 2     | `norm(v)` / `dot(a, b)`                                                                    | `norm(v)` was already in; `dot(a,b)` done for real vector and real matrix (column-wise) forms. Complex `dot` and `norm` p-arg / 'fro' / 'inf' are separate sub-features.                      |
| 3     | Member-rooted indexed write: `chnkr.field(:,:,i) = rhs`                                    | done                                                                                                                                                                                          |
| 3     | Method call returning self: `chnkr = chnkr.addchunk(nch)`                                  | done (works end-to-end in all three backends via existing class support; verified 2026-05-26).                                                                                                |
| 3     | Multi-output handle call: `[r,d,d2] = fcurve(t)`                                           | done                                                                                                                                                                                          |
| 4     | `cell(n, m)` cell array                                                                    | new owned-value kind. **Major.** Touches type lattice, IR, all three backends' runtime helpers.                                                                                               |
| 4     | Cell read/write `out{j}`                                                                   | follows cells.                                                                                                                                                                                |
| 4     | Comma-list expansion `[out{1:nout}] = fcurve(ts)`                                          | follows cells. Lowering rewrites the LHS into N separate stores from a dynamic-arity call.                                                                                                    |
| 5     | `try / catch`                                                                              | currently no IR node. Interpreter is feasible (JS `try/catch` around `execStmt`). c-aot requires `setjmp/longjmp` or a thread-local error-state pattern. Likely interpreter-first, AOT-xfail. |
| 5     | `warning(msg)` builtin                                                                     | one printf-style call to stderr. Small.                                                                                                                                                       |
| 5     | `error(fmt, args)` builtin                                                                 | already partial; verify format string with `%d`.                                                                                                                                              |

### Likely interpreter-only (xfail in AOT)

- `try / catch` — see Group 5.
- Any path inside `chunkerfunc.m` that uses cells with **non-static
  index expressions** (`out{1:nout}` where `nout` is runtime-known
  only). Static-arity AOT cell expansion is possible; the chunkie
  code uses a runtime `nout` from a probe-try block, which couples
  cells to try/catch and probably stays interpreter-only.

The all-modes runner's `% mtoc2-test-xfail-c-aot:` /
`% mtoc2-test-xfail-js-aot:` directives are the contract for "this
script intentionally doesn't run in backend X." Use them rather
than wiring AOT to silently fall back to the interpreter.

## Suggested phase order

Each phase is a self-contained PR that lands a **feature class**
in the generality numbl supports. Chunkie is the cross-check that
the feature pulled in is actually useful; numbl is the spec for
what the feature should do. Cross-runner stays green at every
phase boundary. Phases land in the order their _outputs_ are
needed by later phases.

1. **External method file local helpers (workspace feature class).**
   Class-folder method files (`@class/external.m`) that declare
   per-method subfunctions, scoped the way numbl scopes them via
   `withMethodScope`. Topic test exercises a multi-method class
   where helpers in different method files reuse the same name —
   not just the chunkie case. (Group 1)

2. **Empty-matrix as struct sentinel + scalar predicates
   (semantics feature class).** `[]` as an absent-struct sentinel
   plus `isfield`/`isscalar`. Cover numbl's full sentinel
   semantics (`isfield` on a non-struct, `isscalar` across
   numeric/struct/char/string/handle), not only the
   `if ~isfield(opts,'name')` chunkie pattern. (Group 2)

3. **Text + sort + tolerance scalars (builtin family).**
   `strcmp` / `strcmpi`, `sort(...,'ascend' / 'descend')`,
   `uniquetol`, `norm`, `dot`. Each builtin lands with the full
   numbl-supported signature space (e.g. `sort` with the index
   output overload, `norm` with the order argument) — not the
   one-shape slice chunkie hits. (Group 2)

4. **Member-rooted indexed writes + multi-output handle calls
   (IR feature class).** Lowerer changes that generalize index-
   write to member-rooted LHS and multi-output to handle-call
   RHS. Both are general IR shapes; once landed they're
   available everywhere, not just to chunkie call sites.
   (Group 3)

5. **Cells (type-system feature class).** New owned-value kind.
   Plan this one out in its own doc (à la `complex_plan.md`)
   before starting. Scope to numbl's full cell semantics — read,
   write, comma-list expansion, `iscell`, etc. — not only the
   `out{1:nout}` slice in `chunkerfunc.m`. (Group 4)

6. **`try` / `catch` (interpreter-only first, control-flow
   feature class).** Add an IR node for completeness, raise
   `UnsupportedConstruct` for AOT, wire the interpreter's
   `execStmt`. Cover numbl's full try/catch semantics (the
   `catch ME` binding, `MException` shape if numbl supports it,
   nested try). Land with the all-modes xfail directive.
   (Group 5)

7. **End-to-end pass on `chunkie_ex01_circle.m`.** At this point
   the driver should work in the interpreter. AOT may xfail on a
   handful of leaf functions. Add a top-level entry in
   `test_scripts/` (probably `test_scripts/chunkie_ex01/` with a
   `main.m` that copies the driver verbatim) so the result stays
   gated. After this phase, the same feature units we built
   should let other MATLAB toolboxes start working with little
   or no incremental effort — that's the parity payoff.

Don't sweat the numbering — if step 3 turns out to depend on step
4, reshuffle. The list is a dependency graph more than a timeline.

## Working in this plan

- **Before each phase**, run `npx tsx ../numbl/src/cli.ts run
tmp/chunkie_ex01_circle.m` to confirm numbl still runs it. The
  oracle is what we're matching.
- **During a phase**, add the topic test first
  (`test_scripts/<topic>.m` or a subtest in an existing file),
  watch it fail on numbl-vs-mtoc2, then make it pass. The cross-
  runner output is the test artifact.
- **Run the cross-runners sparingly.** The two suites
  (`run_test_scripts.ts` and `run_test_scripts_all_modes.ts`) each
  spawn dozens of subprocesses and together take a few minutes —
  they're not the tight inner loop. During iteration, exercise the
  one or two scripts you actually changed by invoking the CLI
  directly (`npx tsx src/cli.ts run --exec <mode> <script.m>` vs
  `npx tsx ../numbl/src/cli.ts run <script.m>`) and diff the
  output. `npx tsc` and `npx vitest run` are fast enough to run
  freely. Save the full cross-runner sweep for: (1) right before
  committing a phase, and (2) any time you've changed something
  cross-cutting (the lowerer, a runtime helper used by many
  builtins, the workspace resolver). One full sweep per phase is
  the typical cadence; a second sweep right before pushing.
- **Commit-time gate.** Before a phase merges:
  `npx tsc && npx tsx scripts/run_test_scripts.ts && npx tsx
scripts/run_test_scripts_all_modes.ts && npx vitest run && npm run
lint && npm run format:check`. All clean.
- **Resist scope creep across features.** A phase that lands
  `strcmp` does not also need to land `regexp`, `contains`,
  `lower`, etc. Those are _different_ feature classes. But
  inside the `strcmp` feature, do cover what numbl supports
  (case folding, char vs. string args, vector inputs if numbl
  vectorizes) — that's the in-scope generality from rules 2
  and 5, not creep.

## Reading the chunkie source

- `tmp/chunkie_ex01_circle.m` — the driver.
- `/home/magland/src/chunkie/chunkie/chunkerfunc.m` — the main
  workhorse. Read it once before starting any phase; the same
  patterns repeat across the @chunker/ class folder.
- `/home/magland/src/chunkie/chunkie/@chunker/` — class methods.
- `/home/magland/src/chunkie/chunkie/+lege/` — Legendre-node
  package.

When in doubt about a feature's semantics, read numbl, not MATLAB
documentation. mtoc2's dialect is numbl's dialect.

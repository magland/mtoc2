# chunkie support plan

**Goal:** run `tmp/chunkie_ex01_circle.m` end-to-end in all three
mtoc2 backends (interpreter, js-aot, c-aot), byte-for-byte aligned
with numbl. The interpreter is the first target; AOT support
follows feature-by-feature where static analysis permits it.

`chunkie_ex01_circle.m` is a 20-line driver that calls into
`/home/magland/src/chunkie/chunkie/`, a real-world MATLAB toolbox.
Pulling it in transitively exercises many features mtoc2 does not
yet support. This document is the orientation for future agents
working on that path. It is **not** a contract — phases ship as
useful units, gated by the cross-runner.

## Methodology

1. **Numbl is the oracle.** Before changing mtoc2 to support a new
   feature, run the snippet through numbl and read the relevant
   `../numbl/src/numbl-core/` source. Match numbl's behavior, not
   intuition.

2. **One feature per topic file.** Each added capability gets its
   own `.m` script (or subtests in an existing topic) under
   `test_scripts/`. The cross-runner and all-modes runner are the
   commit-time gates. **Do not** add `tmp/chunkie_ex01_circle.m` to
   `test_scripts/` until it actually passes end-to-end — the topic
   files are the staircase that gets us there.

3. **AOT-feasibility is judged per feature.** Some features the
   chunkie script needs (`try/catch`, cell comma-list expansion
   into multi-output, dynamic struct shape) may be interpreter-only
   for the foreseeable future. When a feature lands interpreter-
   first, the lowerer raises `UnsupportedConstruct` with a
   span-attributed message, and the all-modes runner's `% mtoc2-
test-xfail-c-aot:` / `-js-aot:` directive marks the script
   xfail for those backends. The interpreter is the always-
   available execution path.

4. **No speculative scope.** Add what the chunkie path actually
   needs. Don't reflexively port adjacent MATLAB features just
   because they're listed in `chunkerfunc.m`'s comments.

5. **Refactor when a feature needs it; don't refactor speculatively.**
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

## Feature inventory

The chunkie driver (`tmp/chunkie_ex01_circle.m`) is short. Most of
the missing work lives transitively in `chunkerfunc.m`, the
`@chunker/` class folder, and the `+lege/` package. The list below
is the audit at the time of writing — recheck via numbl if
anything looks stale.

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
| 1     | External method file with local helper functions (`@chunker/arcresample.m`)                | currently rejected in `Workspace.collectExternalMethods`. Numbl scopes the helpers per-method file.                                                                                           |
| 2     | Empty-matrix as struct sentinel: `cparams = []` then `isfield(cparams,'ta')` returns false | numbl treats `[]` as the absent-struct sentinel. Likely just an `isfield` transfer + interpreter `call` update.                                                                               |
| 2     | `isfield(s, 'name')` and `isscalar(x)` builtins                                            | scalar predicates; small.                                                                                                                                                                     |
| 2     | `sort(x, 'ascend' / 'descend')` mode arg                                                   | `sort` exists; verify the mode-string transfer accepts the literal.                                                                                                                           |
| 2     | `strcmpi(a, b)` and `strcmp(a, b)`                                                         | text compare; mtoc2 currently rejects `strcmp`. Numbl is authoritative for case-insensitive folding.                                                                                          |
| 2     | `uniquetol(x, tol)`                                                                        | sort + adjacent-dedup; small builtin.                                                                                                                                                         |
| 2     | `norm(v)` / `dot(a, b)`                                                                    | one builtin each.                                                                                                                                                                             |
| 3     | Member-rooted indexed write: `chnkr.field(:,:,i) = rhs`                                    | explicitly rejected by `lowerMultiAssign` / `lowerIndexStore`. Requires teaching the lowerer to thread the member root through `IndexStore`. Big lift across all three backends.              |
| 3     | Method call returning self: `chnkr = chnkr.addchunk(nch)`                                  | should work once classes are stable; verify.                                                                                                                                                  |
| 3     | Multi-output handle call: `[r,d,d2] = fcurve(t)`                                           | the AST is `MultiAssign` to a handle call. Today, multi-out is wired for named user functions; handles need the same path.                                                                    |
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

Each phase is a self-contained PR. Cross-runner stays green at
every phase boundary. Phases land in the order their _outputs_ are
needed by later phases.

1. **Workspace robustness.** External-method-file helpers
   (`@class/external.m` declaring local subfunctions). Mirror
   numbl's behavior for the next-layer error that surfaces after
   the parse-skip change in this PR. (Group 1)

2. **Empty-matrix as struct sentinel + scalar predicates.**
   `cparams = []` patterns with `isfield`/`isscalar`. Lets us
   skip past the default-arg blocks at the top of `chunkerfunc`
   and many other MATLAB functions. (Group 2)

3. **Text + sort + tolerance scalars.** `strcmp` / `strcmpi`,
   `sort(...,'ascend')`, `uniquetol`, `norm`, `dot`. Each is a
   small per-builtin change. (Group 2)

4. **Member-rooted indexed writes + multi-output handle calls.**
   Lowerer-level changes; biggest non-cell lift. (Group 3)

5. **Cells.** New owned-value kind. Plan this one out in its own
   doc (à la `complex_plan.md`) before starting. (Group 4)

6. **`try` / `catch` (interpreter-only first).** Add an IR node
   for completeness, raise `UnsupportedConstruct` for AOT, wire
   the interpreter's `execStmt`. Land with the all-modes xfail
   directive. (Group 5)

7. **End-to-end pass on `chunkie_ex01_circle.m`.** At this point
   the driver should work in the interpreter. AOT may xfail on a
   handful of leaf functions. Add a top-level entry in
   `test_scripts/` (probably `test_scripts/chunkie_ex01/` with a
   `main.m` that copies the driver verbatim) so the result stays
   gated.

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
- **Resist scope creep.** A phase that lands `strcmp` does not
  also need to land `regexp`, `contains`, `lower`, etc. Add what
  the chunkie path uses; the rest waits until something else
  needs it.

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

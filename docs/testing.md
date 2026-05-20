# Testing

Two layers, deliberately separated.

## Cross-runner (the oracle)

`scripts/run_test_scripts.ts` walks every `.m` file under
`test_scripts/`, runs each through numbl's CLI and mtoc2's
**c-aot** CLI, and compares stdouts byte-for-byte. A test fails if
the two runners disagree on a single character.

```
npx tsx scripts/run_test_scripts.ts                # all scripts
npx tsx scripts/run_test_scripts.ts a.m b.m        # specific files
MTOC_TEST_CONCURRENCY=4 npx tsx scripts/run_test_scripts.ts
MTOC_TEST_TIMEOUT_MS=60000 npx tsx scripts/run_test_scripts.ts
```

The cross-runner needs numbl checked out at `../numbl` — same sibling
location mtoc2 imports its parser from.

### All-modes runner

`scripts/run_test_scripts_all_modes.ts` runs each script through
numbl plus all three mtoc2 backends (`--exec interpreter`,
`--exec js-aot`, `--exec c-aot`) and checks they all match numbl
byte-for-byte. Same masking rules as the c-aot-only runner; a
backend that doesn't support a feature yet can be excluded per
script via `% mtoc2-test-xfail-<backend>: <reason>` so the rest of
the corpus still gates that backend.

```
npx tsx scripts/run_test_scripts_all_modes.ts                # all
npx tsx scripts/run_test_scripts_all_modes.ts foo.m          # specific
```

The c-aot-vs-numbl runner is the commit-time gate. The all-modes
runner is the broader signal — run it when working on the
interpreter or js-aot backend, and when verifying that a change
keeps coverage parity across modes.

#### Per-backend expected-failure: `% mtoc2-test-xfail-<backend>:`

Some scripts exercise features the interpreter or js-aot backend
hasn't reached yet (e.g. `LogicalMask` index reads, certain reducer
helpers). Marking the backend xfail for that script lets the
runner skip the compare against numbl for that one backend while
still gating every other backend on every other script. The
directive accepts three backend names — `interpreter`, `js-aot`,
`c-aot`:

```matlab
% mtoc2-test-xfail-interpreter: LogicalMask multi-slot not yet wired
% mtoc2-test-xfail-js-aot: emitJs LogicalMask path missing
```

Each directive requires a non-empty reason — it documents the gap
in the script itself, so closing the gap (and removing the
directive) is a single-grep operation. If an xfail'd backend
unexpectedly matches numbl, the runner emits a
`STALE-XFAIL <mode>: ...` note so the directive can be removed.

### Adding a script-level test

The walker uses a two-tier rule so flat single-file tests and
multifile workspace tests can coexist without polluting each other:

- `test_scripts/*.m` — each top-level `.m` file is a test entry.
  Drop a new file and it's auto-discovered.
- `test_scripts/<subdir>/main.m` — each subdirectory is a multifile
  test group. `main.m` is the entry; every other `.m` in the
  subdirectory is a workspace sibling (auto-picked up by the CLI's
  `scanSiblings`, which descends recursively into `+pkg/` and
  `@Class/` directories). The walker does NOT treat sibling files
  in a subdir as standalone entries — including files inside `+pkg/`
  subdirs.

Each script should:

- Be self-contained within its tier (a flat-tier test must not need
  siblings; a multifile-tier test gets its sibling files from its
  own subdirectory and nowhere else).
- Use only `disp` for output, so stdout is the comparison surface.
- Exercise one thing crisply. If a script catches three bugs at
  once, split it.

### What "passes" means

```
mtoc2(script) === numbl(script)   // byte-for-byte stdout
```

This is strict. A trailing newline, a `7` vs `7.0`, scientific vs
fixed notation — any of those is a fail. That strictness is the
whole point: we can't drift from numbl's semantics without somebody
noticing.

### Per-script output masking: `% mtoc2-test-mask:`

A few builtins surface values that genuinely differ between runs
(wall-clock time, PIDs, random samples — anything tied to the
system's clock or entropy). Byte-for-byte comparison would fail
even though both runners are behaving correctly. For those, a
script can declare regex masks in a leading comment block:

```matlab
% mtoc2-test-mask: ^Elapsed time is [0-9.]+ seconds\.$
tic;
toc;   % prints "Elapsed time is X.XXXXXX seconds." (masked)
disp(1);
```

The cross-runner scans the script's leading comment block for
`^\s*%\s*mtoc2-test-mask:\s*(.*)$`, compiles each pattern with
the `gm` flags, and applies them to both numbl's and mtoc2's
stdouts (replacing matches with `[MASKED]`) before the byte-for-
byte compare. Directive parsing stops at the first non-comment
line, so the leading comment block can be any length. Anything _not_ matched by a declared regex must
still match exactly. The PASS line reports how many matches fired
on each side; mismatched counts often surface a missed printing
path. Use this sparingly — every mask is one less line under
strict comparison.

A sibling directive `% mtoc2-test-drop: <regex>` removes matched
lines entirely (regex + trailing newline). Use it when only _one_
runner emits a banner-style line — e.g. numbl's
`[matmul] using bridge: native LAPACK addon` is printed on first
matmul activation; mtoc2 doesn't emit anything similar, so masking
would leave a `[MASKED]` placeholder while the other runner has
no line at all and the compare still fails. `drop` collapses both
sides to no-line. Same scan window and `gm` semantics as
`mtoc2-test-mask`.

### When mtoc2 and numbl disagree

If the divergence is mtoc2's bug, fix mtoc2. If the divergence is a
real numbl bug, file it upstream — don't paper it over locally. The
oracle has to stay the oracle.

If a feature isn't in mtoc2's scope yet, the right move is to throw
`UnsupportedConstruct` at lowering time (for c-aot / js-aot) or
from the builtin's `call` hook (for the interpreter), not to
silently produce wrong output. A script that triggers that error
fails the cross-runner on mtoc2's non-zero exit, which is the
correct signal.

## Forcing the runtime path: `%!numbl:opaque`

Mtoc2's exact-value folding is aggressive — a value mentioned as a
literal almost always carries `exact` through the lowerer, and the
runtime codegen never fires for the if-cond fold path. That's a
feature in production but a problem for tests that need to exercise
the runtime path.

The directive `%!numbl:opaque <var> [<var>...]` strips `exact` from
each named variable. Numbl's parser recognizes the directive but
treats unknown directives as no-ops, so the cross-runner's numbl-side
output is unchanged. Mtoc2 then has to emit the runtime code path
for `var`.

```matlab
a = [1 2 3];
%!numbl:opaque a
disp(a);    % mtoc2 emits mtoc2_disp_tensor(a) instead of compile-time fputs
```

For exact tensors, the directive synthesizes a TensorBuild Assign so
the C-side declaration actually materializes. (Without the directive,
exact-tensor assignments are skipped at emit since the value is
purely a type-system fact.)

Use sparingly — production code should NOT rely on this. It's purely
a testing aid.

## Inspecting types: `%!numbl:showtype` and `%!numbl:printtype`

Two debug directives that snapshot a variable's current `Type` and
surface it without affecting semantics. Both fire once per
specialization, so they reflect the lowerer's per-spec view (useful
for sanity-checking exact propagation and dim/sign lattice changes).

- `%!numbl:showtype <var> [<var>...]` emits a
  `/* type <name> (<cName>) :: <type> */` comment in the generated C
  at the directive's source position. Lives in the artifact.
- `%!numbl:printtype <var> [<var>...]` writes the same snapshot to
  stderr at compile time as `<file>:<line>:<col>: type <name> ::
<type>`. Lives in the translator run.

Both raise `UnsupportedConstruct` if any named variable is not in
scope. Both reflect post-`opaque` stripping and loop-body widening
because they read the env at the lowering point. Numbl ignores both
directives, so cross-runner output is unaffected.

## Vitest (unit-level)

Reserved for assertions that aren't ergonomic as `.m` scripts:
type-lattice invariants, spec-key edge cases, and diagnostic error
paths the cross-runner collapses to a single "errored" line.
Cases live under `tests/`. Don't add per-script entries to vitest —
the cross-runner parallelizes better and stays the oracle.

## Pre-merge checklist

Before landing a change, run `npm run check` — it chains every gate
in the order below and exits non-zero on the first failure:

- `npm run format:check` (prettier)
- `npm run lint` (eslint, covers `.ts/.tsx` and runtime `.js`)
- `npm run typecheck` (`tsc`)
- `npm run build:snippets:check` (catches stale `snippets.gen.ts`
  after a `.h` / `.js` edit under `src/builtins/runtime/`)
- `npm run test` (vitest)
- `npm run test:scripts:all-modes` — interpreter / js-aot / c-aot
  all against numbl byte-for-byte. Known backend gaps are marked
  `% mtoc2-test-xfail-<backend>:` per script; the runner is
  expected to exit 0. Failures here mean a backend has rotted away
  from the others. This is also a strict superset of the c-aot-only
  `npm run test:scripts` runner today (no script currently xfails
  c-aot), so the umbrella check doesn't run both.

The cross-runner is the slow gate (~50–60s on a 12-core dev
machine; longer on CI). For tight iteration, use `tsc` + a single
targeted script (`npm run test:scripts:all-modes path/to/foo.m`).

### Periodic: leak-check sweep

Both runners accept `MTOC_TEST_CHECK_LEAKS=1`, which builds the c-aot
path with `--check-leaks` (AddressSanitizer + LeakSanitizer) to
catch missing `mtoc2_tensor_t` frees and other heap bugs in the
always-copy / free-at-scope-exit invariant. Asan slows the cc step
3-5x, so this is **not** part of the regular dev loop — run on a
periodic cadence (once a day, or before a release tag):

```
MTOC_TEST_CHECK_LEAKS=1 npx tsx scripts/run_test_scripts.ts
MTOC_TEST_CHECK_LEAKS=1 npx tsx scripts/run_test_scripts_all_modes.ts
```

## Test corpus organization

`test_scripts/` is organized as topic files (one `.m` per topic, with
a thin top-level block that calls local `test_*` functions — see
`indexing.m`, `tensors.m`, etc.). `mvp.m` is the smoke floor —
scalar arithmetic, conditions, loops, and user-function
specialization. If it fails, mtoc2 is broken.

New regression cases join the existing topic file (an indexing
regression goes into `indexing.m`, a tensor-arithmetic regression
into `tensors.m`, etc.). Start a fresh file only when the topic
is genuinely new or the script needs its own
`% mtoc2-test-mask:` / `% mtoc2-test-drop:` directive that would
contaminate unrelated scripts. Per-script overhead is substantial
(numbl spawn + mtoc2 spawn + `cc` + run), so keeping the count low
matters.

Complex tests follow the same rule: a complex regression on
indexing goes into `indexing.m`, a complex reduction into
`reducers.m`, a complex unary-math case into `math_builtins.m`,
etc. The one new topic file is `complex_basics.m`, which collects
patterns that don't fit any existing topic.

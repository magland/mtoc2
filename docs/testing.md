# Testing

Two layers, deliberately separated.

## Cross-runner (the oracle)

`scripts/run_test_scripts.ts` walks every `.m` file under
`test_scripts/`, runs each through numbl's CLI and mtoc2's CLI, and
compares stdouts byte-for-byte. A test fails if the two runners
disagree on a single character.

```
npx tsx scripts/run_test_scripts.ts                # all scripts
npx tsx scripts/run_test_scripts.ts a.m b.m        # specific files
MTOC_TEST_CONCURRENCY=4 npx tsx scripts/run_test_scripts.ts
MTOC_TEST_TIMEOUT_MS=60000 npx tsx scripts/run_test_scripts.ts
```

The cross-runner needs numbl checked out at `../numbl` — same sibling
location mtoc2 imports its parser from.

### Adding a script-level test

Drop a new `.m` file under `test_scripts/<category>/`. The walker
auto-discovers. There's no need to wire it into vitest or anywhere
else; the file's existence is the test.

Each script should:

- Be self-contained (no `require`/`import`-style behavior).
- Use only `disp` for output, so stdout is the comparison surface.
- Exercise one thing crisply. If a script catches three bugs at once,
  split it.

### What "passes" means

```
mtoc2(script) === numbl(script)   // byte-for-byte stdout
```

This is strict. A trailing newline, a `7` vs `7.0`, scientific vs
fixed notation — any of those is a fail. That strictness is the
whole point: we can't drift from numbl's semantics without somebody
noticing.

### When mtoc2 and numbl disagree

If the divergence is mtoc2's bug, fix mtoc2. If the divergence is a
real numbl bug, file it upstream — don't paper it over locally. The
oracle has to stay the oracle.

If a feature isn't in mtoc2's scope yet, the right move is to throw
`UnsupportedConstruct` at lowering time, not to silently produce
wrong C. A script that triggers that error will fail the cross-runner
on numbl's exit code (since mtoc2 exits non-zero), which is the
correct signal.

## Vitest (unit-level)

Reserved for assertions that aren't ergonomic to express as `.m`
scripts: emitted-C shape checks, type-lattice invariants, error-
attribution coverage, edge cases in the canonicalize/hash pair.

Not in use yet. When the first vitest case is worth writing, drop it
in `tests/<area>.test.ts` and add a one-liner here describing the
layout. Don't add per-script entries to vitest — the cross-runner
parallelizes much better and stays the oracle.

## Pre-merge checklist

Before landing a change:

- `npx tsc` clean.
- `npx tsx scripts/run_test_scripts.ts` full pass.
- `npx vitest run` (when there are vitest cases).
- `npm run lint`.
- `npm run format:check`.
- `npm run build:snippets:check` if you touched `src/codegen/runtime/*.h`
  (otherwise it'll drift).

The cross-runner is the slow gate — minutes to run a full sweep. Run
it at checkpoints. For tight iteration, just use `tsc` + a targeted
script (`run_test_scripts.ts path/to/foo.m`).

## Test corpus organization

`test_scripts/mvp/` holds the smoke set — ~12 short scripts covering
scalar arithmetic, conditions, loops, and user-function specialization.
These are the floor: if any of them fails, mtoc2 is broken.

Future categories will mirror feature growth (strings, complex,
arrays, structs, etc.). Keep each category small and focused — a few
scripts per topic is plenty.

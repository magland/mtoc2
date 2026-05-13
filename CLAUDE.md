# CLAUDE.md

Project instructions for agents working in mtoc2.

## What this project is

mtoc2 is a static numbl-to-C translator. It accepts a strict subset of what
numbl can run and emits a single C file you can compile with `cc`. The
defining feature is **exact-value tracking in the type system**: when the
lowerer can prove a value, it folds the computation at compile time and emits
a literal instead of a runtime call. The compiler embeds interpreter
capability — that's not an afterthought, it's the design center.

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
`UnsupportedConstruct` with a source span. Today's MVP scope is **scalar
real `double` only** — plus arithmetic, comparisons, `disp`, `if`/`while`/
`for`, and user functions with type-tuple specialization. Strings, chars,
complex, arrays, structs, classes, and most builtins are **not** yet
supported. Expanding that scope is gated by the cross-runner.

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

## Architectural rules

- **Exact-value-first**. Every scalar in the type system has an optional
  `exact` field. When all inputs to an op/builtin have `exact`, the
  builtin's `transfer` runs the computation and returns an exact-tagged
  output; the lowerer emits a literal. Builtins that can't evaluate
  exactly leave `exact` unset and codegen emits the runtime call.
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

- Multi-file workspace resolution.
- Old optimization toggles (`enableTempInlining`, `threads`, etc.).
- Native execution server. mtoc2 runs WASM-only in the browser; the CLI
  shells out to `cc` directly.
- Vendoring of the numbl parser via a sync script. mtoc2 imports
  directly.

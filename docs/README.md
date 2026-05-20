# mtoc2 developer docs

These docs are written **for developers (and coding agents) who need
to understand how mtoc2 works** — the pipeline, the type system, the
three execution backends, and how to extend each one. They are not
a user manual for the numbl dialect (numbl owns that) and not an API
reference for every builtin or runtime helper (the source is the
reference).

The codebase is in early flux. Docs avoid line numbers and talk in
terms of _concepts and roles_ so they stay accurate as files move
around. They cover what's load-bearing: things you'd otherwise have
to reverse-engineer from the source, divergences from numbl that
would confuse a reader of cross-runner output, and architectural
rules that constrain future changes. They deliberately omit
exhaustive enumerations — if a fact lives one `grep` away in
well-named code, it doesn't need a doc entry. See the "Keep the
docs lean" section in [CLAUDE.md](../CLAUDE.md) for the inclusion
criteria.

## What mtoc2 is

mtoc2 is a numbl-dialect compiler with **three execution backends**
sharing one parser, one type system, and one builtin registry:

- **`--exec interpreter`** — walks the AST through each builtin's
  `call` hook. Always available; no codegen, no compile.
- **`--exec js-aot`** — lowers to IR, emits JavaScript through each
  builtin's `emitJs` hook, runs via `new Function`. No remote
  service.
- **`--exec c-aot`** (default) — lowers to IR, emits C through each
  builtin's `emitC` hook, compiles via `cc`, executes the binary.

All three produce bit-identical stdout for any program they support.
The c-aot path is the most complete today; the interpreter and
js-aot have known gaps tracked by the all-modes runner.

## Where to start

- [architecture.md](architecture.md) — the pipeline (parse → lower →
  emit) and the three-backend split. What each stage owns, what the
  IR looks like, how the builtin contract unifies the backends.
- [type_system.md](type_system.md) — `Type`, `NumericType`, the
  exact-value lattice, how inference flows through control flow and
  function specialization. The most distinctive subsystem; read it
  second.
- [testing.md](testing.md) — the cross-runner harness, the all-modes
  runner, where new tests go.

The web IDE ([src/App.tsx](../src/App.tsx),
[src/pages/](../src/pages/), [src/components/](../src/components/))
is a React + Monaco UI that runs the translator in the browser. It
exposes the same three backends as the CLI: interpreter and js-aot
run entirely in-browser via Web Workers; WASM ships the emitted C to
a remote emcc service. Project state lives in IndexedDB
([src/db/](../src/db/)) and projects can be shared via a
pako-deflated URL hash
([src/utils/shareUrl.ts](../src/utils/shareUrl.ts)).

Resist the urge to add docs for features that don't exist yet.

## Project conventions

- The source dialect is **numbl**, not MATLAB. mtoc2's parser is the
  same code numbl uses (imported directly via sibling-relative
  path), and the cross-runner uses numbl's CLI as its oracle. When
  you reference behavior or compatibility, talk about numbl.
- Every IR node carries a source `Span`. Errors should always
  include it, so user-facing messages can point to a line.
- Every refactor must keep the cross-runner at full pass and `tsc`
  clean before landing. Changes that touch the interpreter or
  js-aot backends should also run the all-modes runner.
- Generated stdout is treated as observable. The cross-runner
  enforces byte-for-byte stdout parity with numbl for every script
  in `test_scripts/`.

## Skim order if you're new

1. `architecture.md` — get the shape of the pipeline.
2. `type_system.md` — understand exact-value propagation; it's the
   axis everything else is organized around.
3. `testing.md` — where your test goes.

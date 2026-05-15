# mtoc2 developer docs

These docs are written **for developers (and coding agents) who need
to understand how mtoc2 works** — the pipeline, the type system, the
owned-value contract, where each subsystem lives, and how to extend
it. They are not a user manual for the numbl dialect (numbl owns
that) and not an API reference for every builtin or runtime helper
(the source is the reference).

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

## Where to start

- [architecture.md](architecture.md) — the pipeline (parse → lower → emit),
  what each stage owns, what the IR looks like.
- [type_system.md](type_system.md) — `Type`, `NumericType`, the exact-value
  lattice, how inference flows through control flow and function
  specialization. This is the most distinctive subsystem; read it second.
- [testing.md](testing.md) — the cross-runner harness, where new tests go.

The web IDE (`src/App.tsx`, `src/pages/`, `src/components/`) is a
React + Monaco UI that runs the translator in the browser and ships
the emitted C to a remote wasm-compile service for in-Worker
execution; project state lives in IndexedDB (`src/db/`) and projects
can be shared via a pako-deflated URL hash (`src/utils/shareUrl.ts`).
It mirrors the CLI's translator output exactly — no dedicated page
yet; read the components if you need to touch it.

Resist the urge to add docs for features that don't exist yet.

## Project conventions

- The source dialect is **numbl**, not MATLAB. mtoc2's parser is the
  same code numbl uses (imported directly via sibling-relative path),
  and the cross-runner uses numbl's CLI as its oracle. When you
  reference behavior or compatibility, talk about numbl.
- Every IR node carries a source `Span`. Errors should always include
  it, so user-facing messages can point to a line.
- Every refactor must keep the cross-runner at full pass and `tsc`
  clean before landing.
- Generated C output is treated as observable. The cross-runner
  enforces byte-for-byte stdout parity with numbl for every script in
  `test_scripts/`.

## Skim order if you're new

1. `architecture.md` — get the shape of the pipeline.
2. `type_system.md` — understand exact-value propagation; it's the
   axis everything else is organized around.
3. `testing.md` — where your test goes.

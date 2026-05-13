# mtoc2 developer docs

Orientation material for people (and agents) extending mtoc2. The codebase
is in early flux — these docs deliberately avoid line numbers and talk in
terms of _concepts and roles_ so they stay accurate as files move around.

## Where to start

- [architecture.md](architecture.md) — the pipeline (parse → lower → emit),
  what each stage owns, what the IR looks like.
- [type_system.md](type_system.md) — `Type`, `NumericType`, the exact-value
  lattice, how inference flows through control flow and function
  specialization. This is the most distinctive subsystem; read it second.
- [testing.md](testing.md) — the cross-runner harness, where new tests go.

More pages will come online as the corresponding subsystems mature
(builtins, runtime helpers, codegen, web IDE). The MVP scope is small
enough that today's three pages cover the surface; resist the urge to
add docs for features that don't exist yet.

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

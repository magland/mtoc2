# Architecture

mtoc2 is a four-stage pipeline:

```
numbl source (.m)
       │
       ▼
   parse  ─────────── via numbl's parser (sibling import, no vendoring)
       │              produces numbl's AST shape
       ▼
   lower  ─────────── src/lowering/
       │              walks the AST, threads a typed env, propagates
       │              exact values, allocates function specializations,
       │              produces mtoc2 IR
       ▼
   emit   ─────────── src/codegen/
       │              walks the IR, activates runtime snippets, produces
       │              a single C source string
       ▼
   compile + run ─── src/cli.ts shells out to `cc` and execs
                     (or: WASM-in-browser via emcc + Web Worker)
```

## Stage 1: parse

`src/parser/index.ts` re-exports `parseMFile` and the AST types from
numbl's parser. We don't vendor any parser code; the import is a
sibling-relative path. AST drift is caught at `tsc` time.

`src/parser/sourceLoc.ts` is the one parser-adjacent file we own —
small offset-to-{line,column} helper.

The AST returned from `parseMFile(source, fileName)` is just
`{ body: Stmt[] }`. Every node carries a `Span` (file + start + end).

## Stage 2: lower

Everything under `src/lowering/`. The lowerer is a one-pass walker
that takes the AST and produces typed IR.

### Type system (`types.ts`)

The Type lattice is written from scratch for mtoc2 — see
[type_system.md](type_system.md) for the full story. The short version:

- `NumericType { elem, isComplex, dims, sign, exact? }` covers scalars
  (and eventually arrays, capped by `EXACT_ARRAY_MAX_ELEMENTS`).
- `StringType { exact? }`.
- `UnknownType` for joins that can't be reconciled and for `void` returns.
- `canonicalizeType` + FNV-1a hash drive function specialization keys.
  Crucially, the canonical form **includes `exact`**, so each distinct
  exact-value input produces its own specialization.

### IR (`ir.ts`)

A small typed tree: `NumLit`, `Var`, `Binary`, `Unary`, `Call` for
expressions; `ExprStmt`, `Assign`, `If`, `While`, `For`,
`ReturnFromFunction`, `Break`, `Continue` for statements. `IRFunc`
captures a single specialization (params + types + body + output
type). `IRProgram` is top-level statements + a map of specializations.

### Builtins (`builtins.ts`)

Each builtin is a fused (transfer + codegenC) pair:

- **transfer**: given input types, return the output type. When all
  inputs have `exact` set, the transfer runs the computation in JS and
  returns a type with `exact` populated.
- **codegenC**: given the args' rendered C expressions, return the C
  expression that evaluates this builtin at runtime. Not invoked when
  the transfer returned an exact-tagged scalar (the lowerer
  short-circuits to a `NumLit`).
- **runtimeDeps**: optional list of snippet names this builtin's C
  output calls into. The emitter activates them on each codegen site.

Today's MVP builtins: `plus`, `minus`, `times`, `rdivide`, `uminus`,
`eq`, `ne`, `lt`, `le`, `gt`, `ge`, `disp`. Operator-to-builtin maps
live alongside the registry.

### Lowerer (`lower.ts`)

The `Lowerer` class owns three pieces of mutable state:

- `env: Map<name, { cName, ty }>` — current scope's variable bindings.
- `functionDefs: Map<name, FuncStmt>` — pre-scanned from top-level.
- `specializations: Map<specKey, IRFunc>` — cached completed specs.

Three rules drive exact propagation:

1. **Ident read substitution**. When we look up a variable whose type
   has scalar `exact` set, we return a `NumLit` instead of a `Var` —
   the lowerer effectively inlines the literal at every read.

2. **Loop-body exact stripping**. Before lowering a `while`/`for` body,
   we collect names assigned in the body and strip `exact` from those
   env entries. Without this, the one-pass walk would bake iteration-1
   values into the body. Implementation in `stripExactFromEnv` +
   `collectAssignedNames`.

3. **Terminator stop in `lowerStmts`**. After we emit a
   `ReturnFromFunction`/`Break`/`Continue`, we stop processing siblings
   in the same block. Otherwise dead code after an early-return would
   pollute the function's return type.

If-folding: when the if-condition lowers to a literal, only the taken
arm is lowered. The other arms aren't visited (no side effects on env,
no spurious function specializations).

### Function specialization

A user function call `sq(5)` triggers `specializeUserFunction(decl, argTypes)`:

1. Compute the spec key (`<funcName>__<8-hex of canonicalized arg types>`).
2. If cached, return the cached `IRFunc`.
3. Otherwise: snapshot outer env, install a fresh env with params bound
   to their arg types, recursively lower the function body, capture the
   output types from the final env, restore outer env.

Recursion isn't supported yet — the placeholder pattern at the top of
`specializeUserFunction` lets us produce a clean error if it happens.

## Stage 3: emit

`src/codegen/emit.ts` walks the IR and produces a single C string.

Headers + runtime helpers live in `src/codegen/runtime.ts` (the
registry/activator) backed by `.h` files under `src/codegen/runtime/`.
Each builtin's `runtimeDeps` activate snippets on every codegen site;
the emitter:

- collects all activated snippets transitively (via `useRuntimeByName`),
- dedupes headers across `BASE_HEADERS` ∪ activated snippets,
- splices the snippet bodies (or a `/* runtime helpers omitted */`
  placeholder if `includeRuntime: false`) between the headers and the
  user-level code.

The `includeRuntime` option is what the IDE's "runtime helpers" toggle
controls. Off-mode is a viewing aid, not compilable C.

Snippet sources are inlined into `snippets.gen.ts` at build time by
`scripts/build_runtime_snippets.ts` (run via `npm run build:snippets`).
This lets the translator bundle in the browser without filesystem
access at runtime.

## Stage 4: compile + run

The CLI (`src/cli.ts`) writes the emitted C to a temp file,
invokes `cc -lm`, and execs the resulting binary, forwarding stdout.
The cross-runner uses this path.

The browser IDE uses a separate WASM path (`src/utils/wasmExecution.ts`)
that compiles via emcc and runs in a Web Worker. Same translator
output, different runner.

## Why one pass, not fixpoint

mtoc2's lowerer is one-pass. We don't iterate to a fixpoint when
merging types across loop back-edges. The trade-off is that loops
can't carry exact values across iterations (which we wouldn't usually
want anyway — most loop-mutated state should be runtime-only). Code
that needs precise types in the loop body either picks them up from
the entry env or accepts widening. See the exact-stripping rule in the
Lowerer section.

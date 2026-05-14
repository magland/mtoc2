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

- `NumericType { elem, isComplex, dims, shape?, sign, exact? }` covers
  scalars and exact tensors. `shape` is set when the integer shape is
  known statically (always for exact tensors); `exact` is `number` for
  scalar real, or `Float64Array` for tensors (column-major, capped by
  `EXACT_ARRAY_MAX_ELEMENTS`).
- `StringType { exact? }`.
- `UnknownType` for joins that can't be reconciled and for `void` returns.
- `canonicalizeType` + FNV-1a hash drive function specialization keys.
  Crucially, the canonical form **includes `exact`**, so each distinct
  exact-value input produces its own specialization.

### IR (`ir.ts`)

A small typed tree: `NumLit`, `TensorBuild`, `Var`, `Binary`, `Unary`,
`Call` for expressions; `ExprStmt`, `Assign`, `If`, `While`, `For`,
`ReturnFromFunction`, `Break`, `Continue` for statements. `IRFunc`
captures a single specialization (params, types, body, output type).
`IRProgram` is top-level statements plus a map of specializations.

**`TensorBuild`** is the only tensor-construction IR node: every
source-level tensor literal lowers through it (the all-literal case
just has `NumLit` cells, the mixed case has `Var` / `Binary` / …).
Shape is statically known. Codegen emits `mtoc2_tensor_from_row`
(1×N) or `mtoc2_tensor_from_matrix` (R×C) with a C99 compound-literal
`(double[]){...}` of the per-element expressions. Special case at
lowering: a 1×1 tensor literal `[x]` returns the inner scalar IR
directly — MATLAB treats `[x]` and `x` as the same scalar.

Every `Assign` emits C. For owned types via
`mtoc2_tensor_assign(&v, rhs)`, for scalars via `<cType> v = rhs;`
(declare) or `v = rhs;` (reassign). Every tensor RHS materializes
freshly — `TensorBuild` via `from_row`/`from_matrix`, `Var` via
`mtoc2_tensor_copy`, computed tensor RHSs via their per-op runtime
helper. The type system still tracks `exact` (so specialization keys
distinguish `f(2)` from `f(3)`), but the lowerer doesn't fold it into
the IR — see the "Folding only at if-cond" section below.

### Builtins (`builtins.ts`)

Each builtin is a fused (transfer + codegenC) pair:

- **transfer**: given input types, return the output type. When all
  inputs have `exact` set, the transfer runs the computation in JS and
  returns a type with `exact` populated. This is what makes the
  function-specialization key distinguish `f(2)` from `f(3)`, and what
  feeds the if-cond fold.
- **codegenC**: given the args' rendered C expressions, return the C
  expression that evaluates this builtin at runtime. Always called for
  every builtin Binary/Unary/Call IR node — the lowerer no longer
  substitutes a literal even when `transfer` produced an exact-tagged
  result.
- **runtimeDeps**: optional list of snippet names this builtin's C
  output calls into. The emitter activates them on each codegen site.

Today's builtins:

- **Elementwise arithmetic** — `plus`, `minus`, `times` (`.*`),
  `rdivide` (`./`), `uminus`. Each handles all four shape combos:
  - scalar OP scalar → inline `(a cOp b)` in C
  - tensor OP scalar / scalar OP tensor → `mtoc2_tensor_<op>_ts` (or
    `_st` for non-commutative ops)
  - tensor OP tensor (same statically-known shape) →
    `mtoc2_tensor_<op>_tt`

  General broadcast for mismatched non-scalar shapes is not yet
  supported.

- **Matrix `*` / `/`** — `mtimes`, `mrdivide`. Fall through to the
  elementwise siblings when at least one arg is scalar; throw
  `UnsupportedConstruct` for the both-tensor case (matrix
  multiplication and right-division are not yet implemented).
- **Comparisons** (return scalar logical): `eq`, `ne`, `lt`, `le`,
  `gt`, `ge`. Inline `((a cOp b) ? 1.0 : 0.0)` in C.
- **I/O**: `disp` — two paths picked by argument shape:
  scalar real → `mtoc2_disp_double(x)`; multi-element tensor →
  `mtoc2_disp_tensor(t)`.
- **Introspection / reduction**: `length`, `numel` — runtime
  `mtoc2_length` / `mtoc2_numel` on tensors; literal `1.0` for scalar
  args (the C arg type is `double`, not `mtoc2_tensor_t`). `sum` →
  `mtoc2_sum(t)` for tensors, identity for scalars. Matrix →
  row-vector reduction deferred.

Operator-to-builtin maps live alongside the registry.

## Owned-value codegen

Scalars stay in C automatic storage as `double`. Multi-element
tensors compile to `mtoc2_tensor_t` (a struct of two heap pointers
plus an inline shape array). Memory model is mtoc's: always-copy on
manipulation, free at scope exit. No refcount, no COW.

Concretely the emit pass:

1. Walks the function body to collect names of owned locals — any
   variable that has at least one Assign with `materialize=true &&
isOwned(ty)`. `If`/`While`/`For` bodies are walked too, so inner
   declarations surface to the function-level free list.
2. Emits a pre-declaration `mtoc2_tensor_t v = mtoc2_tensor_empty();`
   at function top for each owned local. The empty tensor has NULL
   buffers; the first `mtoc2_tensor_assign` does a no-op free of NULL
   and installs the value.
3. For each owned Assign, emits
   `mtoc2_tensor_assign(&v, <rhs-expr>);`. The RHS must be a freshly-
   owned tensor — TensorBuild produces one via the alloc helper;
   `Var(otherVar)` wraps in `mtoc2_tensor_copy(otherVar)`. Other
   tensor-producing expressions follow the same invariant.
4. Walks the body and emits early-frees: after each stmt, every
   owned name in `(uses ∪ defs)(s) − futureTouchOut(s)` gets a
   `mtoc2_tensor_free(&v)`. The future-touch sets come from a
   backward dataflow in `src/codegen/liveness.ts` (port of mtoc's
   liveness analyzer, adapted for mtoc2's simpler IR). Reassignment
   counts as a future touch, so reassigns suppress redundant early-
   frees (the assign helper handles the prior buffer).
5. At end-of-body / before each `mtoc2_return:` label, emits
   `mtoc2_tensor_free(&v)` for every owned local **that
   `nullAtScopeExit` can't prove is already NULL**. The
   `nullAtScopeExit` forward dataflow walks the body computing per-
   variable "guaranteed NULL" sets: Assign clears, early-free sets,
   If intersects across arms, loops intersect (entry, body-end).
   The scope-exit free walk skips proven-NULL names — so simple
   straight-line code emits exactly one free per variable, at its
   last touch.

### A-normalization (ANF) pass

Every owned-producing non-Var sub-expression is hoisted to a fresh
`_mtoc2_t<N>` temp Assign at lowering time. After ANF, owned-
producing expressions appear only as direct Assign RHSs at owned
consume sites — every other position holds a Var read. This single
rule keeps the codegen consume-site logic uniform and ties each
freshly-allocated tensor's lifetime to a named local the scope-exit
free walk releases.

Owned-producing in mtoc2 is: `TensorBuild`, or any
`Binary`/`Unary`/`Call` whose result is a multi-element tensor.

Example: `disp(a + b + c)` (all tensors) lowers to

```
_mtoc2_t1 = a + b;        // mtoc2_tensor_assign(&_mtoc2_t1, mtoc2_tensor_plus_tt(a, b))
_mtoc2_t2 = _mtoc2_t1 + c;
disp(_mtoc2_t2);
```

with `_mtoc2_t1` and `_mtoc2_t2` both pre-declared at function top
and freed at scope exit. No leaks, no aliasing.

The implementation is in `Lowerer.anfChildren` /
`Lowerer.anfRequireScalarOrVar` and runs at `lowerExprStmt` and
`lowerAssign` time. (mtoc's `anf.ts` is the model — mtoc2 differs in
that elementwise ops _are_ owned producers here, because we emit
per-op runtime helpers that allocate fresh; mtoc fuses them into the
parent's iter loop instead.)

### Lowerer (`lower.ts`)

The `Lowerer` class owns three pieces of mutable state:

- `env: Map<name, { cName, ty }>` — current scope's variable bindings.
- `functionDefs: Map<name, FuncStmt>` — pre-scanned from top-level.
- `specializations: Map<specKey, IRFunc>` — cached completed specs.

Two rules drive exact propagation:

1. **Loop-body exact stripping**. Before lowering a `while`/`for` body,
   we collect names assigned in the body and strip `exact` from those
   env entries. Without this, the one-pass walk would bake iteration-1
   values into the body. Implementation in `stripExactFromEnv` +
   `collectAssignedNames`.

2. **Terminator stop in `lowerStmts`**. After we emit a
   `ReturnFromFunction`/`Break`/`Continue`, we stop processing siblings
   in the same block. Otherwise dead code after an early-return would
   pollute the function's return type.

If-folding: when the if-condition's type has a known finite `number`
`exact`, only the taken arm is lowered. The other arms aren't visited
(no side effects on env, no spurious function specializations). This
is the **only** place the lowerer substitutes a known value for a
runtime computation — Ident reads, arithmetic, and builtin calls all
emit runtime IR regardless of whether `exact` is set. See
[type_system.md](type_system.md) for the rationale.

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

Every emitted function carries a block-comment header
(`src/codegen/prettyIR.ts:irFuncDocComment`) with the source name, the
mangled C identifier, and the per-parameter and per-output types
(rendered by `typeToString` — so signs, exact values, and shapes show
through). Every emitted statement carries a one-line comment header
above it (`irStmtHeader` → `irExprToString`) — a numbl-like reconstruction
of the lowered expression. These comments reflect the IR _after_
lowering: synthetic ANF temps (`_mtoc2_t<N>`) and folded branches are
visible. They're a debugging aid for the translator, not a transcription
of the user's source.

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

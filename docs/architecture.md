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
- `HandleType { targetName, ast, captures }` for function handles.
- `StructType { fields }` for `struct(...)`-produced values; field
  list is canonical (sorted by name). Owned.
- `ClassType { className, properties }` for class instances; property
  list is canonical. Properties with an explicit default get their
  type at registration; properties without a default get their type
  inferred at first constructor specialization from the first
  top-level `obj.<prop> = <rhs>` write in the constructor body (the
  RHS is lowered in a temp env binding constructor params to the
  call's `argTypes`). The C typedef hash uses `cFieldTypeStr`, so
  precision differences (sign / exact / tensor shape) don't shard
  the typedef. Owned.
- `canonicalizeType` + FNV-1a hash drive function specialization keys.
  Crucially, the canonical form **includes `exact`**, so each distinct
  exact-value input produces its own specialization.

### IR (`ir.ts`)

A small typed tree: `NumLit`, `TensorBuild`, `Var`, `Binary`, `Unary`,
`Call`, `HandleLit`, `HandleCaptureLoad`, `StructLit`, `MemberLoad`,
`IndexLoad`, `IndexSlice`, `EndRef`, `MakeRange` for expressions;
`ExprStmt`, `Assign`, `If`, `While`, `For`, `ReturnFromFunction`,
`Break`, `Continue`, `TypeComment`, `MemberStore`, `IndexStore`,
`IndexSliceStore` for statements. `IRFunc` captures a single
specialization (params, types, body, output type). `IRProgram` is
top-level statements plus a map of specializations.

**Indexing and slicing** lower through four helpers in
`src/lowering/`:

- `lowerIndexLoad` — scalar reads (`v(i)`, `M(i, j)`, `T(i, j, k)`).
- `lowerIndexStore` — scalar writes (`v(i) = x`, `M(i, j) = x`).
- `lowerIndexSlice` — range / colon / scalar-mix reads
  (`v(:)`, `v(a:b)`, `M(:, j)`, `T(:, :, k)`).
- `lowerIndexSliceStore` — range / colon / scalar-mix writes
  (`v(:) = w`, `M(:, j) = scalar`, `T(:, :, k) = page`).

Dispatch is in `lowerFuncCall` / `lowerAssignLValue`: an `Ident`-rooted
`v(args)` whose name resolves to an in-scope multi-element numeric
variable routes to the slice helper when `args.some(isSliceArg)` is
true (Range or Colon slot), otherwise to the scalar load. Similarly
for AssignLValue with an Index lvalue. The shared predicate is
`isSliceArg` in `src/lowering/indexResolve.ts`. `resolveIndexBase`
(same file) factors the env lookup + numeric/multi-element/arity
check used by all four. The `end` keyword inside an index slot
resolves through the Lowerer's `endStack` to the appropriate axis
size (statically when the base shape is known, runtime via
`base.dims[k]` otherwise).

**Range-as-value** (`v = 1:n`, `(1:5) * 2`) lowers to a `MakeRange`
IR node and emits via the `mtoc2_tensor_make_range` runtime helper
(allocated 1×N row tensor). Index-slot ranges (different IR shape —
`IndexSliceArg.Range`) require a NumLit `step` so codegen can derive
the loop count at compile time; the value-form `MakeRange` accepts
any scalar real `step` and routes through `mtoc2_loop_count` at
runtime.

The count formula matches numbl byte-for-byte:
`floor((end - start) / step + 1 + 1e-10)`. The `+ 1e-10` cushion
absorbs float-imprecision cases like `(0.3 - 0) / 0.1 = 2.999...`,
which the naive `floor(...) + 1` would round down to 3 instead of 4
(numbl produces 4). Generated values pass through `mtoc2_range_value`
which snaps the last element exactly to `end` when its computed value
is within `|step| * 1e-10` — without the snap, `0.1:0.1:0.3` produces
a last element of `0.30000000000000004` and `v(end) == 0.3` is false.

**For-loop emission** snapshots `start`, `end`, and the iteration
count once at loop entry (block-scoped `_mtoc2_for_start`,
`_mtoc2_for_end`, `_mtoc2_for_n` locals) and iterates by integer
count, computing the loop variable per iteration via
`mtoc2_range_value`. This matches MATLAB / numbl-interpreter
semantics — a body that mutates `n` does NOT extend a `for k = 1:n`
loop, and a side-effecting `f()` in the bound is called once. The
snap also applies on the final iteration so `for k = 0:0.1:1` ends
with `k == 1.0` exactly, not 0.9999...

**Bounds checks** wrap every scalar IndexLoad / IndexStore axis
index in a `mtoc2_idx_axis` (per-axis) or `mtoc2_idx_lin` (1-arg
linear) call that aborts on out-of-range with a numbl-style "Index
exceeds array bounds" message and `exit(1)`. Slice-slot setup
calls `mtoc2_check_axis_range` (multi-slot) or
`mtoc2_check_linear_range` (single-slot) once per slot to validate
the `[first, last]` interval against the relevant dim/numel. The
empty-range case (`v(5:4)`) skips the check, matching MATLAB. The
runtime helper file is `runtime/oob.h` (`mtoc2_oob_abort` plus
the four check entry points). Cross-runner can't compare stdouts
when both runners error, so OOB regression coverage lives in
`tests/oob.test.ts` (vitest).

**Structs and class instances** lower through three IR nodes:

- `StructLit { fields, ty }` — produced by `struct('f', v, ...)` and
  by the synthesized initial receiver of a class constructor call.
- `MemberLoad { base, field, ty }` — one node per field access; a
  chain like `s.inner.f` nests them. Owned-typed reads in an
  owned-consuming context wrap in the field's `_copy` helper at
  codegen.
- `MemberStore { base, fieldPath, leafTy, rhs }` — one statement per
  `s.f1.f2 = rhs`. Codegen emits a plain assignment for scalar leaves
  and the leaf's `_assign` helper for owned leaves.

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

### Builtins (`builtins/`)

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
- **I/O**: `disp` — three paths picked by argument type:
  scalar real → `mtoc2_disp_double(x)`; multi-element tensor →
  `mtoc2_disp_tensor(t)`; struct → the program-emitted
  `<struct-typedef>_disp(s)` helper (one per canonical shape).
  Class instance `disp` is not supported in v1.
- **Introspection / reduction**: `length`, `numel` — runtime
  `mtoc2_length` / `mtoc2_numel` on tensors; literal `1.0` for scalar
  args (the C arg type is `double`, not `mtoc2_tensor_t`). `sum` →
  `mtoc2_sum(t)` for tensors, identity for scalars. Matrix →
  row-vector reduction deferred; `sum` on rank-N (N>2) tensors is
  rejected at lowering.
- **Rank-N constructors**: `zeros(d1, …, dN)` and `ones(d1, …, dN)`
  (1..`MTOC2_MAX_NDIM` shape args, each a statically-known finite
  non-negative integer). One-arg form means an n×n square (MATLAB
  convention). The result type carries the shape and, when the
  element count fits the exact-array cap, the fill data — but
  codegen always materializes via the runtime helpers
  `mtoc2_tensor_zeros_nd` / `mtoc2_tensor_ones_nd` rather than
  introducing an ND tensor-literal emission path. ND values flow
  through the rest of the pipeline (assign / copy / free / elemwise
  / `disp`) unchanged.
- **Wall-clock stopwatch**: `tic`, `toc` — both 0-arg; runtime
  `mtoc2_tic()` / `mtoc2_toc()` (snippet `mtoc2_tic_toc`, backed by
  POSIX `clock_gettime(CLOCK_MONOTONIC)`). The bare-`toc;` ExprStmt
  form is special-cased in the lowerer (see `lowerExprStmt`) to emit
  `mtoc2_toc_print()` — printing `Elapsed time is %.6f seconds.\n`
  the same way numbl's `nargout === 0` branch does — while the
  value-returning forms (`t = toc`, `toc + 0`, etc.) route through
  the standard builtin `codegenC`. The cross-runner's per-script
  `% mtoc2-test-mask: <regex>` mechanism (see `docs/testing.md`)
  normalizes the elapsed-seconds field so the byte-for-byte compare
  still holds. The tic-handle form `toc(t0)` is rejected with a
  span. Identifier reads of zero-arity builtins like `tic`/`toc`
  are recognized in `lowerIdent` so source forms `tic;`, `t = tic`,
  `t = toc`, and `toc;` all reach the right path.

Operator-to-builtin maps live alongside the registry.

### Function handles

`@user_func` (named) and `@(p1, ..., pN) <body>` (anonymous) lower to a
`HandleLit` IR node carrying a `HandleType`. The type carries the
target's AST (a synthesized `FunctionStmt` for anonymous forms) plus a
list of captured variables. Captures may be scalar real numeric,
tensor, struct, class instance, or another handle. Handles are owned
on the C side — every per-shape typedef ships with the same
`_empty / _copy / _assign / _free` family that structs and class
instances use, so owned-typed captures (tensors and nested
struct/class/handle values) participate transparently in the standard
scope-exit / early-free lifecycle. Captures are deep-copied into the
handle struct at the `@(...)` site, matching MATLAB's by-value capture
semantics: a later rebinding of the captured name in the enclosing
scope leaves the handle's snapshot untouched.

Dispatch is static. At every `h(args)` call site the lowerer reads the
handle variable's type, builds `[...userArgs, ...HandleCaptureLoad(h)]`
in the underlying spec's param order, and routes through the regular
`specializeUserFunction` cache. Two `apply(@foo, x)` and
`apply(@bar, x)` calls produce two distinct `apply__<hex>` specs
because the canonical form of `HandleType` shards on the target name.

Codegen emits one C struct typedef per distinct capture-shape — keyed
by `(captureName, cFieldTypeStr(captureType))` per capture, the same
hashing strategy structs and classes use, so two handle types that
differ only in lattice precision share a typedef. The no-capture form
shares `mtoc2_handle_empty_t`. Each shape's typedef and its four
owned-helpers are program-emitted by the same `emitNamedTypedef`
machinery as structs and classes; topological sort over the combined
set (structs, classes, handles) keeps dependency order across the
three kinds (e.g. a handle that captures a struct sees the struct's
typedef first). A handle literal renders as a C99 compound literal
with each owned-typed capture wrapped in its inner-type `_copy`; a
`HandleCaptureLoad` renders as `<base>.cap_<name>` and is wrapped in
`_copy` when consumed at an owned site.

Rejected at lowering with a span-carrying error:

- `@builtin_name` — builtin handles aren't supported; call the
  builtin directly.
- String / Void / Unknown captures — types without a C-level field
  representation in mtoc2.
- `~` as an anonymous-function parameter.
- A bare-Ident reference whose name shadows an enclosing-scope
  variable in `@name` form.

Multi-output handle calls and handle-shape unification beyond
exact-match are still not supported. See `docs/type_system.md` for
the type-level story.

### Structs and class instances

Structs (`struct('f', v, ...)`) and class instances (`Foo(args)`)
share most of their machinery — both are owned, both program-emit
one typedef per canonical shape, both use the same IR nodes
(`StructLit`, `MemberLoad`, `MemberStore`).

**Structs.** The lowerer recognizes a bare `struct(...)` FuncCall
and builds a `StructLit` whose `ty` is a fresh `StructType` whose
field types are the precise types of the supplied values. v1
requires the `struct(...)` literal to introduce a struct — a bare
`s.x = v` on an undefined `s` is rejected with a clear span-
carrying error. Field reads (`s.f`) lower to `MemberLoad`; field
writes including chained paths (`s.inner.f = v`) lower to a single
`MemberStore` with the field path baked in. The path's leaf type
and rhs must satisfy `storageEquivalent` — both reduce to the same
C-type string via `cFieldTypeStr`, which collapses sign / exact /
tensor-shape differences. After a write, env's struct-typed
variable refreshes via `withPathTypeUpdated` so subsequent reads of
the field see the rhs's full internal type; the C typedef is
unaffected because its hash depends only on `cFieldTypeStr`.

**Classes.** Each classdef AST (workspace or local) goes through
`registerClassDef` (`src/lowering/classDefs.ts`) at Workspace
finalize time. The registration carries:

- the declared property names (source order);
- for properties WITH a default-value expression, the lowered
  default's precise type (typed by a shallow inference accepting
  numeric literals, signed numerics, and tensor literals — precise
  types carry through, since `cFieldTypeStr`-based typedef hashing
  makes the precision free at the C level);
- for properties WITHOUT a default, a slot in `pendingProperties`;
  their C-level type is inferred at first constructor specialization
  (see below);
- the constructor (a method named after the class) and the other
  methods (instance + static), each kept as the original `FuncStmt`
  for specialization on demand.

If `pendingProperties` is empty, `ClassType` is built eagerly. If
non-empty, `reg.ty` is `null` until the first `lowerClassConstructorCall`
fires, at which point `Lowerer.resolveClassType` runs the inference:
for each pending property, scan the constructor body for the first
top-level `<receiver>.<propName> = <rhs>` write, lower the RHS in a
temp env (params bound to the call's argTypes), and use the RHS's
static type as the property's type. The result is cached on
`reg.ty`; subsequent specializations validate against it via the
normal `MemberStore` storage-equivalence check, so a second call
producing an incompatible C-level type surfaces with a clean error
at the call site.

Constructor specialization pre-seeds the receiver `obj` in the
spec's env via a `preSeedOutput` parameter to
`specializeUserFunction`. A synthetic Assign of the
`StructLit`-shaped initial receiver is prepended to the lowered body
so `obj.x = ...` writes against an already-initialized slot from the
first user statement. The initial-receiver `StructLit` uses the
declared default expression for default-having properties; for
pending properties, `synthesizeZeroValue` builds a zero of the
inferred C-level type (scalar `0.0` or empty `mtoc2_tensor_t` —
nested struct/class/handle properties without defaults are rejected
with `UnsupportedConstruct`).

Method dispatch (`obj.method(args)`) routes through
`specializeUserFunction` with a custom source-name half
(`<className>__<methodName>`) for the spec key, so two methods of
the same source name on different classes get distinct mangled C
names.

v1 caveats — all surface at registration time (or first-spec time
for inferred properties) with span-carrying errors:

- No inheritance, no handle classes, no class attributes.
- No `Events` / `Enumeration` / `Arguments` blocks.
- No `get.` / `set.` accessor methods.
- A pending property must have a top-level direct write at the
  start of the constructor body (a conditional / loop / nested-block
  write doesn't count for inference; add a default in that case).
- A pending property inferred to a non-numeric type (struct, class,
  handle) is rejected — supply an explicit default.
- A class with pending properties must declare a constructor (no
  zero-arg / no-constructor path can produce a typed instance).
- Methods must declare 0 or 1 outputs. (Multi-output methods are
  rejected at call time — top-level user functions support N≥2.)
- `disp(classInstance)` is rejected.

**Codegen.** `src/codegen/emitNamedTypedef.ts` renders one block of
C per shape — the `typedef struct ... { ... }`, then `_empty`,
`_free`, `_copy`, `_assign`, and (structs only) `_disp` helpers.
The emitter collects every distinct `StructType`/`ClassType` shape
in the program (`collectNamedTypedefs` in `emit.ts`), topologically
sorts them so a typedef whose fields reference another typedef
appears after its dependency, and writes them ahead of the user
forward declarations.

## Owned-value codegen

Scalars stay in C automatic storage as `double`. Owned kinds compile
to per-kind C representations sharing one four-helper contract:

- Multi-element tensors → `mtoc2_tensor_t` with helpers loaded from
  the runtime-snippet registry (`mtoc2_tensor_empty`/`_assign`/
  `_copy`/`_free`).
- Structs → `mtoc2_struct__<8hex>` typedef, helpers program-emitted
  per canonical shape.
- Class instances → `mtoc2_class_<safeName>__<8hex>` typedef,
  helpers program-emitted per shape.

`ownedHelpersFor(ty)` in `emit.ts` is the single dispatch point —
returns the helper-name family + a flag noting whether the helpers
come from the runtime-snippet registry (tensor) or from the
program-emitted typedef block (struct/class). Memory model is
mtoc's: always-copy on manipulation, free at scope exit. No
refcount, no COW.

Concretely the emit pass:

1. Walks the function body to collect names + types of owned locals
   — any variable that has at least one Assign whose LHS satisfies
   `isOwned(ty)`. `If`/`While`/`For` bodies are walked too, so inner
   declarations surface to the function-level free list. Owned-typed
   params count too: the caller wrapped them in `_copy`, so the
   callee owns its arg and must free it at scope exit.
2. Emits a pre-declaration `<cType> v = <typedef>_empty();` at
   function top for each owned local (skipped for owned params,
   which the function signature already declared). The empty value
   has zeroed owned fields/buffers; the first `_assign` does a
   no-op free and installs the value.
3. For each owned Assign or `MemberStore` with an owned leaf, emits
   `<typedef>_assign(&slot, <rhs>)`. The RHS must be a freshly-owned
   value — `TensorBuild` / `StructLit` / tensor-op calls produce one
   via their alloc helper; `Var(otherVar)` wraps in
   `<typedef>_copy(otherVar)`; a `MemberLoad` of an owned-typed
   field in a consuming context wraps in the field's `_copy`.
4. Walks the body and emits early-frees: after each stmt, every
   owned name in `(uses ∪ defs)(s) − futureTouchOut(s)` gets a
   `<typedef>_free(&v)` call. The future-touch sets come from a
   backward dataflow in `src/codegen/liveness.ts` (port of mtoc's
   liveness analyzer, adapted for mtoc2's simpler IR). Reassignment
   counts as a future touch, so reassigns suppress redundant early-
   frees (the assign helper handles the prior buffer).
5. At end-of-body / before each `mtoc2_return:` label, emits
   `<typedef>_free(&v)` for every owned local + owned param **that
   `nullAtScopeExit` can't prove is already NULL** (and isn't the
   output the function is about to return). The `nullAtScopeExit`
   forward dataflow walks the body computing per-variable
   "guaranteed NULL" sets: Assign clears, early-free sets, If
   intersects across arms, loops intersect (entry, body-end). The
   scope-exit free walk skips proven-NULL names — so simple
   straight-line code emits exactly one free per variable, at its
   last touch. **Owned params are NOT seeded into the dataflow's
   entry set** — they arrive freshly-owned from the caller's
   `_copy`, not NULL, and seeding them as null-at-entry would let
   a body that never reassigns the param skip its scope-exit free
   and leak the caller's allocation.

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

The `Lowerer` class owns mutable state:

- `env: Map<name, { cName, ty }>` — current scope's variable bindings.
- `specializations: Map<specKey, IRFunc>` — cached completed specs.
- `currentFile: string` — file the lowerer is currently inside. Pushed
  and popped by `specializeUserFunction` so a call from inside a
  workspace function's body reports the right file in its `CallSite`
  to the resolver.

Function-name resolution is delegated to the `Workspace` (see below).
The lowerer never carries its own per-file `functionDefs` map — every
call site is resolved through `workspace.resolve(name, argTypes,
callSite, span)`.

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

A user function call `sq(5)` triggers `specializeUserFunction(decl,
argTypes, specSource?, definingFile?, preSeedOutput?)`:

1. Compute the spec key
   (`<sanitize(specSource ?? decl.name)>__<8-hex of FNV-1a(file | arg-type canon)>`).
   The file is the function's `definingFile` (the workspace resolver's
   verdict file, or the class's file for methods, or the file the
   `@(...)` was written in for anonymous-function synths). Salting by
   file is what lets two files define a subfunction with the same name
   and still get distinct C names.
2. If cached, return the cached `IRFunc`.
3. Otherwise: snapshot outer env / declared / tempCounter /
   currentFile; install a fresh env with params bound to their arg
   types; set `currentFile = definingFile`; recursively lower the
   function body; capture output types from the final env; restore.

Recursion isn't supported yet — the placeholder pattern at the top of
`specializeUserFunction` lets us produce a clean error if it happens.

### Workspace and cross-file resolution

The `Workspace` (in [src/workspace/workspace.ts](../src/workspace/workspace.ts))
is the lowerer's portal to numbl's resolver. At construction it
instantiates a numbl `LoweringContext` (vendored via sibling-relative
import); `addFile()` mirrors each pre-parsed `.m` AST into numbl's
`fileASTCache`; `finalize()` registers the main file's top-level
functions and classdefs as locals, calls
`ctx.registerWorkspaceFiles(...)` on the siblings, builds the
`FunctionIndex`, and walks every classdef (workspace + local) to
build mtoc2's own `Map<className, ClassRegistration>`.

`workspace.resolve(name, argTypes, callSite, span)` delegates to
numbl's `resolveFunction` (the single source of truth for MATLAB
precedence rules) and narrows the verdict to mtoc2's supported
kinds:

- `userFunction { ast, file }` — local-to-main, workspace primary, or
  workspace subfunction. The lowerer specializes `ast` with `file`
  passed as `definingFile`.
- `classMethod { className, methodName, stripInstance }` — covers
  `obj.method(args)`, `method(obj, args)`, and the
  `obj.staticMethod(args)` flavor where the resolver flips
  `stripInstance=true`. Note that `ClassName.staticMethod(args)` (no
  receiver in args) lands here too, but with `stripInstance=false` —
  the lowerer disambiguates by looking the method up in
  `reg.staticMethods` vs. `reg.methods`.
- `classConstructor { className }` — `Foo(args)`. In practice the
  lowerer short-circuits constructor calls before the resolver fires
  (it checks `workspace.isClass(name)` against the syntactic call
  name), so this branch is for completeness.
- `builtin { name }` — numbl agrees it's a builtin; mtoc2 still
  validates the name against its own builtin registry.

Everything else (`privateFunction`, `jsUserFunction`, class-file
subfunctions) raises `UnsupportedConstruct` with the call-site span.

The `MType → ItemType` adapter ([`mtypeToItemType`](../src/workspace/workspace.ts))
is intentionally lossy: only `ClassType` maps to a distinguishing
`ClassInstance` shape; every other mtoc2 type collapses to
`Unknown`. That's all numbl's resolver needs to apply class-method
precedence.

The CLI scans `dirname(absolute-entry)` for sibling `.m` files and
descends recursively into `+pkg/` namespace dirs and `@Class/` class
dirs (mirroring numbl's `scanMFiles`). The web IDE passes flat file
names — no scan needed since the workspace already contains every
project file. Multifile test groups under `test_scripts/<subdir>/`
follow the same flow: `main.m` is the entry, every other `.m` in the
directory is a workspace sibling.

Package functions register through the same path: `+pkg/foo.m` is
registered by numbl's `registerWorkspaceFiles` as the qualified name
`pkg.foo`. Call sites `pkg.foo(args)` and `pkg.sub.foo(args)` parse
as `MethodCall` nodes; `lowerMethodCall` recognizes the dotted base
as a package reference (when the leftmost segment is not in the
local env, matching MATLAB's env-shadow rule) and routes the
qualified name through `workspace.resolve`. The qualified name is
passed as the specialization spec source so the mangled C identifier
keeps a readable prefix (`pkg_foo__<hex>`). `@pkg.foo` function
handles flow through the same resolver path.

Functions may declare 0, 1, or N≥2 outputs. The C ABI splits three
ways:

- **0 outputs**: `static void <name>(args)`. The call's IR type is
  `Void`; the lowerer accepts it only as the direct expression of an
  `ExprStmt` (every other use site — Assign RHS, sub-expression of a
  Binary / Unary / Call, tensor-literal element — calls
  `requireValueType`, which rejects Void with a clear span). The
  emitter renders the specialization with no output slot and a bare
  `return;` only when the body needs the `mtoc2_return:` label,
  since a label can't sit directly before the closing brace.
- **1 output**: classic return-by-value. `static T <name>(args) {
return cOut; }`.
- **N≥2 outputs**: `static void <name>(args, T_0 *_mtoc2_o0, ..., T_n
*_mtoc2_on)`. Each output is a function-top local; every return
  point (explicit `return` via `goto mtoc2_return;` and the body's
  fall-through end) writes `*_mtoc2_o<i> = <cOut_i>;` before any
  scope-exit frees and returns `void`. Multi-output user-function
  calls do NOT appear in expression position; they're invoked as the
  RHS of a `MultiAssign` AST node (`[a, b, ~] = foo(x);`) or as a
  bare drop-all statement (`foo(x);`). Both forms lower to a single
  `MultiAssignCall` IR statement that wraps the call in `{ ... }` to
  scope per-slot discard temps (`_mtoc2_discard_<callIdx>_<i>` for
  ignored / trailing-omitted slots). v1 restricts N≥2-output slots
  to scalar real numeric; multi-output class methods and
  multi-output handle dispatch are rejected with a clean
  `UnsupportedConstruct`.

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

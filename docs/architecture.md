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
[type_system.md](type_system.md) for the lattice, the exact-value
machinery, and the inference flow. From an architecture standpoint
the two things to know are:

- Every scalar / small array carries an optional `exact` value
  threaded through the lowerer by each builtin's `transfer` fn.
- `canonicalizeType` + FNV-1a hash drive function specialization
  keys, and the canonical form **includes `exact`** — so each
  distinct exact-value input produces its own specialization.

Owned kinds (tensor, struct, class instance, handle, char, string)
all share the same four-helper contract
(`_empty`/`_assign`/`_copy`/`_free`); the typedef hash uses
`cFieldTypeStr`, so precision differences don't shard the typedef.

### IR (`ir.ts`)

A small typed tree. Expressions: `NumLit`, `StringLit`, `Var`,
`Binary`, `Unary`, `Call`, `TensorBuild`, `TensorConcat`,
`HandleLit`, `HandleCaptureLoad`, `StructLit`, `MemberLoad`,
`IndexLoad`, `IndexSlice`, `EndRef`, `MakeRange`. Statements:
`ExprStmt`, `Assign`, `If`, `While`, `For`, `ReturnFromFunction`,
`Break`, `Continue`, `MemberStore`, `IndexStore`, `IndexSliceStore`,
`MultiAssignCall`, `TypeComment`. `IRFunc` captures a single
specialization; `IRProgram` is top-level statements plus a map of
specializations.

**Indexing and slicing** dispatch in `lowerFuncCall` /
`lowerAssignLValue` against an in-scope multi-element numeric
variable: an arg list with any Range/Colon slot routes to the
slice helper (read or store), otherwise to the scalar helper.
Helpers and the `isSliceArg` / `resolveIndexBase` predicates live
in `src/lowering/indexResolve.ts` and the four `lowerIndex*.ts`
files. The `end` keyword inside an index slot resolves through the
Lowerer's `endStack` to the relevant axis size, statically when
the base shape is known and at runtime otherwise.

**Range-as-value** (`v = 1:n`, `(1:5) * 2`) lowers to a `MakeRange`
IR node backed by `mtoc2_tensor_make_range`. Index-slot ranges
(`IndexSliceArg.Range`) are a different IR shape — they require a
literal `step` so codegen can derive the loop count statically;
the value-form accepts a runtime `step`. Iteration count and
per-element value match numbl byte-for-byte, including the
final-element snap that keeps `0.1:0.1:0.3` ending exactly at
`0.3`.

**For-loop emission** snapshots start/end/count once at loop entry
and iterates by integer count, matching MATLAB / numbl semantics
(mutating `n` inside the body does not extend the loop; a
side-effecting bound is evaluated once).

**Bounds checks** wrap every scalar index access in a runtime check
that aborts with a numbl-style "Index exceeds array bounds"
message; slice-slot accesses validate the full `[first, last]`
range once per slot. Helpers live in `runtime/oob.h`. The empty-
range case (`v(5:4)`) skips the check, matching MATLAB. OOB
regression coverage lives in vitest (`tests/oob.test.ts`) because
the cross-runner can't diff stdouts when both runners error.

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
`mtoc2_tensor_assign(&v, rhs)`, for scalars via plain `v = rhs;`. Every
local — owned or scalar, including For loop vars and multi-assign slot
bindings — is pre-declared at function top by codegen, so the Assign
site never carries the `<cType>` keyword. This matches MATLAB's
"assigned in any branch → in scope after the merge" rule: a variable
first written inside an `if` / `while` / `for` body remains readable
after the block.

> **Known divergence**: the pre-declaration is unconditional, so a
> variable first written inside a block that never executes still
> reads as the zero-initialized default (`0.0`) rather than raising
> "Undefined function or variable" the way numbl does. Concretely,
> `for k = 1:0; a = k; end; disp(a); disp(k);` prints `0` `0` under
> mtoc2; numbl errors at the first `disp`. We accept this gap to
> keep codegen straight-line; a future "definite assignment" guard
> at lowering time could close it.

Every tensor RHS materializes freshly — `TensorBuild` via
`from_row`/`from_matrix`, `Var` via `mtoc2_tensor_copy`, computed
tensor RHSs via their per-op runtime helper. The type system still
tracks `exact` (so specialization keys distinguish `f(2)` from `f(3)`),
but the lowerer doesn't fold it into the IR — see the "Folding only at
if-cond" section below.

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

**Registration and dispatch.** `src/lowering/builtins/index.ts` is
the registry. Operator AST nodes route to builtins via the
op-to-builtin maps in that file (so `a + b` and `plus(a, b)` reach
the same entry). `lowerFunctionCall` consults the workspace
resolver first; when the resolver returns no user-function /
classMethod target, it falls back to the builtin registry.
`lowerIdent` recognizes bare-name reads of 0-arity builtins
(`pi`, `tic`, `figure`, …) so the same name works as identifier
and as `name()`.

**Shared factories.** Most arithmetic/math families are wired by a
single factory (`defineElemwiseRealBinary`, `defineUnaryRealMath`,
`defineReducer`) that takes a small kernel descriptor and produces
the full transfer + codegen + runtime-snippet wiring. Adding a
sibling op (e.g. another unary math function) is typically a
few-line registry entry. The per-op C helpers are macro-generated
into a single `.h` (`tensor_elemwise_real.h`,
`tensor_unary_real_math.h`, `tensor_reduce_real.h`, …) so the
runtime side scales without per-op duplication.

**Parallel `_real.h` / `_complex.h` runtime helpers.** Each per-
family `.h` ships a `_complex` sibling (`tensor_elemwise_complex.h`,
`tensor_unary_complex_math.h`, `tensor_reduce_complex.h`,
`tensor_reshape_nd_complex.h`, `tensor_transpose_complex.h`). The
codegen dispatches on the input's `isComplex` flag and routes to
the matching helper. The complex kernels build per-element
`double _Complex` values via `mtoc2_cmake` and route arithmetic
through the `mtoc2_c*` wrappers in `cscalar.h` — never through
bare C99 `<complex.h>` operators. That keeps the body translatable
by the c2js backend (which substitutes `{re, im}`-object JS
implementations for those wrappers at link time). The complex
helpers tolerate `imag == NULL` on either operand by treating its
imag lane as zero, so a real tensor flowing into a complex op
needs no explicit promote step.

For the current set of names and their per-call behavior, read
`src/lowering/builtins/` and the `Builtin` registrations — the
source is short and the scope list in [CLAUDE.md](../CLAUDE.md)
is the canonical inventory.

**Plot dispatch** is a special case worth highlighting: every plot
name routes through one shared lowering that emits a single
`mtoc2_plot_dispatch("<name>", n, args)` call, with arguments
transported via the `mtoc2_fprintf_arg_t` tagged union. The
accepted name set is imported directly from numbl's
`PLOT_ALL_NAMES`, so numbl is the single source of truth — adding
a name in numbl makes it accept in mtoc2 on the next `tsc` run.
Plot calls are statement-only (return `Void`); the C helper
serializes one JSON line per call prefixed with an ASCII-RS
sentinel and `fflush`s, and the cross-runner globally drops those
lines before the byte-for-byte compare.

### Function handles

`@user_func` and `@(p1, ..., pN) <body>` lower to a `HandleLit` IR
node carrying a `HandleType`. The type carries the target AST (a
synthesized `FunctionStmt` for anonymous forms) plus the list of
captured variables (deep-copied into the handle at the `@(...)`
site to match MATLAB's by-value capture).

Dispatch is static. At every `h(args)` call site the lowerer reads
the handle variable's type, builds `[...userArgs,
...HandleCaptureLoad(h)]` in the underlying spec's param order, and
routes through `specializeUserFunction`. Because `HandleType`'s
canonical form shards on target name, `apply(@foo, x)` and
`apply(@bar, x)` produce distinct `apply__<hex>` specializations.

Handles share the struct/class typedef machinery — same four
owned-helpers, same `cFieldTypeStr`-keyed typedef hash so two
handles differing only in lattice precision share a typedef.

Multi-output handle calls and handle-shape unification across CFG
joins are not yet supported.

### Structs and class instances

Structs (`struct('f', v, ...)`) and class instances (`Foo(args)`)
share their machinery: both are owned, both use the same IR
(`StructLit`, `MemberLoad`, `MemberStore`), and both program-emit
one C typedef per canonical shape with the standard four-helper
contract (`_empty`/`_assign`/`_copy`/`_free`) plus a `_disp` for
structs. The typedef hash is keyed on each field's `cFieldTypeStr`,
which collapses sign / exact / tensor-shape precision — so a write
that refines a field's internal type (e.g. tightens its sign) keeps
the same C-level shape and never shards a typedef.

**Structs** must be introduced by a `struct(...)` literal; bare
`s.x = v` on an undefined `s` is rejected. Field writes go through
`MemberStore` with the dotted path baked in; the leaf type must
match the existing slot under `storageEquivalent` (same
`cFieldTypeStr`). After a write the env refreshes the path's
internal type via `withPathTypeUpdated`, so subsequent reads pick
up the rhs's precision.

**Classes** are registered by `registerClassDef` at Workspace
finalize time. Properties with a default value get their type at
registration; properties without one go on `pendingProperties` and
are inferred at first constructor specialization from the first
top-level `obj.<prop> = <rhs>` write in the constructor body. The
constructor's specialization pre-seeds `obj` with a `StructLit`-
shaped receiver (defaults filled in, pending properties zeroed) so
the user's first statement writes into an already-initialized slot.

Method dispatch routes through `specializeUserFunction` with a
`<className>__<methodName>` spec source so two methods of the same
name on different classes get distinct mangled C names.

v1 boundaries on classes (all enforced with span-carrying errors):
no inheritance / handle classes / class attributes / accessor
methods / `Events` / `Enumeration` / `Arguments` blocks; pending
properties must have a direct top-level write in the constructor;
pending properties inferred to a non-numeric type are rejected
(supply an explicit default); methods declare 0 or 1 outputs;
`disp(classInstance)` is rejected.

Codegen (`src/codegen/emitNamedTypedef.ts`) walks every distinct
`StructType` / `ClassType` / `HandleType` in the program and emits
each shape's typedef + helpers in topological order so an outer
typedef sees its inner dependencies first.

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

`ownedHelpersFor(ty)` in `src/codegen/cHelpers.ts` is the single dispatch point —
returns the helper-name family + a flag noting whether the helpers
come from the runtime-snippet registry (tensor) or from the
program-emitted typedef block (struct/class). Memory model is
mtoc's: always-copy on manipulation, free at scope exit. No
refcount, no COW.

The emit pass:

1. **Collect locals.** Walk the body (including nested block
   bodies) to gather every variable that gets assigned. Owned locals
   feed the scope-exit free list; non-owned scalar locals feed the
   pre-declaration list. Owned params are added to the free list
   too — the caller wrapped them in `_copy`, so the callee owns its
   arg.
2. **Pre-declare at function top.** `<cType> v = <typedef>_empty();`
   for owned locals; `double v = 0.0;` for scalar locals. Predeclaring
   means a variable first written inside a block is still in C scope
   after the block — matching MATLAB's "assigned in any branch → in
   scope after the merge" rule.
3. **Assign sites.** Owned: `<typedef>_assign(&slot, <rhs>)`, where
   the RHS is a freshly-owned value (a `_copy`-wrapped Var, an alloc
   helper, or an op result). Scalar: plain `v = rhs;`.
4. **Early-free.** After each stmt, owned names in
   `(uses ∪ defs)(s) − futureTouchOut(s)` get an immediate
   `<typedef>_free(&v)`. The future-touch sets come from a backward
   dataflow in `src/codegen/liveness.ts`. Reassignment counts as a
   future touch (the assign helper handles the prior buffer), so
   reassigns suppress redundant early-frees.
5. **Scope-exit free.** At end-of-body and before each `mtoc2_return:`
   label, emit `<typedef>_free(&v)` for every owned local + owned
   param (other than an output the function is about to return).
   Frees are unconditional: the early-free pass NULLs each buffer at
   its last use, and every owned `_free` bottoms out at `free(NULL)`,
   so redundant frees are safe.

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
kinds: `userFunction`, `classMethod`, `classConstructor`, and
`builtin`. `privateFunction`, `jsUserFunction`, and class-file
subfunctions raise `UnsupportedConstruct`.

The CLI scans the entry's directory recursively for sibling `.m`
files, descending into `+pkg/` namespace dirs and `@Class/` class
dirs. The web IDE passes flat file names — no scan needed since
the workspace already contains every project file.

Package functions (`+pkg/foo.m` → qualified name `pkg.foo`) flow
through the same resolver. `pkg.foo(args)` parses as a `MethodCall`
node; `lowerMethodCall` recognizes the dotted base as a package
reference (when the leftmost segment isn't an in-scope variable,
matching MATLAB's env-shadow rule) and routes the qualified name
through `workspace.resolve`. The qualified name doubles as the spec
source so the mangled C identifier keeps a readable prefix
(`pkg_foo__<hex>`). `@pkg.foo` handles flow through the same path.

Functions may declare 0, 1, or N≥2 outputs. The C ABI splits three
ways:

- **0 outputs**: `static void <name>(args)`. The call's IR type is
  `Void`, accepted only as an `ExprStmt`'s direct expression.
- **1 output**: return-by-value, `static T <name>(args)`.
- **N≥2 outputs**: `static void <name>(args, T_0 *_mtoc2_o0, ...,
T_n *_mtoc2_on)`. Multi-output calls appear only as the RHS of
  `[a, b, ~] = foo(x)` or as a bare drop-all statement `foo(x);`,
  both lowered to a single `MultiAssignCall` IR statement. Slot
  types are constrained by `isMultiOutputSlotType` (scalar real
  numeric + every owned kind; Void / Unknown rejected). Multi-
  output class methods and multi-output handle dispatch are not
  yet supported.

`nargin` / `nargout` reads inside a user-function body fold to
compile-time constants per specialization; the spec key salts on
`nargout` so the same body called with different output arities
produces distinct C specs.

## Stage 3: emit

The emit pass walks the IR and produces a single C source string.
Its body is split across a handful of files under `src/codegen/` —
`emit.ts` is the program-level entry point (`emitProgram`) and
named-typedef topo sort; `emitStmt.ts` carries the function shape and
the statement switch; `emitExpr.ts` carries the expression switch;
`emitIndex.ts` and `emitTensorConcat.ts` carry the longer specialized
emit blocks (IndexSlice / IndexSliceStore / scalar offset / slot
setup, and TensorConcat respectively); `cFormat.ts` holds the pure
C-string utilities.

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

Subcommands: `mtoc2 translate <file>` (emit C only), `mtoc2 run
<file>` (translate + compile + run; the default if no subcommand
is given), and `mtoc2 eval "<code>"` (translate + run an inline
script). `--path <dir>` (repeatable) adds a workspace search
directory. `--plot` splits plot-record lines back out of stdout
and renders them via numbl's plot dispatcher. `--check-leaks`
builds with `-fsanitize=address` so LeakSanitizer reports unfreed
owned values — the cross-runner enables it by default.

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

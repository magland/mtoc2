# Architecture

mtoc2 is a numbl-dialect compiler with three execution backends — an
AST-walking interpreter, a JS-AOT emitter, and a C-AOT emitter — all
fed by the same parser, type system, and builtin registry. The
backends produce bit-identical stdout for any program they all
support, gated by the cross-runner.

```
numbl source (.m)
       │
       ▼
   parse  ─────────── numbl's parser (sibling import, no vendoring);
       │              shared by every backend
       │
       ├────────────► interpreter (src/interpreter/)
       │              tree-walks the AST, dispatches each op through
       │              the matching builtin's `call` hook
       │
       └─► lower  ──► IR (src/lowering/)
               │      typed, ANF, with exact-value tracking
               │
               ├──► emitJs (src/codegen/emitJs.ts)
               │    builtin.emitJs hooks + inline JS runtime snippets
               │    runs in-process via `new Function`
               │
               └──► emit   (src/codegen/emit.ts)
                    builtin.emitC hooks + C runtime snippets
                    compiled by `cc` (CLI) or emcc (browser WASM mode)
```

## Three backends, one builtin contract

Each builtin lives in its own file under [src/builtins/defs/](../src/builtins/defs/)
and registers up to four hooks:

| hook       | required | who consumes it                |
| ---------- | -------- | ------------------------------ |
| `transfer` | yes      | every backend (type inference) |
| `emitC`    | no       | c-aot codegen                  |
| `emitJs`   | no       | js-aot codegen                 |
| `call`     | no       | interpreter                    |

`transfer` is the source of truth for what a builtin accepts and what
shape it produces. All three backends call it on the same `argTypes`,
so a call that c-aot rejects also rejects in js-aot and the
interpreter — the contract is uniform. The c-aot path enforces it at
lowering time; the interpreter enforces it inside `invokeBuiltin`
before falling through to `call`.

When a backend lacks a hook for a builtin it needs, that backend
raises a clear "no <hook> hook" error at the call site. Today the
c-aot backend is the most complete; js-aot and the interpreter have
gaps documented in [CLAUDE.md](../CLAUDE.md) and tracked by the
all-modes runner.

The full backend matrix is exercised by
`scripts/run_test_scripts_all_modes.ts`; the c-aot-vs-numbl gate
(`scripts/run_test_scripts.ts`) is the strict commit-time invariant.

## Stage 1: parse

[src/parser/index.ts](../src/parser/index.ts) re-exports `parseMFile`
and the AST types from numbl's parser. mtoc2 doesn't vendor any
parser code; the import is a sibling-relative path. AST drift is
caught at `tsc` time. The pinned numbl SHA lives in `NUMBL_VERSION`.

The AST returned from `parseMFile(source, fileName)` is just
`{ body: Stmt[] }`; every node carries a `Span`.

A small handful of AST helpers consumed by both the lowerer and the
interpreter live in [src/parser/astUtils.ts](../src/parser/astUtils.ts)
(currently just `tryExtractDottedName`). These are pure functions
over the AST with no dependency on the lowering or runtime layers.

## Stage 2: lower (c-aot and js-aot)

The lowerer ([src/lowering/](../src/lowering/)) is a one-pass walker
that takes the AST and produces typed IR. The interpreter does not
run this pass — it walks the AST directly.

### Type system

The Type lattice is written from scratch for mtoc2 — see
[type_system.md](type_system.md). Two things to know from an
architecture standpoint:

- Every scalar / small array carries an optional `exact` value
  threaded through the lowerer by each builtin's `transfer` fn.
- `canonicalizeType` + an FNV-1a hash drive function specialization
  keys, and the canonical form **includes `exact`** — so each
  distinct exact-value input produces its own specialization.

Owned kinds (tensor, struct, class instance, handle, char, string)
all share the same four-helper contract
(`_empty`/`_assign`/`_copy`/`_free`); the typedef hash uses
`cFieldTypeStr`, so precision differences don't shard the typedef.

### IR

A small typed tree (`src/lowering/ir.ts`). Expressions: `NumLit`,
`StringLit`, `Var`, `Binary`, `Unary`, `Call`, `TensorBuild`,
`TensorConcat`, `HandleLit`, `HandleCaptureLoad`, `StructLit`,
`MemberLoad`, `IndexLoad`, `IndexSlice`, `EndRef`, `MakeRange`.
Statements: `ExprStmt`, `Assign`, `If`, `While`, `For`,
`ReturnFromFunction`, `Break`, `Continue`, `MemberStore`,
`IndexStore`, `IndexSliceStore`, `MultiAssignCall`, `TypeComment`.
`IRFunc` captures a single specialization; `IRProgram` is top-level
statements plus a map of specializations.

### Lowerer (`lower.ts`)

The `Lowerer` class threads a typed env, allocates per-call function
specializations (mangled by FNV-1a of the canonical arg-type tuple,
salted by defining file), merges types across control-flow joins, and
widens variables assigned inside loop bodies (strips `exact`) before
lowering the body — otherwise the one-pass walk would bake
iteration-1 values into the emitted code.

Two rules drive exact propagation:

1. **Loop-body exact stripping**. Before lowering a `while`/`for`
   body, names assigned in the body have their `exact` stripped from
   env.
2. **Terminator stop in `lowerStmts`**. After emitting a
   `ReturnFromFunction`/`Break`/`Continue`, sibling stmts in the same
   block are skipped — otherwise dead code after an early return
   would pollute the function's return type.

**If-folding** is the only place a known exact value short-circuits
the lowerer: when an if-condition's type has a finite `number`
exact, the lowerer takes the matching branch and drops the rest.
Arithmetic, Ident reads, builtin calls, and tensor construction all
emit runtime IR even when their `exact` is known — see
[type_system.md](type_system.md) for the rationale.

### A-normalization

Every owned-producing non-`Var` sub-expression is hoisted to a fresh
`_mtoc2_t<N>` temp Assign at lowering time. After ANF, owned-
producing expressions appear only as direct Assign RHSs at owned
consume sites — every other position holds a Var read. Owned-
producing in mtoc2 is: `TensorBuild`, or any `Binary`/`Unary`/`Call`
whose result is a multi-element tensor.

### Workspace and cross-file resolution

The [`Workspace`](../src/workspace/workspace.ts) is the lowerer's
portal to numbl's resolver. It instantiates a numbl `LoweringContext`
at construction, mirrors each pre-parsed `.m` AST into numbl's
`fileASTCache`, then walks every classdef to build mtoc2's own
`Map<className, ClassRegistration>`. `workspace.resolve(name,
argTypes, callSite, span)` delegates to numbl's `resolveFunction`
(the single source of truth for MATLAB precedence rules) and narrows
the verdict to mtoc2's supported kinds: `userFunction`, `classMethod`,
`classConstructor`, and `builtin`. `privateFunction`,
`jsUserFunction`, and class-file subfunctions raise
`UnsupportedConstruct`.

The CLI scans the entry's directory recursively for sibling `.m`
files, descending into `+pkg/` namespace dirs and `@Class/` class
dirs. The web IDE passes flat file names.

## Stage 3: emit

Two emitters share the lowered IR.

### `src/codegen/emit.ts` (c-aot)

Walks the IR and produces a single C source string:

1. Struct/class/handle typedefs in topological order
2. Forward declarations for user-function specializations
3. Function specialization bodies
4. `main()` containing top-level statements

Scalars compile to bare `double`. Multi-element tensors compile to
`mtoc2_tensor_t`. Owned-value invariant is mtoc's:
**always-copy on manipulation, free at scope exit, no refcount, no
COW.**

The emit pass:

1. **Collect locals.** Walk the body (including nested block bodies)
   to gather every variable that gets assigned. Owned locals feed the
   scope-exit free list.
2. **Pre-declare at function top.** `<cType> v = <typedef>_empty();`
   for owned locals; `double v = 0.0;` for scalar locals.
3. **Assign sites.** Owned: `<typedef>_assign(&slot, <rhs>)`. Scalar:
   plain `v = rhs;`.
4. **Early-free.** After each stmt, owned names in
   `(uses ∪ defs)(s) − futureTouchOut(s)` get an immediate
   `<typedef>_free(&v)`. Future-touch sets come from a backward
   dataflow in [src/codegen/liveness.ts](../src/codegen/liveness.ts).
5. **Scope-exit free.** At end-of-body and before each
   `mtoc2_return:` label, emit `<typedef>_free(&v)` for every owned
   local + owned param.

Every emitted function carries a doc-comment header
(name, mangled C identifier, per-param/output types from
`typeToString`); every emitted statement carries a one-line comment.
These reflect the IR _after_ lowering: synthetic ANF temps and
folded branches show through.

### `src/codegen/emitJs.ts` (js-aot)

Mirrors `emit.ts` intentionally — same control flow, same variable
layout, same call shape — differing only in language and the I/O
primitive (`$write(s)` vs `printf(...)`).

The emitted module has the shape:

```js
<inlined runtime snippet bodies>
function <user-fn-spec-1>(...) { ... }
function <user-fn-spec-2>(...) { ... }
function run($h) {
  globalThis.$write = $h.write;
  let v1, v2, ...;          // pre-declared locals
  ... top-level stmts ...
}
return run;
```

The CLI / IDE evaluates the source via `new Function(source)()`,
which returns the `run` entry point, then invokes
`run({ write: ... })`. JS owned-value lifecycle is implicit (GC
handles it); the codegen still respects the same Var-read /
ANF-temp shape so per-builtin `emitJs` hooks see the same call
context their `emitC` siblings see.

### Builtins

Each builtin in [src/builtins/defs/](../src/builtins/defs/) is one
file with a single registry entry. Most arithmetic / math families
are wired by a shared factory
(`defineElemwiseRealBinary`,
`defineUnaryRealMath`,
`defineReducer`)
that takes a small kernel descriptor and produces transfer + codegen

- runtime-snippet wiring for all backends in one shot.

**Parallel `_real.h` / `_complex.h` runtime helpers.** Each per-
family `.h` ships a `_complex` sibling. The codegen dispatches on
the input's `isComplex` flag and routes to the matching helper. The
complex kernels build per-element `double _Complex` values via
`mtoc2_cmake` and route arithmetic through the `mtoc2_c*` wrappers
in `cscalar.h` — never through bare C99 `<complex.h>` operators.
That keeps the body translatable: the JS sibling `cscalar.js` ships
matching `{re, im}`-object implementations of the same helpers.

**Plot dispatch.** Every plot name routes through one shared lowering
that emits a single `mtoc2_plot_dispatch("<name>", n, args)` call,
with arguments transported via the `mtoc2_fprintf_arg_t` tagged
union. The accepted name set is imported directly from numbl's
`PLOT_ALL_NAMES` — numbl is the single source of truth, so adding a
name there makes it accept in mtoc2 on the next `tsc` run. Plot
calls are statement-only (return `Void`); the runtime helper
serializes one JSON line per call prefixed with an ASCII-RS
sentinel and `fflush`s, and the cross-runner globally drops those
lines before the byte-for-byte compare.

### Runtime helpers

Each helper lives in its own `.h` file under
[src/builtins/runtime/](../src/builtins/runtime/) (organized into
topic subfolders: `tensor/`, `tensor_ops/`, `text/`, `io/`,
`indexing/`, `plot/`, `system/`). A paired `.js` sibling provides
the same helper for the js-aot backend / interpreter. `npm run
build:snippets` inlines every `.h` and every `.js` sibling into
`snippets.gen.ts` so the translator bundles in the browser. Each
`Builtin` declares its `runtimeDeps: string[]`; the emitter activates
them transitively and dedupes headers.

Adding a helper means dropping the `.h`/`.js` into the topic folder
that fits, re-running `build:snippets`, and registering the snippet
in `src/codegen/runtime.ts`. The snippet registry keys by basename,
so basenames must stay globally unique across the runtime tree.

## Stage 3 (interpreter): src/interpreter/

The interpreter is the third execution backend. It walks the AST
directly — no lowering, no specialization, no IR — and routes every
operator through the matching builtin's `call` hook.

The class shell lives in
[interpreter.ts](../src/interpreter/interpreter.ts); method
implementations live in three sibling files attached to
`Interpreter.prototype` at module load:

| file                      | what's in it                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `interpreterExec.ts`      | `execBody`, `execStmt`, `assignLValue`, `expandForRange`, `autoDisp`                      |
| `interpreterEval.ts`      | `evalExpr` (the big switch), `indexTensor`                                                |
| `interpreterFunctions.ts` | `callByName`, `callHandle`, `callUserFunction`, `constructClassInstance`, `invokeBuiltin` |

Each sibling exports `function name(this: Interpreter, ...)`; the
prototype-augmentation block at the bottom of `interpreter.ts`
copies the exported functions onto `Interpreter.prototype`. This
mirrors numbl's interpreter split — same pattern, fewer files
because the surface here is smaller.

The interpreter uses the same `Workspace.resolve` path the lowerer
does, so MATLAB precedence + package + class-folder + builtin order
match the c-aot path. It runs `transfer` for every builtin call before
dispatching to `call`, so type-shape rejections happen the same way
across backends.

## Stage 4: compile + run (c-aot)

The CLI ([src/cli.ts](../src/cli.ts)) writes the emitted C to a temp
file, invokes `cc -lm`, and execs the resulting binary, forwarding
stdout. `--exec MODE` selects `interpreter | js-aot | c-aot`
(default `c-aot`). `--check-leaks` builds with `-fsanitize=address`
so LeakSanitizer reports unfreed owned values — the cross-runner
enables it on the c-aot path.

The browser IDE uses a parallel WASM path
([src/utils/wasmExecution.ts](../src/utils/wasmExecution.ts)) that
ships the emitted C to a remote emcc service and runs the resulting
wasm in a Web Worker. The js-aot path runs entirely in-browser via
`new Function(source)` inside a Worker; the interpreter path runs
inside an in-browser Worker too. Same translator output, three
different runners.

## Why one pass, not fixpoint

mtoc2's lowerer is one-pass. There's no iteration to a fixpoint when
merging types across loop back-edges. The trade-off is that loops
can't carry exact values across iterations (which we wouldn't usually
want anyway — most loop-mutated state should be runtime-only). Code
that needs precise types in the loop body either picks them up from
the entry env or accepts widening.

## Owned-value codegen detail

For the c-aot path, see the "Owned-value codegen invariant" section
in [CLAUDE.md](../CLAUDE.md) — it's the canonical reference.
[`ownedHelpersFor(ty)`](../src/codegen/cHelpers.ts) is the single
dispatch point that returns the helper-name family + a flag noting
whether the helpers come from the runtime-snippet registry (tensor)
or from the program-emitted typedef block (struct/class/handle).

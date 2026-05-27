# Cell-array support for mtoc2 — plan

**Status:** Design. No code has landed.

Cells are mtoc2's next major owned-value kind, sitting alongside
tensor / string / char / struct / class / handle. They unblock the
chunkie driver pattern `[out{1:nout}] = fcurve(ts)` and the
comma-list expansion family more generally.

This doc is the cells equivalent of [complex_plan.md](complex_plan.md):
it defines the architectural rules and a phase plan that lands the
feature in cross-runner-green increments.

## 1. Goals

- Cell-array literals (`{1, 'hi', [1 2 3]}`), constructors
  (`cell(n, m)`, `cell(n)`), brace-indexed read (`c{i}`, `c{i,j}`),
  brace-indexed write (`c{i} = rhs`), comma-list expansion on both
  the LHS (`[a, b, c] = c{1:3}`) and the RHS (`f(c{:})`),
  `iscell(c)`, and the `numel` / `length` / `size` family for cells.
- Cross-runner stays byte-for-byte aligned with numbl across every
  topic-script subtest we add.
- All three backends (interpreter, js-aot, c-aot) accept the same
  cell programs — `transfer` is shared; backend-specific gaps are
  marked with the existing `% mtoc2-test-xfail-<backend>:` mechanism
  if they appear during landing.
- Test coverage sits next to the existing topic files (a new
  `test_scripts/cells.m` only if patterns don't fit elsewhere).

Non-goals (this milestone):

- **Heterogeneous cells with non-unifying element types**. The type
  lattice has only **tuple** (per-slot types when shape is exact
  and small) and **uniform** (single shared element type for every
  slot). When neither mode applies — e.g. a `cell(n,m)` constructor
  followed by writes whose RHS types diverge and no slot index is
  static — we raise `UnsupportedConstruct` rather than introducing
  an LUB / heterogeneous mode. (Decided by the user at design time.)
- **Paren-indexing on cells**. `c(1:3)` returning a subcell, `c(i)`
  returning a 1×1 subcell, `c(i) = {...}` assigning a subcell:
  deferred. Only brace indexing (`c{...}`) is in scope.
- **Indexed delete on cells** (`c(2:5) = []`). Out of scope, like
  the tensor counterpart.
- **`{ } = ...` lvalue on a non-cell**. We don't promote a tensor
  to a cell on first brace-assign; the target must already be a
  cell.
- **Cell of cell** nesting beyond two levels. Tuple-of-tuple is
  legal but each distinct nested shape generates its own C typedef.
  We accept the typedef proliferation up to chunkie's needs and
  revisit only if a real program blows up the typedef table.
- **`cellfun`, `cell2mat`, `mat2cell`, `struct2cell`**. Deferred —
  none are needed by the chunkie driver. If a downstream test
  script needs one, land it in a follow-up.

## 2. Cell semantics — what we are matching

mtoc2's spec is "what numbl does." Read
[`../numbl/src/numbl-core/interpreter/`](../../numbl/src/numbl-core/interpreter/)
for the authoritative behavior. Key shapes:

- **Empty cell**: `{}` is a `0×0` cell, **not** the empty tensor
  `[]`. `cell(0)` is `0×0`; `cell(n)` is `n×n`; `cell(n, m)` is
  `n×m`; `cell(n, m, k, ...)` is N-D. Numbl reference:
  `interpreter/interpreterExec.ts:1070` returns
  `RTV.cell([], [0, 0])` for the empty-literal case;
  `type-constructors.ts:452` matches for `cell(0)`.
- **`cell(n, m)` element type**: each slot starts as the empty
  `0×0` double tensor `[]`. Confirmed in numbl
  (`type-constructors.ts:442-469`: `empty = () => RTV.tensor(allocFloat64Array(0), [0, 0])`).
- **AST shapes** (already available to mtoc2 via the imported numbl
  parser): `Cell { type: "Cell", rows: Expr[][], span }` for `{...}`
  literals and `IndexCell { type: "IndexCell", base, indices: Expr[], span }`
  for `c{i}` / `c{i, j}`. The LValue variant of `IndexCell` exists
  for the assign form (`numbl/src/numbl-core/parser/types.ts:67,96`).
- **Brace read `c{i}` / `c{i, j}`**: yields the element value (no
  cell-wrapping); type-of yields the slot's type.
- **Brace write `c{i} = rhs`**: replaces slot `i` with rhs; rhs is
  any value (including another cell, a struct, a handle).
- **Comma-list expansion**:
  - LHS: `[a, b, c] = c{1:3}` expands to three stores from the
    three referenced slots. The slice must have length matching
    the LHS lvalue list.
  - RHS in a call: `f(c{:})` expands every slot of `c` into the
    arg list in order.
  - RHS in a tensor literal: `[c{:}]` concatenates the slots like
    a bracket cell. (Numbl supports this; we accept it if it
    falls out of the lowering work, otherwise defer.)
- **`iscell(x)`**: static true/false (we know the kind at type-
  inference time).
- **`numel(c) / length(c) / size(c)`**: shape-of, like tensors.
  `size(c)` for an exact-shape cell returns an exact-shape row
  tensor.

We do **not** match MATLAB's auto-grow on brace-write past the
current bounds (`c{10} = x` on a `c` of length 3 padding with
empties). Numbl **does** auto-grow
(`runtimeIndexing.ts:2020-2024` walks `appendEmptyCellSlot` until
the index fits). Mtoc2 rejects this with `UnsupportedConstruct` —
auto-grow would mutate the cell's static shape mid-lifetime, which
breaks our typing rule that a local's type is fixed after the
first assignment. Cross-runner coverage stays clean by simply not
writing test scripts that exercise the case (we control the
suite). Static-index writes in-bounds: OK. Non-static-index uniform
writes: emit a runtime bounds check that errors on OOB (no
auto-grow).

## 3. Architectural rules

### 3.1 Type lattice: two modes, no LUB

```ts
type CellType =
  | { kind: "Cell"; mode: "tuple"; shape: DimInfo[]; elements: Type[] }
  | { kind: "Cell"; mode: "uniform"; shape: DimInfo[]; elem: Type };
```

**Tuple mode** carries one `Type` per slot, indexed column-major
(matching tensors). Used when shape is fully exact and the total
element count fits a bound (proposed: reuse
`EXACT_ARRAY_MAX_ELEMENTS` for cells). Constructed by:

- Cell literals `{a, b, c}` — N slots in source order.
- `cell(n, m)` when both `n` and `m` are exact and `n*m` fits the
  cap. Slot types start at "empty double tensor" (the canonical
  `[]` type — a tensor with shape `[0, 0]`).

**Uniform mode** carries one `elem` type for the whole cell, plus
the shape (each axis may or may not be exact). Used when:

- `cell(n, m)` with non-exact dimensions — element type is the
  canonical empty double.
- A tuple-mode cell is written with a non-static index and **all
  existing slot types unify** with the rhs type — the cell
  demotes to uniform with the unified type.
- A uniform-mode cell is written, rhs unifies with `elem` — stays
  uniform.

**Rejected** (`UnsupportedConstruct` with span):

- Tuple-mode write at a non-static index where slot types don't
  unify: we'd need an LUB / heterogeneous mode (explicitly out of
  scope).
- Uniform-mode write where rhs doesn't unify with `elem`: same.
- Brace read at a non-static index of a tuple-mode cell where slot
  types don't unify: the result type can't be named without an LUB.
- `cell(n, m)` with a static `n*m` exceeding `EXACT_ARRAY_MAX_ELEMENTS`
  _and_ either dim being non-exact: would demote to uniform of empty-
  double, then any first write of a non-empty-double rhs would
  diverge.

The "demote tuple to uniform" rule fires lazily on each write —
we don't materialize the uniform form until a non-static index or a
type-divergent static write forces it. Static-index static-type
writes update the tuple slot in place and stay tuple.

Equality / hashing:

- Tuple cells canonicalize by sorting `shape` and `elements` (no
  sorting — slot order is meaningful; just structural equality
  of each component).
- Uniform cells canonicalize by `shape` plus `elem`.
- Two cells with different mode never unify, even if a tuple's
  elements all match a uniform's `elem`. (The mode is part of the
  type's identity; demotion produces a new uniform type.)

### 3.2 IR

New IR nodes (one round of additions):

- **`CellLit`**: `{ kind: "CellLit"; elements: IRExpr[]; ty: CellType }`
  for `{a, b, c}` source literals. Like `TensorBuild` but for cells.
- **`CellEmpty`**: `{ kind: "CellEmpty"; shape: IRExpr[]; ty: CellType }`
  for `cell(n, m)` runtime construction. Like `TensorBuild` for a
  zero-fill tensor, but allocates a cell.
- **`CellIndexLoad`**: `{ kind: "CellIndexLoad"; base: VarRef; indices: IRExpr[]; ty: Type }`
  for `c{i}` / `c{i, j}`. Reads always materialize the element as
  an owned copy (per mtoc2's tensor-copy-on-read rule, generalized
  to all owned kinds).
- **`CellIndexStore`**: `{ kind: "CellIndexStore"; base: VarRef; indices: IRExpr[]; rhs: IRExpr; span: Span }`
  for `c{i} = rhs`. The rhs follows the standard owned-consume
  rule (ANF-hoisted if it's an owned-producing sub-expr).

No new IR node for comma-list expansion — the lowerer rewrites
both LHS and RHS forms into existing nodes (see § 3.4).

### 3.3 C representation: per-shape typedef + four owned-kind helpers

Cells reuse the struct/class machinery in
[`src/codegen/emitNamedTypedef.ts`](../src/codegen/emitNamedTypedef.ts).
Each distinct canonical `CellType` produces:

- A typedef `mtoc2_cell_<hash>_t` (the hash is FNV-1a of the
  canonical form including `mode`, `shape`, and per-slot or
  uniform `elem` type).
- Four owned-kind helpers: `mtoc2_cell_<hash>_empty()`,
  `_assign(dst, src)`, `_copy(src)`, `_free(p)`. Pattern matches
  the struct one exactly — predeclare locals at top via `_empty`,
  every Assign through `_assign`, scope-exit `_free`.
- A `_disp` helper used by `disp(c)` (matches the struct pattern).
  Output format matches numbl's `formatCell`
  (`runtime/display.ts:244-251`): single-line `{e1, e2, ...}` with
  comma+space separators, each element rendered via its own
  `displayValue`. Char slots render as `'<value>'`, string slots as
  `"<value>"`. Empty cell is `{}`. No header, no truncation, no
  per-slot indentation.

**Tuple-mode layout** mirrors struct layout: the C struct has one
field per slot, named `slot_0`, `slot_1`, …, typed at the slot's
C representation:

```c
/* cell{double, char_t, mtoc2_tensor_t} 1x3 */
typedef struct mtoc2_cell_<hash> {
  double slot_0;
  mtoc2_char_t slot_1;
  mtoc2_tensor_t slot_2;
} mtoc2_cell_<hash>_t;
```

`mtoc2_cell_<hash>_free` walks each owned slot and calls the
appropriate `_free`; `_copy` walks each and calls `_copy`; etc.

**Uniform-mode layout** is one element-type buffer plus dims:

```c
/* cell uniform double 0×0 each, shape n×m */
typedef struct mtoc2_cell_<hash> {
  size_t ndim;
  size_t *dims;            /* heap, length ndim */
  mtoc2_tensor_t *slots;   /* heap, length = product of dims; each slot is an owned tensor */
} mtoc2_cell_<hash>_t;
```

`_empty` zeros the pointers; `_free` frees every slot then frees
`slots` and `dims`; `_copy` deep-copies every slot.

Note that **uniform-mode cells of scalar element type** (e.g.
uniform-of-`double`) still go through the owned-kind protocol even
though scalars aren't usually owned. This is because the cell
_owns_ its slot buffer, and the slots themselves are the unit of
allocation. The scalar case keeps `slots` as a `double *` buffer
with no per-slot free.

### 3.4 Comma-list expansion lowering

Both LHS and RHS expansion happen at lowering time, not at runtime.
The cell's element count must be statically known.

**LHS form `[a, b, c] = c{1:3}`** (or `c{:}`, `c{i:j}`):

- The lvalue list has a fixed arity N from source.
- Resolve the brace-index slice to N specific slot indices. If the
  range bounds aren't statically known to be N, raise
  `UnsupportedConstruct`.
- Rewrite to N separate `c{<slot_k>}` reads followed by N
  individual stores into `a`, `b`, `c`.

Note that this is a tighter rule than MATLAB — MATLAB allows
unknown count if the cell shape is known at runtime — but it
matches mtoc2's static-typing discipline.

**RHS form `f(c{:})` / `f(c{i:j})`** in a call:

- The arg list resolves the brace-index slice to N specific slot
  reads.
- Rewrite the call's arg list, inserting N args in place of the
  one brace expression. The call's `transfer` then sees the
  expanded arg-type tuple.
- For `f(c{:})` to lower, every slot's type must be known at
  compile time (tuple mode: per-slot types; uniform mode: every
  slot has the same elem type).

**RHS form `[c{:}]`** in a tensor literal: defer to the
TensorConcat / TensorBuild path — each slot becomes one cell of
the bracket literal. This falls out of the comma-list expansion
above if it expands at lvalue time; otherwise we defer.

### 3.5 Owned-value invariant for cells

Cells follow the same always-copy / free-at-scope-exit model as
tensors and structs:

- Every cell-typed local is predeclared at function top via
  `mtoc2_cell_<hash>_empty()`.
- Every Assign uses `mtoc2_cell_<hash>_assign(&v, rhs)`. First-call
  free of NULL is a no-op.
- A cell `Var` read inside an Assign RHS wraps in
  `mtoc2_cell_<hash>_copy(v)`.
- Scope exit / `ReturnFromFunction` emits `_free` for each owned
  local.
- Early-free pass (liveness): cell local names join the existing
  owned-name dataflow; they get a `_free` at last use just like
  tensors.
- The slot rhs in `c{i} = rhs` itself follows the standard ANF
  rule: an owned-producing sub-expr hoists to a fresh
  `_mtoc2_t<N>` temp before the CellIndexStore.

### 3.6 Folding only at if-cond

Same rule as everywhere else. A statically-shape-known cell does
not bake its slot values into emitted C. Slot reads always emit
runtime code through the cell typedef's accessors.

`iscell(c)` is the one exception — it always folds to `true` or
`false` at type-inference time, since the kind is part of the
static type.

`numel(c)`, `length(c)`, `size(c)` fold when `c.ty.shape` is fully
exact (matching the tensor rule). Otherwise they emit runtime
helpers that read the cell's dim fields.

## 4. Phase plan

Each phase lands as a self-contained PR. Cross-runner stays green
at every boundary. We sequence by "smallest useful complete unit"
— after phase A you can declare a cell and free it, after phase B
you can read and write, after phase C you can do the chunkie
pattern.

### Phase A — Type lattice + lifecycle (no I/O yet)

What lands:

- `CellType` discriminated union in
  [`src/lowering/types.ts`](../src/lowering/types.ts).
- `unifyType` / equality / hashing / `typeToString` for cells.
- `cellTuple(shape, elements)` and `cellUniform(shape, elem)`
  factories. `cellTuple` validates that shape×elements lengths
  match and that the total element count fits the exact-tracking
  cap.
- `iscell` builtin (transfer fold; all three backends).
- `cell(n)` / `cell(n, m)` / `cell(n, m, k, ...)` constructor
  builtin. Constructs the right mode based on whether dims are
  exact and the slot count fits.
- `CellEmpty` IR node + walk + prettyIR + emitC + emitJs +
  interpreter `call`.
- `CellLit` IR node + walk + prettyIR + emitC + emitJs +
  interpreter `call`. Source-level `{a, b, c}` parses
  (numbl already emits a `CellLit` AST node — confirm during
  implementation).
- Per-shape cell typedef emission via
  [`src/codegen/emitNamedTypedef.ts`](../src/codegen/emitNamedTypedef.ts)
  — the file gains a `specForCellTuple` / `specForCellUniform`
  exporter alongside `specForStruct`.
- JS-aot cell runtime helper `mtoc2_cell_*` in
  [`src/builtins/runtime/cell/`](../src/builtins/runtime/cell/)
  (new folder) covering `_empty`, `_copy`, `_free`, `_assign`,
  `_disp`. The c-aot side emits the per-shape typedef + helpers
  inline; the js-aot side has a single generic helper that uses
  the cell type's shape descriptor.
- Interpreter `RuntimeCell` value with `mtoc2Tag: "cell"`. Like
  `RuntimeTensor` but slots are an array of `RuntimeValue`.
- Cell scope-exit free in the liveness pass — cell locals join the
  same owned-name set as tensors / structs.
- `disp(c)` for cells: renders numbl-compatible header
  (`{[1x3 cell]}` style) and (for tuple mode) per-slot `disp` of
  each slot. (Verify exact format against numbl before implementing.)

Tests:

- `test_scripts/cells.m` (new topic file): declare empty `{}`,
  `cell(n)`, `cell(n, m)`; pass cell to user function; return cell
  from user function; scope-exit free; `iscell` on cells and
  non-cells; `numel` / `length` / `size` on exact-shape cells.

What does NOT land in phase A:

- Brace read or write — yet. Construction and lifecycle only.

### Phase B — Brace read / write

What lands:

- `CellIndexLoad` IR node + walk + prettyIR + emitC + emitJs +
  interpreter `call`.
- `CellIndexStore` IR node + walk + prettyIR + emitC + emitJs +
  interpreter `call`.
- Lowering: `c{i}` and `c{i, j}` route to `lowerCellIndexLoad`;
  `c{i} = rhs` routes to `lowerCellIndexStore`. (Parser already
  distinguishes `{ }` from `( )` indexing — `Brace` AST node vs
  `Index` AST node. Confirm at implementation time.)
- Tuple-mode static-index read: returns slot type directly.
- Tuple-mode non-static-index read: requires all slot types
  unify; reads the unified type at runtime via a C `switch` over
  the linear index (small cells only).
- Uniform-mode read: returns elem type; emits direct buffer
  access.
- Tuple-mode static-index write: updates the env's slot type and
  emits direct field assignment. If rhs type differs from the
  current slot type, the env's tuple is rebuilt for the surviving
  branches (matches mtoc2's existing exact-narrowing-after-if
  pattern).
- Tuple-mode non-static-index write: if all slots unify with rhs,
  demote to uniform; emit through the uniform-mode store helper.
  Otherwise `UnsupportedConstruct`.
- Uniform-mode write: rhs must unify with elem; otherwise
  `UnsupportedConstruct`.

Tests:

- Extend `test_scripts/cells.m`: brace read/write at static and
  non-static indices, tuple→uniform demotion, type-divergent
  rejection (caught by the cross-runner via `% mtoc2-test-error:`
  if numbl errors too, or by a vitest unit test if numbl accepts).
- `test_scripts/structs.m`: struct field of cell type (one extra
  subtest).

### Phase C — Comma-list expansion

What lands:

- Lowering rewrite for LHS `[a, b, c] = c{i:j}`: in
  [`src/lowering/lowerMultiAssign.ts`](../src/lowering/lowerMultiAssign.ts),
  detect a brace-indexed cell RHS and expand to N separate brace
  reads, one per LHS lvalue. Reuse the existing `Member` / `Index`
  lvalue support from the recent landing.
- Lowering rewrite for RHS `f(c{:})` / `f(c{i:j})`: in
  [`src/lowering/lowerExpr.ts`](../src/lowering/lowerExpr.ts) (or
  wherever call-arg lowering lives), detect brace-slice arg and
  expand each slot into a new arg before the `transfer` runs.
- Lowering rewrite for `[c{:}]` in a TensorBuild context: each
  slot becomes one bracket cell. Defer if it doesn't fall out
  naturally.

Tests:

- Extend `test_scripts/cells.m`: `[a, b] = swap_via_cell(...)`,
  `f(c{:})` with three slots, `[c{1}, c{2}]` in a tensor literal.
- `test_scripts/multi_output.m`: `[s.a, s.b] = f(c{:})` combining
  the recent member-lvalue work with comma-list expansion.

### Phase D — Polish, format, edge cases

What lands:

- `disp(c)` format alignment with numbl byte-for-byte (run the
  cross-runner with a mix of cell shapes and lock in the format).
- `fprintf("%d", c)` / `sprintf` with a cell arg: numbl behavior
  is to error; mtoc2 raises `UnsupportedConstruct` at lowering.
- `isfield` on a cell-typed value: returns false (matches numbl —
  cells have no fields).
- `iscell` returns false on cell-of-other-kind (already covered;
  add a no-cell xfail test).
- Plot-name dispatch with a cell arg: numbl-compatible reject.
- Audit `CLAUDE.md` "Several features still get explicit rejection"
  block — cells move from non-existent to "supported"; cell paren-
  indexing and indexed-delete remain explicit rejections.

## 5. File-by-file change inventory

Rough budget. Each row is "files touched / new" per phase.

### Phase A — lattice + lifecycle

| File                                      | Change                                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `src/lowering/types.ts`                   | Add `CellType`, factories, equality, hashing, `typeToString`.                                                   |
| `src/lowering/ir.ts`                      | Add `CellLit`, `CellEmpty` IR nodes.                                                                            |
| `src/lowering/walk.ts`                    | Walk `CellLit.elements`, `CellEmpty.shape`.                                                                     |
| `src/lowering/lower.ts`                   | Lower `{a, b, c}` AST → `CellLit`; lower `cell(...)` call → `CellEmpty`.                                        |
| `src/lowering/builtins/...`               | Add `iscell.ts`, `cell.ts` (constructor).                                                                       |
| `src/codegen/prettyIR.ts`                 | Render `CellLit` / `CellEmpty`.                                                                                 |
| `src/codegen/emit.ts`                     | Emit `CellLit` as inline slot writes after `_empty`; emit `CellEmpty` as `_empty` + runtime dims init.          |
| `src/codegen/emitNamedTypedef.ts`         | Add `specForCellTuple`, `specForCellUniform`; emit four owned-kind helpers + `_disp`.                           |
| `src/codegen/cHelpers.ts`                 | `cTypeFor` cell → `mtoc2_cell_<hash>_t`. `ownedHelpersFor` cell → the per-shape helper names.                   |
| `src/codegen/liveness.ts`                 | Cell locals join owned-name dataflow (already kind-agnostic? confirm).                                          |
| `src/codegen/runtime/cell_*.h`            | Stubs — most cell helpers are generated inline per typedef. Add only generic helpers (e.g. dim-tuple equality). |
| `src/builtins/runtime/cell/*.js`          | JS siblings — generic `mtoc2_cell_*` helpers using the JS RuntimeCell shape.                                    |
| `src/interpreter/value.ts`                | Add `RuntimeCell` discriminator + helpers.                                                                      |
| `src/interpreter/interpreterExec.ts`      | Handle `CellLit` / `CellEmpty` execution.                                                                       |
| `src/builtins/defs/logical/iscell.ts`     | New.                                                                                                            |
| `src/builtins/defs/system/cell.ts`        | New (constructor).                                                                                              |
| `test_scripts/cells.m`                    | New topic file.                                                                                                 |
| `tests/translate-cells-lifecycle.test.ts` | New. Emitted-C-shape checks.                                                                                    |

### Phase B — brace read / write

| File                                  | Change                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| `src/lowering/ir.ts`                  | Add `CellIndexLoad`, `CellIndexStore`.                                       |
| `src/lowering/walk.ts`                | Walk new nodes.                                                              |
| `src/lowering/lowerCellIndex.ts`      | NEW. Brace-read lowering (parallel to `lowerIndexLoad`).                     |
| `src/lowering/lowerCellIndexStore.ts` | NEW. Brace-write lowering with tuple/uniform mode dispatch.                  |
| `src/lowering/lower.ts`               | Route `Brace` AST node to the new lowerers (read context vs lvalue context). |
| `src/codegen/prettyIR.ts`             | Render new nodes.                                                            |
| `src/codegen/emit.ts` / `emitStmt.ts` | Emit new nodes.                                                              |
| `src/codegen/emitJs.ts`               | Same.                                                                        |
| `src/interpreter/interpreterExec.ts`  | Same.                                                                        |
| `test_scripts/cells.m`                | Extend with read/write subtests.                                             |
| `test_scripts/structs.m`              | Add cell-typed field subtest.                                                |
| `tests/translate-cells-index.test.ts` | New.                                                                         |

### Phase C — comma-list expansion

| File                               | Change                                                      |
| ---------------------------------- | ----------------------------------------------------------- |
| `src/lowering/lowerMultiAssign.ts` | Detect cell-brace-slice RHS, expand to N stores.            |
| `src/lowering/lowerExpr.ts`        | Detect cell-brace-slice in call arg list, expand.           |
| `src/lowering/lower.ts`            | Hook expansion at TensorBuild for `[c{:}]` if it falls out. |
| `test_scripts/cells.m`             | Comma-list subtests (both LHS and RHS).                     |
| `test_scripts/multi_output.m`      | Cross-pattern subtest combining member-lvalue + comma-list. |

### Phase D — polish

| File                                   | Change                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| `CLAUDE.md`                            | Move cells from "out of scope" to scope; keep paren-indexing in "explicit rejection" list. |
| `docs/type_system.md`                  | Document `CellType` lattice (two modes, no LUB).                                           |
| `docs/architecture.md`                 | Note the per-shape cell typedef pattern + reuse of `emitNamedTypedef`.                     |
| `docs/chunkie_plan.md`                 | Mark Phase 5 done.                                                                         |
| `src/builtins/defs/io/disp.ts`         | Cell branch matching numbl.                                                                |
| `src/builtins/defs/io/_format_args.ts` | Reject cell args with span attribution.                                                    |

Rough totals: ~30 files touched, ~10 new files, ~1500-2000 LOC
across the four phases.

## 6. Test plan

The CLAUDE.md instruction "keep the test script count low" — we
add at most one new topic file (`test_scripts/cells.m`). Everything
else slots into existing topics:

| Topic file                    | Adds                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `test_scripts/cells.m`        | NEW. Cell lifecycle, brace read/write, comma-list expansion, mode demotion, `iscell` / `numel` / `length` / `size`. |
| `test_scripts/structs.m`      | Struct field of cell type.                                                                                          |
| `test_scripts/classes.m`      | Class property of cell type (if it falls out — defer if it forces extra work).                                      |
| `test_scripts/handles.m`      | Anonymous handle capturing a cell.                                                                                  |
| `test_scripts/multi_output.m` | `[s.a, s.b] = f(c{:})` combining recent member-lvalue work with comma-list.                                         |
| `test_scripts/functions.m`    | User function with cell arg + cell return type.                                                                     |

Vitest unit tests:

- `tests/translate-cells-lifecycle.test.ts` (phase A): typedef
  emission shape, owned-helper invocations, scope-exit free.
- `tests/translate-cells-index.test.ts` (phase B): tuple-mode
  static-index read/write, uniform-mode buffer access, mode
  demotion (where it happens at lowering time the test asserts the
  emitted-C shape).
- `tests/translate-cells-commalist.test.ts` (phase C): LHS and RHS
  expansion shape; static-arity rejection on non-statically-known
  slices.

## 7. Cruft we are intentionally NOT carrying over

1. **Heterogeneous LUB cell mode**. The user picked tuple+uniform-
   only. If a real test script needs LUB, we revisit; the lattice
   is closed under unify with a clean error otherwise.
2. **MATLAB-style auto-grow on out-of-bounds brace-write**. We
   reject; numbl's interpreter does too unless I'm wrong (verify).
3. **`cellfun` / `cell2mat` / `mat2cell` / `struct2cell`**.
   Deferred — none are on the chunkie path.
4. **`{end}` end-keyword inside brace index**. Defer unless a
   test script needs it. Tensors support `end`; we'd reuse the
   same `endStack` machinery, but adding it later is cheap.
5. **Cell paren-indexing**. `c(1:3)` returning a subcell adds a
   second indexing surface; defer until something needs it.
6. **Two-tier brace+paren indexed assign** (`c(1).field = ...`).
   Out of scope, since paren-indexing on cells is out of scope.

## 8. Open questions — resolved via numbl research

The 11-point research pass against `/home/magland/src/numbl` (run
before any code landed) confirmed the design choices above. Quick
summary of the resolutions:

1. **`disp` format**: single-line `{e1, e2, ...}` per
   `runtime/display.ts:244-251`. Match byte-for-byte. (Was assumed
   to be MATLAB's `[1x3 cell]` summary — research disproved.)
2. **Empty `{}` type**: `shape = [0, 0]`, zero-length elements
   (numbl `interpreterExec.ts:1070`).
3. **Uniform-mode scalar-elem storage**: stays a plain buffer
   without per-slot free, mirroring how `mtoc2_tensor_t` handles
   its underlying `double*`. Owned-helper template covers it via
   the kind-aware field walker.
4. **`size(c)` fold**: tuple-mode cells have exact shape, so the
   tensor reducer's existing fold path applies. No special work.
5. **`c{i}{j}` chains**: numbl handles via recursive `evalIndexCell`
   (`runtime/runtimeIndexing.ts:388`). For mtoc2, the second brace
   indexes a value of cell type returned from the first read — the
   read-result type already carries the cell shape, so a second
   `lowerCellIndexLoad` lands naturally.
6. **Cell-of-cell typedef proliferation**: numbl has no depth
   limit; nested `Cell` AST recurses through `evalCellLiteral`. For
   mtoc2's per-shape typedef, each distinct nested shape gets its
   own typedef — accept up to chunkie's needs (it doesn't use
   nesting), revisit if a real program causes the typedef table to
   blow up.
7. **`fprintf` with cell arg**: numbl throws via `toNumber` /
   `toString` not handling `RuntimeCell` (`helpers/string.ts:96-108`).
   Mtoc2 raises `UnsupportedConstruct` at lowering with a span. No
   special work needed.

**Newly surfaced from research:**

8. **Auto-grow on out-of-bounds brace-write**: numbl **does**
   auto-grow (`runtimeIndexing.ts:2020-2024`). Mtoc2 **rejects**
   this — the cell's shape is part of its static type, and
   mutating it mid-lifetime breaks the typing rule. The decision
   is documented in § 2; tests are written to stay in-bounds.

9. **Comma-list machinery**: numbl uses JS array spread —
   `evalIndexCell` with a colon/range returns a plain JS array, and
   any caller that checks `Array.isArray(val)` spreads it
   (`interpreterExec.ts:616-629, 140-144, 1047-1051, 1075-1081`).
   Mtoc2's interpreter follows the same pattern; mtoc2's AOT path
   expands at lowering time (since AOT can't return a varying-arity
   value at runtime).

## 9. Estimated landing cost

- Phase A: ~15 files touched, ~6 new (incl. new topic file + JS
  cell helpers); ~500-700 LOC.
- Phase B: ~10 files touched, ~2 new; ~400-500 LOC.
- Phase C: ~5 files touched, 0 new; ~250-400 LOC.
- Phase D: docs + format polish; ~100-200 LOC.

Total rough budget: ~30 files touched, ~10 new, ~1500-2000 LOC.
Each phase is one PR; cross-runner stays green at every boundary.

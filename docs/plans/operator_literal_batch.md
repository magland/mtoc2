# Plan: operator and literal vocabulary batch

**Status:** unstarted. Adds the AST surfaces that mtoc2's parser
already produces but that the lowerer still rejects with
`UnsupportedConstruct`:

1. **Transpose** `.'` and `'`
2. **Bracket concatenation** — `[a, b]` (horzcat) and `[a; b]` (vertcat)
   where cells may themselves be tensors (not only scalars)
3. **Short-circuit logical** `||`, `&&` and **elementwise** `~`
4. **Power** `.^` (elementwise) and `^` (scalar; matrix power deferred)

Each piece is small individually; together they unblock the bulk of
`lege/*.m` and `chunkie_simple/chunkerfunc.m`. The four phases are
**independent** and can land as four small PRs or one larger one —
the plan describes them in order of effort.

## Numbl reference — checked behaviors

The implementing agent should cross-check against numbl's
implementation for every phase. The relevant numbl source:

- `../numbl/src/numbl-core/helpers/arithmetic.ts` —
  `mTranspose` / `mConjugateTranspose` (line ~1221), `mPow` / `mElemPow`
  (line ~1006). `mTranspose` collapses ND-into-2D via `tensorSize2D`
  (trailing dims fold into cols). **mtoc2 v1 rejects ND transpose
  with a span; numbl-divergent but matches MATLAB.** Note this in
  the message so users aren't surprised.
- `../numbl/src/numbl-core/runtime/tensor-construction.ts` —
  `horzcat` (line 63), `vertcat` (line 110), `catAlongDim` (filters
  `[0,0]` tensors out, then enforces non-cat-dim match). The "drop
  zero-element tensors whose non-cat dimensions are incompatible"
  rule at line ~404 is subtle — implement it faithfully (otherwise
  `[zeros(0,1), [1 2 3]]` won't match numbl).
- `../numbl/src/numbl-core/interpreter/interpreterExec.ts` lines
  650–661 — `||` / `&&` short-circuit. Numbl converts BOTH operands
  via `toBool` and accepts **tensor operands** (`toBool(tensor) =
all-elements-nonzero AND length > 0`). MATLAB rejects non-scalar
  operands at compile time. **mtoc2 v1 follows MATLAB (reject
  non-scalar)** to keep the type system honest; numbl divergence
  documented.
- `../numbl/src/numbl-core/runtime/runtimeOperators.ts` line 100 —
  `not(v)`: scalar `0` → `true`; tensor → elementwise logical
  tensor. Complex tensor tests both halves; mtoc2 has no complex.
- `../numbl/src/numbl-core/interpreter/builtins/logical.ts` —
  builtins `or` / `and` / `not` as functional forms of `|` / `&` /
  `~`. The unary form is what `~` lowers to.
- `../numbl/src/numbl-core/runtime/convert.ts` line 44 — `toBool`.
  For tensors: "all elements must be nonzero AND length > 0".
  mtoc2 v1 doesn't need this because we reject non-scalar `&&`/`||`
  operands, but the same definition will be needed if we later
  accept tensor operands to match numbl.

**Concrete numbl divergences mtoc2 v1 intentionally takes** (each one
documented in the user-facing error message):

| Site                                 | Numbl                            | mtoc2 v1          | Why                                                            |
| ------------------------------------ | -------------------------------- | ----------------- | -------------------------------------------------------------- |
| Transpose of ND                      | Flattens trailing dims into cols | Rejects with span | Matches MATLAB; ND-trans semantics surprising                  |
| `&&` / `\|\|` of non-scalar          | Accepts via `toBool`             | Rejects with span | Matches MATLAB; preserves "result is scalar logical" type rule |
| Matrix `^` (square × integer scalar) | Repeated mtimes / `inv`          | Rejects           | Defer mpower-on-matrix entirely                                |
| `(neg) .^ (non-integer)`             | Returns complex                  | Rejects with span | No complex type yet (same precedent as `sqrt` / `log`)         |

None of these divergences affect any chunkie_simple file (none
transposes ND, none uses `&&`/`||` on tensors, none uses matrix
power, none takes fractional power of a possibly-negative value).

The compatible behaviors — exact-fold values, sign refinement,
shape preservation, empty-drop in concat, `pow()` rounding, `~` truthy
mapping — must match numbl byte-for-byte on the test scripts.

## Why these four together

All four are AST nodes the numbl parser produces and that mtoc2 today
rejects at lowering time with a span-attributed `UnsupportedConstruct`:

- `unaryOpBuiltin` (in `src/lowering/builtins/index.ts`) only maps
  `UnaryOperation.Minus`/`Plus` — anything else (including `.'`, `'`,
  `~`) lands on the default `throw new UnsupportedConstruct(...)`.
- `binaryOpBuiltin` only maps the eight arithmetic + six comparison
  ops — `Pow`, `ElemPow`, `LeftDiv`, `ElemLeftDiv`, `OrOr`,
  `AndAnd`, `BitOr`, `BitAnd` all hit the default.
- `lowerTensorLit` (line ~1715 of `lower.ts`) rejects non-scalar
  cells with "tensor literal element must be scalar real numeric".

The user-visible payoff: every line of `chunkie_simple/+lege/` and
most expression lines in `chunkerfunc.m` start parsing-to-IR cleanly
after this slope.

## Phase 1 — transpose `.'` and `'`

**Size:** smallest. ~50 lines TS + a ~25-line runtime helper.

### Type rule

- Scalar → scalar (pass-through; the transpose is the identity on a
  1×1).
- `1×N` (row) → `N×1` (col). `exact: Float64Array` propagates with
  the same elements (column-major data is identical between a 1×N
  row and an N×1 col).
- `N×1` (col) → `1×N` (row). Same exact propagation.
- `M×N` matrix → `N×M`. `exact` propagates with the data **shuffled**:
  `dst[i + j*N] = src[j + i*M]` for the column-major layout.
- Empty `0×N` → `N×0`; `M×0` → `0×M`.
- Rank ≥ 3 → `UnsupportedConstruct` with span:
  `"transpose requires a 2-D operand (got <rank>-D); use 'permute' for higher-rank reorderings (numbl flattens trailing dims into cols; mtoc2 follows MATLAB and rejects)"`.
  (`permute` is a separate followup slope.)
- Sign passes through unchanged.

**Implementation reference:** `mTranspose` in
`../numbl/src/numbl-core/helpers/arithmetic.ts` (line ~1221) calls
`transposeCore` which loops `r * cols + c` writing from
`colMajorIndex(r, c, rows)`. Our C inner loop is the same arithmetic.
Numbl skips for scalars / chars / cells / complex-scalars; we just
need the tensor path for v1.

### Why `.'` and `'` map to the same builtin

`.'` is non-conjugate transpose and `'` is conjugate transpose. For
real tensors they're identical. mtoc2 has no complex type today, so
both unary ops route to a single `transpose` builtin. When complex
support lands, add a `ctranspose` builtin and rewire `'` to it.

### Files

```
src/codegen/runtime/tensor_transpose.h    (new)
src/codegen/runtime.ts                    (register snippet)
src/codegen/runtime/snippets.gen.ts       (rebuild)
src/lowering/builtins/shape/transpose.ts  (new — fits "shape" subdir alongside zeros/ones/reshape)
src/lowering/builtins/index.ts            (register + map UnaryOperation.Transpose/NonConjugateTranspose)
test_scripts/transpose.m                  (new cross-runner)
```

### Runtime helper

```c
/* mtoc2 runtime helper: real-tensor transpose for 2-D inputs.
 *
 * Returns a freshly-owned tensor with dims swapped. The 2-D restriction
 * is enforced at lowering — by the time this runs, a.ndim is 2.
 *
 * The data shuffle is a tight nested loop; the compiler will SIMD
 * the inner stride. Column-major in, column-major out.
 */
#include <string.h>
#include <stdlib.h>

static mtoc2_tensor_t mtoc2_tensor_transpose(mtoc2_tensor_t a) {
  long m = a.dims[0];
  long n = a.dims[1];
  mtoc2_tensor_t r;
  r.real = mtoc2_alloc((size_t)m * (size_t)n * sizeof(double));
  r.imag = NULL;
  r.ndim = 2;
  r.dims[0] = n;
  r.dims[1] = m;
  /* dst[i + j*n] = src[j + i*m] (i is dst-row, j is dst-col;
   * dst is (n × m), src is (m × n), both column-major) */
  for (long i = 0; i < n; i++) {
    for (long j = 0; j < m; j++) {
      r.real[j + i*n] = a.real[i + j*m];
    }
  }
  return r;
}
```

Hot-path note: for `M=1` or `N=1`, the data is identical and we
could skip the alloc and reinterpret the dims. **Don't.** The
owned-value invariant says every transpose result is freshly owned;
a "shape-only transpose" that aliased the input buffer would break
the assign/copy/free contract. The compiler will inline the trivial
copy.

### Wiring

In `src/lowering/builtins/index.ts`, extend `unaryOpBuiltin`:

```ts
case UnaryOperation.Transpose:
case UnaryOperation.NonConjugateTranspose:
  return "transpose";
```

(The two AST enum values map to the same builtin; this becomes a
divergence only when complex support lands.)

### Tests

A small `test_scripts/transpose.m` with cases:

```matlab
test_scalar_transpose();   % 5.'  → 5
test_row_to_col();         % [1 2 3].' → [1;2;3]
test_col_to_row();         % [1;2;3].' → [1 2 3]
test_matrix();             % [1 2; 3 4].' → [1 3; 2 4]
test_matrix_3x2();
test_after_opaque();       % %!numbl:opaque
test_chained();            % a.'.'.'  → a.' (odd) / a (even)
test_transpose_then_arith();  % (M.' * v) etc. — once mtimes accepts the shape
test_empty();              % zeros(0,3).'  → zeros(3,0)
```

Reject case (vitest, not cross-runner):

```matlab
zeros(2,3,4).'   % UnsupportedConstruct: transpose requires 2-D
```

## Phase 2 — bracket concatenation

**Size:** medium. ~150 lines TS + a small runtime helper or inline
codegen.

This is the load-bearing phase. Today every line in
`chunkie_simple/+lege/` that builds intermediate matrices fails to
compile because `lowerTensorLit` requires scalar cells. After this
phase, `[a; b]`, `[a, b]`, and matrices-of-tensor-cells all work.

### What "bracket concat" means

The numbl parser produces one node — `Tensor { rows: Expr[][] }` —
for every bracketed form:

- `[1 2 3]` — 1 row, 3 scalar cells.
- `[1; 2; 3]` — 3 rows, 1 scalar cell each.
- `[a; b]` — 2 rows, 1 cell each, **cells may be tensors**.
- `[a, b]` — 1 row, 2 cells.
- `[a b; c d]` — 2 rows, 2 cells each, mixed shapes.
- `[a, b; c]` — currently rejected by the row-uniformity check, but
  matlab allows it when `a, b` horzcat'd has the same column count
  as `c`. **Numbl's behavior is the spec** — match it.

Numbl: each row is `horzcat`'d (cells along that row's columns);
then rows are `vertcat`'d. So the parser's "rectangular grid of
cells" is the wrong mental model — the shapes are computed
row-by-row, then per-row results are stacked.

### Result-shape resolution (lowering-time)

Algorithm in `lowerTensorLit`:

1. **Lower every cell** (mark each owned-producing non-Var for ANF
   hoisting — see "ANF" below).
2. For each cell, require its type to be `NumericType` with a
   **statically-known shape** (`shape !== undefined`). Reject cells
   with unknown-shape tensor types — `[a, b]` where `a` came from a
   runtime-shape constructor isn't supported yet, document the limit.
3. **Per-row horzcat**:
   - Treat each cell as having a 2-D shape `[rows_i, cols_i]` (scalar
     is `[1, 1]`; row vector is `[1, N]`; col vector is `[N, 1]`; ND
     > 2 → reject "bracket concat requires 2-D cells").
   - Drop cells whose shape has any zero (`0×0`, `0×N`, `M×0`). This
     mirrors numbl's `catAlongDim` line ~386
     (`tensors.filter(t => t.shape.some(d => d > 0))`), modulo the
     subtlety described next.
   - **Numbl's zero-element-with-non-matching-non-cat-dim rule**
     (line ~404 of `tensor-construction.ts`): when a zero-element
     tensor's non-cat dimensions don't match the reference shape,
     numbl drops it anyway. This is how `[zeros(0,1), [1 2 3]]`
     produces `[1 2 3]` rather than a dim-mismatch error. Implement
     faithfully — the rule is: an all-zero-element cell is dropped
     if its non-cat dims don't match; otherwise it stays (and
     contributes its cat-dim length, typically 0).
   - All remaining cells in the row must have the **same row count**.
     Otherwise `TypeError` with span: `"bracket horzcat row-count
mismatch: cell <k> is <r1>×<c1>, neighbor is <r2>×<c2>"`.
   - The row's shape is `[rows_i, sum(cols_i)]`.
4. **Across-row vertcat**:
   - Drop all-empty rows (per the same rule).
   - All non-empty rows must have the **same column count**.
     Otherwise `TypeError`.
   - Result shape is `[sum(rows), cols]`.
5. Compute the result `NumericType` with the resolved shape and the
   joined sign across all cells. If every cell has `exact` and total
   element count ≤ `EXACT_ARRAY_MAX_ELEMENTS`, build the flat exact
   Float64Array by walking the result's column-major slots and
   reading each cell's `exact` data at the right source offset.
   Otherwise drop `exact`.

### IR — extend `TensorBuild`, don't add a sibling

Current `TensorBuild` (in `src/lowering/ir.ts`):

```ts
export interface TensorBuild {
  kind: "TensorBuild";
  elements: IRExpr[]; // column-major, all scalar-real
  shape: number[]; // [rows, cols]
  ty: Type;
  span: Span;
}
```

After this phase:

```ts
export interface TensorBuild {
  kind: "TensorBuild";
  // Per-row, per-cell list. Outer dimension is rows; inner is the
  // row's cells in source order. Each cell is an IRExpr of known
  // shape — either scalar real or a tensor.
  cells: IRExpr[][];
  // Computed result shape (after horzcat/vertcat).
  shape: number[];
  ty: Type;
  span: Span;
}
```

Migration: the existing all-scalar codepath wraps each scalar in a
1×1 cell row. The "elements" array semantics is replaced by the
"cells" grid.

### ANF

Owned-producing non-`Var` cells must be hoisted to temps before the
concat sees them — otherwise the concat would consume a not-yet-
named owned value mid-expression. The existing ANF infrastructure
(`anfChildren` in `lower.ts`) already handles this; extend the
"is owned-producing sub-expression" predicate to recurse into
`TensorBuild` cells.

After ANF the IR invariant is:

- Every tensor-typed cell is a `Var` (or `NumLit` for an exact tensor
  that fits the cap — unusual but valid).
- Scalar cells stay as-is.

### Codegen

Two paths, dispatching on whether **every** cell is scalar:

- **All-scalar fast path** (existing): emit
  `mtoc2_tensor_from_row(...)` or `mtoc2_tensor_from_matrix(...)`
  with the flat column-major data. Already handled — just keep this
  path for the case `cells.every(row => row.every(c => isScalar(c.ty)))`.

- **Mixed path** (new): emit a fresh allocation + per-cell copy
  loops:

  ```c
  /* Conceptual emission for [a; b] where a is 1×3, b is 1×3.
   * Result is 2×3 column-major. */
  {
    mtoc2_tensor_t _mtoc2_t = mtoc2_tensor_alloc_nd(2, (long[]){2, 3});
    /* row 0: cell a (1×3), occupies dst rows [0..1), all cols. */
    for (long c = 0; c < 3; c++) {
      _mtoc2_t.real[0 + c*2] = a.real[0 + c*1];
    }
    /* row 1: cell b (1×3), occupies dst rows [1..2), all cols. */
    for (long c = 0; c < 3; c++) {
      _mtoc2_t.real[1 + c*2] = b.real[0 + c*1];
    }
    /* hand to mtoc2_tensor_assign at the consume site */
  }
  ```

  For `[a, b]` (horzcat) it's analogous with col-band offsets.
  General case: each cell occupies a known rectangle of the
  destination (`[r_start..r_end) × [c_start..c_end)`); a nested loop
  walks the cell's elements and writes to the destination's
  column-major offsets.

  **Don't introduce a runtime helper for general concat.** The
  per-cell rectangle is statically known (we computed it at
  lowering); emitting inline loops keeps the codegen simple and
  gives the C compiler a known iteration count to unroll/SIMD. mtoc1
  takes the same approach.

### Cells that are scalars in the mixed path

When a row mixes scalar and tensor cells, scalar cells get a single
slot write:

```c
_mtoc2_t.real[r + c*M] = <scalar-expr>;
```

No special case needed beyond the per-cell rectangle being 1×1.

### Sign and exact propagation

- Sign: join all cells' signs via existing `unifySign`-cascade
  (same precedent as mtoc's `joinSign`).
- Exact: when every cell has `exact` (either scalar `number` or
  tensor `Float64Array`) AND total element count ≤
  `EXACT_ARRAY_MAX_ELEMENTS`, build the flat exact buffer at
  lowering. Otherwise drop exact. The codegen still emits the
  alloc + copy at runtime (always-materialize invariant), but
  downstream type-system consumers fold against the static data.

### Tests

`test_scripts/bracket_concat.m`:

```matlab
test_vertcat_2_rows();      % [1 2 3; 4 5 6]
test_horzcat_2_cells();     % [a b] where a,b are tensors
test_vertcat_tensor_rows(); % [a; b] where a,b are 1×N
test_mixed_shapes();        % [a b; c d] with rectangular result
test_scalar_and_tensor();   % [s, v] where s is scalar, v is row vec
test_empty_drop();          % [[]; [1 2 3]; []]  → [1 2 3]
test_exact_fold_small();    % [1 2; 3 4] folds; shape ≤ cap
test_runtime_after_opaque();
test_3_level_vertcat();     % [[1 2]; [3 4]; [5 6]]
test_concat_in_assign();    % a = [b; c]; disp(a);
test_concat_pass_to_func(); % f([a; b])
```

Reject cases (vitest):

```matlab
[zeros(2,3); zeros(3,4)]    % column-count mismatch
[zeros(2,3); zeros(3,3,4)]  % cell has rank > 2
```

## Phase 3 — logical `||`, `&&`, `~`

**Size:** small. ~80 lines TS, no runtime helper for the scalar path.

### `||` and `&&` are scalar-only short-circuit

Per **MATLAB**, `||` and `&&` require scalar operands. **Numbl is
more permissive** — it routes both operands through `toBool` and
accepts tensors (truthy = all-elements-nonzero AND length > 0). See
`../numbl/src/numbl-core/interpreter/interpreterExec.ts` lines
650–661.

**mtoc2 v1 chooses the MATLAB-strict path** — reject non-scalar
operands at lowering with span:
`"short-circuit '||' requires scalar operands (got <ty>); use elementwise '|' instead (note: numbl accepts non-scalar via toBool but mtoc2 follows MATLAB)"`.
(Same for `&&`/`&`.)

mtoc2 doesn't have `|` or `&` (elementwise) yet — leave the message
honest but note that elementwise is a followup.

#### Transfer

- `||(a, b)` / `&&(a, b)` — both args must be scalar real numeric.
  Result is logical scalar.
- Exact-fold: when both args are exact numbers, fold via JS truthiness
  (`(a !== 0) || (b !== 0)`). When only `a` is exact:
  - `||` with `a` truthy → result is `1` exact (short-circuits).
  - `&&` with `a` falsy → result is `0` exact (short-circuits).
  - Otherwise drop exact.
- **The fold rule mirrors short-circuit semantics**, so a folded
  `||` with truthy LHS never evaluates the RHS — including the RHS's
  type transfer if it might have raised. The lowerer should compute
  the LHS first, decide if it folds, and only lower the RHS if
  needed.
- **Lowering order**: `lowerBinary` currently lowers both operands
  unconditionally. For `||`/`&&` the lowerer must do **LHS first,
  conditional RHS** to honor short-circuit on side-effectful or
  type-rejecting RHSs. This is a small refactor — split out
  `lowerBinaryWithShortCircuit` or similar.

#### Codegen

- Scalar emit: `((<a>) || (<b>))` / `((<a>) && (<b>))`. C's operators
  evaluate to 0 or 1, same as MATLAB's logical scalar. No conversion
  helper needed.

#### Sign

Result is logical, sign `nonneg` (always ≥ 0). Use the existing
`scalarLogical()` factory.

### `~a` (logical NOT, elementwise)

- Transfer: scalar → scalar logical; tensor → tensor logical with
  same shape.
- Exact-fold: scalar exact `x` → `!x ? 1 : 0`; tensor exact buffer
  maps elementwise.
- Sign of result: always `nonneg` (values in {0, 1}).

**Numbl reference**: `not(v)` in
`../numbl/src/numbl-core/runtime/runtimeOperators.ts` line 100.
Tensors: produce a logical tensor with `.real[i] = (a.real[i] == 0) ? 1 : 0`.
The result type carries an `_isLogical: true` flag in numbl; in
mtoc2 the result `NumericType.elem` is `"logical"` (the existing
logical scalar / tensor mechanism handles this). Confirm `disp` of
a logical-typed tensor matches numbl's formatting — numbl renders
logicals without the trailing decimal (`disp(true) → 1`, not `1.0`).

#### Codegen

- Scalar: `((<a>) == 0.0)` — note: don't use `!`, since `!` on a
  double has compiler-dependent behavior; explicit comparison is
  safer.
- Tensor: new runtime helper `mtoc2_tensor_not(t)` that loops and
  writes `r.real[i] = (a.real[i] == 0.0) ? 1.0 : 0.0`.

### Wiring

- `binaryOpBuiltin`: map `BinaryOperation.OrOr` → `"oror"`,
  `AndAnd` → `"andand"`.
- `unaryOpBuiltin`: map `UnaryOperation.Not` → `"not"`.
- Three new builtins:
  `src/lowering/builtins/logical/oror.ts`,
  `andand.ts`,
  `not.ts` (new `logical/` subdir).
- New runtime helper `tensor_not.h`.

### Tests

`test_scripts/logical_ops.m`:

```matlab
test_or_basic();
test_and_basic();
test_short_circuit_lhs_truthy_or();   % rhs is `(1/0)`; should not evaluate
test_short_circuit_lhs_falsy_and();
test_not_scalar();
test_not_tensor_row();
test_not_tensor_matrix();
test_in_if_cond();    % if x > 0 && y < 5; ...
test_in_while_cond();
```

Reject cases (vitest):

```matlab
[1 2] || [3 4]   % non-scalar
```

## Phase 4 — power `.^` and `^`

**Size:** medium. ~100 lines TS + a runtime helper.

### `.^` elementwise

Mirrors `plus`/`minus`/`times` in `_elemwise.ts` exactly, but the C
op is the `pow()` function call rather than an infix operator. The
existing `defineElemwiseRealBinary` factory takes `cOp: string`; either:

- **Extend** the factory to accept `cOp` OR `cFn`, branching on which
  is provided.
- **Or** add a sibling `defineElemwiseRealBinaryFn` that takes
  `cFn: string` and emits `<cFn>(a, b)` instead of `(a) <cOp> (b)`.

Either is fine. Extending the existing factory keeps the call sites
uniform — recommend that path. The `_elemwise.ts` change is ~10
lines.

Result-shape and exact-fold rules are identical to `plus`/`minus`.

Sign rule (the part that's new):

- Exact zero exponent → `positive` (1).
- Base statically `positive`: result `positive`.
- Base statically `nonneg` AND exponent statically `nonneg`: result
  `nonneg`.
- Base statically `negative` AND exponent statically integer: parity
  determines sign — but mtoc2 doesn't track integer-ness of doubles,
  so this case collapses to "unknown" unless the exponent is an exact
  integer NumLit. When both are exact, the fold path produces a
  concrete number and `signFromNumber` does the right thing.
- Otherwise: `unknown`.

Domain restriction (matches the sqrt/log pattern):

- If base could be negative (`!signIsNonneg(base.sign)`) AND exponent
  isn't a known integer (`exact: number` with `Number.isInteger`), reject:
  `"'.^' with possibly-negative base and non-integer exponent is not yet supported (would produce a complex result)"`.

When the base is statically nonneg, accept any exponent. When the
base is statically negative AND the exponent is an exact integer,
accept (the integer-power path is well-defined and real).

### `^` scalar

Matches `mtimes`'s "scalar-or-matrix" duality:

- Both scalar: scalar `^` is just elementwise power on a 1×1 — route
  to the `.^` builtin (the elemwise version).
- Either operand is multi-element: reject with span
  `"'^' on matrices (matrix power) is not yet supported; use '.^' for elementwise"`.

(Matrix power needs eigendecomposition for non-integer exponents and
repeated `mtimes` for integer exponents — a real slope of its own,
defer entirely.)

**Numbl reference**: `mPow` in `helpers/arithmetic.ts` line 1006.
For matrix base + scalar integer exponent, numbl uses repeated
`matMul`; for `n < 0` it precomposes with `inv(A)`. For `mElemPow`
(line 1075), numbl has fast paths for `^2` (squaring) and integer
exponents; falls back to per-element `Math.pow`. mtoc2 v1 doesn't
need the fast paths — `pow()` is fine for portability.

### Files

```
src/codegen/runtime/tensor_elemwise_real_fn.h  (already exists for atan2/hypot/mod/rem — add power_tt/_ts/_st here)
src/lowering/builtins/arithmetic/_elemwise.ts  (extend factory to accept cFn alongside cOp)
src/lowering/builtins/arithmetic/power.ts      (.^ builtin)
src/lowering/builtins/arithmetic/mpower.ts     (^ builtin — delegates to power for scalar case)
src/lowering/builtins/index.ts                 (register + map BinaryOperation.Pow/ElemPow)
test_scripts/power.m                           (new)
```

### Tests

```matlab
test_pow_pos_int_exp();       % 2 .^ 3
test_pow_pos_float_exp();     % 4 .^ 0.5
test_pow_neg_base_int_exp();  % (-2) .^ 3 — allowed (integer exponent)
test_pow_tensor_scalar();     % [1 2 3] .^ 2
test_pow_scalar_tensor();     % 2 .^ [1 2 3]
test_pow_tensor_tensor();     % [2 3] .^ [3 2]
test_pow_zero_exp();          % x .^ 0 == 1 for any x
test_pow_zero_base_pos_exp(); % 0 .^ 2 == 0
test_pow_caret_scalar();      % 2 ^ 3
test_pow_chain();             % 2 .^ (1 + 1)
```

Reject cases (vitest):

```matlab
(-1) .^ 0.5    % negative base, non-integer exponent → reject
[1 2; 3 4] ^ 2 % matrix power → reject
```

## Cross-cutting: type-system helpers

This slope needs two new sign-lattice helpers in `types.ts` (if
they're not already present):

- `signIsPositive(s: Sign): boolean` — true for `"positive"` only.
- `signIsInteger(t: NumericType): boolean` — true when `t.exact` is a
  number and `Number.isInteger(t.exact)`. (Or a sibling
  `isExactInteger(t)`.)

The `signIsNonneg` already exists.

## Acceptance criteria

```
npx tsc
npm run lint
npm run format:check
npx tsx scripts/run_test_scripts.ts
```

stays green. Each phase's new test file cross-runs byte-for-byte
with numbl. The vitest reject-tests pass.

Manual spot-check: compile and inspect emitted C for
`a = [1 2 3].'`, `b = [a; a]`, `c = a .^ 2`, `if any(a > 0) && all(a < 10); disp(1); end`
— confirm the C is what the plan describes (transpose call, alloc+
copy, pow() call, short-circuit `||`/`&&`).

## What this slope explicitly does NOT enable

- `permute` for general dim reordering (followup; needed only by
  rank ≥ 3 code).
- Matrix power `^` on matrices (eigendecomp + repeated-mtimes; own
  slope).
- Elementwise `|` and `&` on tensors (sibling to `~`; small followup
  that needs both this slope and a logical-elementwise runtime helper).
- Unknown-shape concat — bracket cells must have statically-known
  shapes today. Once a need surfaces, lift via a runtime
  `mtoc2_tensor_concat_check` helper that verifies dims at runtime.
- Logical-tensor reductions in concat sign-joins (sign on tensors
  isn't propagated through bracket cells today; matches the existing
  behavior, see `lowerTensorLit`'s sign join).
- Complex transpose `'` distinct from `.'` — same builtin in v1; split
  when complex lands.

## What this slope unblocks in chunkie_simple

Compiling each file becomes possible (modulo the **other** missing
features — member-rooted indexing, anon-handle tensor captures,
sort/flipud, diagnostics, plotting):

- **`lege/*.m`** — every `.'`, every `[a; b]`, every `~` in
  control-flow lands.
- **`chunkerfunc.m`** — `[derpol(us); zeros(1, k)]`, every `||`,
  every `.^`, every `vd.'` lands. The remaining blockers are:
  member-rooted indexing for slicing-into-fields, advanced indexing
  for `ab(:, isort)`, multi-output `sort`, and `error`.
- **`@chunker/chunker.m`** — already compiles (classdef works).
- **`@chunker/plot.m`, `quiver.m`** — needs `varargin` + member-rooted
  indexing + plotting builtins. Not unblocked by this slope.
- **`main.m`** — needs anon-handle tensor captures + `fprintf` +
  member-rooted indexing + plotting. Not unblocked by this slope
  alone, but the `2*pi`, `rad*[cos(...);sin(...)]`-style expressions
  inside `circfun` start working (the bracket-concat with tensor rows
  is the bottleneck).

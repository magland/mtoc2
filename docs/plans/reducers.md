# Reducer family (sum / prod / mean / min / max / any / all)

Planning artifact for the work that landed alongside this doc. Captures
the scope decisions, the shape-of-result rules, and the followups that
were intentionally deferred.

## Scope

Seven reductions, each with three call forms (where applicable):

| name   | signatures                                       | result  | empty-fiber fallback |
| ------ | ------------------------------------------------ | ------- | -------------------- |
| `sum`  | `sum(A)`, `sum(A, dim)`, `sum(A, 'all')`         | double  | `0`                  |
| `prod` | `prod(A)`, `prod(A, dim)`, `prod(A, 'all')`      | double  | `1`                  |
| `mean` | `mean(A)`, `mean(A, dim)`, `mean(A, 'all')`      | double  | `NaN` (0 / 0)        |
| `min`  | `min(A)`, `min(A, [], dim)`, `min(A, [], 'all')` | double  | `NaN`                |
| `max`  | `max(A)`, `max(A, [], dim)`, `max(A, [], 'all')` | double  | `NaN`                |
| `any`  | `any(A)`, `any(A, dim)`, `any(A, 'all')`         | logical | `0` (false)          |
| `all`  | `all(A)`, `all(A, dim)`, `all(A, 'all')`         | logical | `1` (true)           |

Reducers operate on real numerics (`double` / `logical`). `char` and
complex are out of scope.

## Architecture

- **Per-op file** (`sum.ts`, `prod.ts`, ...) — a one-liner that
  supplies the kernel pieces (init / step / finalize / sign rule /
  empty fallback) through `defineReducer`.
- **Shared core** (`_shape.ts`) — `reductionTransfer` (typing) and
  `reductionCodegen` (C emission). Holds the axis classification,
  the lattice-aware result-shape calculation, the exact-fold path
  (capped at `EXACT_ARRAY_MAX_ELEMENTS = 256`), and the sign-rule
  helpers (`sumSign`, `prodSign`, `meanSign`, `minMaxSign`).
- **Runtime helper** (`src/codegen/runtime/tensor_reduce_real.h`) —
  C macros (`MTOC2_DEFINE_ACCUM_REDUCTION`,
  `MTOC2_DEFINE_MINMAX_REDUCTION`, `MTOC2_DEFINE_LOGICAL_REDUCTION`)
  generate the `mtoc2_<name>_all` (scalar return) and
  `mtoc2_<name>_dim` (tensor return, runtime axis arg) pair per op.
  All seven ops ride on the single `mtoc2_tensor_reduce_real`
  snippet; the per-name registry entries are thin alias dependencies.

## Shape inference

Result shape is computed against mtoc2's three-state `DimInfo` lattice
(`one` / `notOne` / `unknown`) plus the concrete `shape` when set.
`shapeAfterReduction` (in `jit/jitTypes.ts`) is the reference;
`_shape.ts` matches it on the lattice side too.

The sharp lattice case is a tensor like `M(:, k)` where `M` has known
shape `[1, N]` (row vector): the slice produces dims `[unknown, one]`
with no concrete shape. Every later dim is `one`, so `chooseDefaultAxis`
returns `AxisAll` and the reducer compiles through to a scalar
`mtoc2_<name>_all` call instead of throwing.

## Folding

When every input element is exact (scalar `t.exact: number` or
`t.exact: Float64Array`), the transfer computes the result at compile
time. Caps at `EXACT_ARRAY_MAX_ELEMENTS`; beyond the cap the
materialized result is dropped (`exact` becomes `undefined`) and
codegen routes to the runtime.

The fold paths mirror the runtime exactly:

- `sum` / `prod` / `mean`: accumulator (NaN-skip is **not** applied —
  numbl's `omitnan` flag is out of scope).
- `min` / `max`: NaN-seed, NaN-skip, first non-NaN captures.
- `any` / `all`: short-circuits on the first nonzero / zero.

## Sign refinement

Output sign uses the mtoc2 7-state lattice (finer than numbl's
3-state). Highlights:

- `sum` of `positive` input → `nonneg` (empty case can be 0);
  bumps to `positive` if `provablyNonEmpty`.
- `prod` of `positive` → always `positive` (empty → 1).
- `min` / `max` preserve the input's matching bound, but only when
  `provablyNonEmpty` — otherwise the NaN empty-fiber case widens to
  `unknown`.
- `any` / `all` always `nonneg` (logical {0, 1}).

`provablyNonEmpty(t)` lives in `types.ts`: true iff
`shape !== undefined ? shape.every(s => s > 0)` else
`dims.every(d => d.kind !== "unknown")`.

## String literal support

`'all'` is the only string the reducers accept. Plumbing this through
required:

- A new `StringLit` IR node (`src/lowering/ir.ts`).
- `lowerExpr` handles `case "Char":` and `case "String":` — strips
  the surrounding delimiters and emits `StringLit` with
  `ty: { kind: "String", exact: <stripped> }`.
- Codegen emits the bare literal as a C string (so the C expression
  compiles standalone) but the reducer's `codegenC` ignores the
  slot entirely — the helper-name choice carries the dispatch.

## Followups (intentionally deferred)

- **Elementwise `min(A, B)` / `max(A, B)`** — separate slope.
  Currently rejected with an `UnsupportedConstruct` recommending the
  reduction form.
- **Multi-output `[v, i] = min(x)`** — falls through the
  `lowerMultiAssign` path's "only user-defined functions on the
  right of `[...] = ...`" check. The error wording is generic
  rather than min/max-specific; revisit if it becomes confusing.
- **`'omitnan'` / `'includenan'` flag** — would need a parallel
  kernel template. Numbl supports both; mtoc2 always behaves like
  the default (`includenan` for sum/prod/mean, NaN-skip for
  min/max).
- **Runtime (non-exact) integer `dim`** — rejected with a clear
  span message ("can't be deduced into a result shape"). A static-
  shape-only path would require duplicating every dim variant for
  every supported axis (3 axes × 7 ops × 2 sides) — wait for a
  concrete need.
- **Ambiguous lattice without `dim`** — `[notOne, unknown]` and
  similar shapes throw `UnsupportedConstruct`. Same workaround:
  pass an explicit `dim` or `'all'`.
- **`std` / `var` / `median` / `mode` / `cumsum` / `cumprod` /
  `cummin` / `cummax` / `diff`** — numbl supports these via similar
  shared infrastructure; out of scope for this round.

# Complex-number support for mtoc2 — plan

Status: planning. No code changes yet. This document is the contract
we'll build to.

## 1. Goals

- Complex numbers — scalar and tensor — work the same way real numbers
  do throughout mtoc2: arithmetic, comparison, logical, indexing,
  reshape, transpose, reductions, math builtins, disp, fprintf, pass
  to / return from user functions, function-handle captures.
- Cross-runner stays byte-for-byte aligned with numbl over the full
  topic-script suite.
- Test coverage sits next to the real counterpart in the same topic
  file (`test_scripts/tensors.m` gains complex-tensor subtests,
  `math_builtins.m` gains complex-arg subtests, etc.) — not a parallel
  `complex.m` file unless a topic genuinely doesn't have a real
  analogue.
- The implementation borrows ideas from `../mtoc` but **does not**
  copy its factory plumbing, registry indirections, or feature surface
  ahead of demand. Each carry-over from mtoc has to justify itself
  against the cruft-avoidance section below.

Non-goals (this milestone):

- Quaternions / extended-precision / `single`-precision complex.
- `complex(a, b)` constructor builtin.
- `sqrt(-1) → 1i` domain-miss promotion.
- Native conjugate-transpose runtime (`'` lowers to
  `transpose(conj(z))` instead).
- Complex `expm1` / `log1p` (the real-only builtins don't exist in
  mtoc2 yet).

## 2. What's already plumbed in mtoc2

Some scaffolding for complex landed during the type-system bring-up
but has never been exercised. The plan extends it; it does not
re-engineer it.

| Site                                                  | State                                                                  |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| `NumericType.isComplex: boolean`                      | field exists, always set to `false` today.                             |
| `NumericExact = number \| { re; im } \| Float64Array` | the `{re, im}` arm is declared and unused.                             |
| `mtoc2_tensor_t.imag`                                 | pointer slot exists, always NULL today.                                |
| `tensor_empty.h`                                      | NULLs both lanes.                                                      |
| `tensor_free.h`                                       | unconditionally frees both lanes; `free(NULL)` is well-defined.        |
| `tensor_assign.h`                                     | unconditionally frees both old lanes before moving the new tensor in.  |
| `tensor_copy.h`                                       | hard-coded real-only — needs a complex sibling.                        |
| 25 builtins guarding with `isComplex \|\| throw`      | these guards get removed or rerouted in phase order.                   |
| Parser (numbl, imported)                              | already lexes `1i` / `2.5i` / `1j` into AST shape `Number * ImagUnit`. |
| `typeToString` rendering                              | already prints `complex(...)` when `isComplex` is set.                 |

The split-buffer layout (`real` + `imag`, not interleaved) is the
permanent storage choice — matches numbl, matches mtoc, and means
codegen never branches on `imag != NULL`. The static type's
`isComplex` flag decides up-front whether to emit `.imag[...]`
accesses; statically-real tensors never touch the imag side.

## 3. Architectural rules — the contract

- **Type lattice carries `isComplex` precisely.** Every factory that
  constructs a `NumericType` must thread `isComplex` correctly. When
  `isComplex === true` we **enforce `sign === "unknown"` at the
  factory site**, not as a post-observation normalize pass. (mtoc's
  `normalizeComplexSign` is cruft — `unify` and `canonicalizeType`
  call it defensively. We won't ship that pass; we'll require every
  builder to be honest about its sign.)

- **C representation is fixed and uniform.** Scalar complex →
  `double _Complex`. Tensor complex → `mtoc2_tensor_t` with both
  lanes allocated. The same typedef is used for both real and
  complex tensors; the type-system decides per use site whether to
  touch `.imag`.

- **Owned-value invariant continues to hold for complex tensors.**
  One owned-kind (TENSOR) handles real and complex. The kind's
  `copy` and `disp` closures dispatch on `isComplex`; `empty`,
  `free`, `assign` are shape-agnostic and already work today.

- **`isComplex` contaminates results.** real ⊙ complex, complex ⊙
  complex, real-tensor ⊙ complex-scalar, etc., all yield complex.
  This rule lives in one place (`arithResult` or its equivalent).

- **Exact tracking extends to complex.** A scalar complex literal
  has `exact: { re, im }`. `exp(1+0i)`, `2 * 3i`, etc. fold at type-
  inference time when every input is exact. Specialization mangling
  already treats `exact` as part of the canonical key (the
  `encodeExactNumber` path already handles the `{re, im}` shape per
  `types.ts:907`). No mangling work needed — it's already wired,
  just unreached.

- **`exact` for complex tensors stays bounded the same way.** When
  a complex tensor literal is fully exact AND the element count
  fits `EXACT_ARRAY_MAX_ELEMENTS`, the `exact` carrier becomes a
  `Float64Array` of length `2 * n` (interleaved real/imag) or a new
  `{ re: Float64Array; im: Float64Array }` carrier. **Decision: use
  `{ re; im }` carrier.** Rationale: matches the runtime's
  split-buffer storage; keeps the real-only `Float64Array` carrier
  meaning unchanged (no overload of "interleaved vs flat"). This is
  a small `NumericExact` extension.

- **Cross-runner byte-equivalence is the spec for display.**
  Format strings for complex scalars and tensors mirror numbl's
  `formatComplex` exactly, including the surrounding spaces around
  the `+ / -` separator (`"1 + 2i"`, `"1 - 2i"`, `"2i"` for pure
  imag, real-only path when `im === 0`).

- **Folding-only-at-if-cond stays.** Same rule as for real. A
  known-exact complex scalar still emits a `Var` read and a runtime
  C variable; only `if cond` uses the exact value to decide the
  branch.

## 4. Design decisions and rationale

### 4.1 Runtime helper naming: parallel `_complex` siblings

Each existing per-op runtime header (`tensor_elemwise_real.h`,
`tensor_reduce_real.h`, `tensor_mtimes_real.h`, …) gets a `_complex`
sibling. The macros in `_real.h` files stay real-only; we'll generate
the `_complex.h` counterpart with the same macro shape and a `_LANES`
loop body that touches both lanes.

Rationale:

- Each `.h` stays focused. Reading `tensor_reduce_complex.h` is
  faster than reading a parametrized `tensor_reduce.h` whose macro
  takes a `LANES` knob.
- The codegen-side dispatch is a single ternary on `isComplex`;
  there's no harder-to-test "real path through a complex macro"
  case.
- The runtime file count goes up by ~20 — that's fine; each is small,
  and the cost is once-only at `build:snippets`.

### 4.2 `ctranspose` (`'`) lowers to `transpose(conj(...))`

We do **not** ship a `tensor_ctranspose_complex.h` runtime helper.
For real-typed inputs, `'` and `.'` are already identical (mapped to
`transpose` at `unaryOpBuiltin`). For complex inputs, the unary `'`
lowers to `transpose(conj(...))`. The double walk is fine —
conjugate is one element op, transpose is one element op, and the
compiler can fuse them in the iter loop if that ever matters.

Rationale: avoids a second runtime helper that exists only because
mtoc kept fusion-friendly shape. mtoc2 doesn't fuse yet, and this
gives us complex transpose for free.

### 4.3 Scalar complex arithmetic uses C99 `_Complex` directly

For scalar `+ - * /` on at least one complex operand, codegen emits
the same infix C operator and lets C99's implicit promotion handle
real↔complex mixing. Exception: scalar `/` on complex routes through
`mtoc2_cdiv` so signed-Inf-at-divide-by-zero matches numbl.

Rationale: a `mtoc2_cmul` / `mtoc2_cadd` etc. would buy nothing —
C99 already produces the same code. Only divide and the
domain-miss-prone `sqrt` need wrappers.

### 4.4 Skip the `LibmComplexOpts` registry layer

mtoc has a factory (`defineLibmUnary` / similar) that takes both
real and complex variant names. mtoc2's per-builtin file pattern
(`math/sqrt.ts`, `math/exp.ts`, etc.) already gives us one file per
op; each can declare its complex sibling inline. We won't introduce
a generic factory just to "match the mtoc shape."

### 4.5 Defer `complex(a, b)`, `expm1`/`log1p` complex, `sqrt(-1)→i`

These are all wins-on-the-margin. We're going to need a lot of
landings to get to `ex00_starfish.m`; deferring the marginal wins
keeps the diff manageable. None of them block the starfish example.

## 5. Phase plan

Each phase is a self-contained PR-shaped unit: lands type changes,
codegen changes, runtime helpers, tests, and docs in one commit (or
small commit chain). Cross-runner stays green at every phase
boundary. **The phases are ordered so that each adds the smallest
useful complete capability.**

### Phase 1 — Scalar complex foundation

What this lands:

- `ImagLit` IR node (literal `1i`, `2.5i`, parsed bare or via the
  `NumLit * ImagUnit` collapse).
- Scalar complex type construction (`scalarComplex(exact?)`).
- Complex propagation through `arithResult` (real ⊙ complex →
  complex).
- Scalar complex arithmetic codegen (`+ - *` use infix; `/` routes
  through `mtoc2_cdiv`; `^` → `cpow`; unary `-`).
- Scalar comparison: `< <= > >=` on real part; `== !=` on both;
  logical `! && ||` use `toBool(z) = creal(z) != 0 || cimag(z) != 0`.
- `disp` of scalar complex via `mtoc2_disp_complex` (calls
  `mtoc2_format_complex`).
- `fprintf` of scalar complex via an extension to `format_engine.h`'s
  `%g` / `%f` / etc. handlers that prints `re + im*i`-style output
  (matches numbl). Reject `%d` / `%x` / `%o` / `%c` with a span
  attribution — they're real-integer specs.
- New scalar builtins: `real(z)`, `imag(z)`, `conj(z)`, `angle(z)`.
- `abs(z)` for complex (returns real, `hypot(creal, cimag)`).
- Predeclaration of scalar complex locals (`double _Complex name = 0.0;`).
- Tests added to: `test_scripts/math_builtins.m` (complex-arg subtests
  for the affected unary builtins, `real`/`imag`/`conj`/`angle`),
  `test_scripts/scalars.m` (complex literals, arithmetic, disp,
  compare, logical, fprintf), `tests/translate-complex-scalar.test.ts`
  (emitted-C shape: `1.0 * I`, `mtoc2_cdiv(...)`,
  `cpow(...)`, comparison hoist temps).

What this does NOT land:

- Complex tensor literals.
- Complex math unary builtins beyond `abs` / `real` / `imag` /
  `conj` / `angle` (those land in phase 4).
- Indexing, reshape, transpose, reductions for complex tensors.

### Phase 2 — Complex tensor construction & lifecycle

What this lands:

- `tensor_alloc_complex.h` (allocates both lanes;
  `tensor_alloc.h` stays real-only).
- `tensor_copy_complex.h` (copies both lanes).
- `tensor_from_row_complex.h` and `tensor_from_matrix_complex.h`
  (used by the slice-read path and any future flat-pointer
  materialization; codegen for the literal does inline writes for
  exact-arrayed runtime cell expressions).
- `tensor_alloc_nd_complex.h` (parallel of the existing N-D alloc).
- Bracket-literal cells may be complex. `[1+2i, 3-4i]` lowers to a
  `TensorBuild` whose elements are complex IR expressions; codegen
  emits inline `out.real[i] = creal(...); out.imag[i] = cimag(...);`
  writes per cell.
- `TensorConcat` accepts complex cells, with the same
  contamination-rule discipline as `arithResult` (any complex cell
  contaminates the output).
- `disp_tensor_complex.h` — slice-by-slice grid renderer for complex
  tensors, mirroring `disp_tensor.h`.
- `tensor_copy` lookup in `ownedKinds.ts` (or its mtoc2 equivalent)
  dispatches on `isComplex`.
- New file: `test_scripts/complex_tensors.m` for purely-complex
  patterns that don't have a real analogue (constructing a complex
  tensor literal end-to-end, passing it to a user function,
  returning it from one). Most subtests, though, slot into
  `tensors.m`, `bracket_concat.m`, and `owned.m`.

What this does NOT land:

- Elementwise arithmetic on complex tensors (phase 3).
- Reductions / reshape / transpose / index of complex tensors.

### Phase 3 — Complex tensor arithmetic

What this lands:

- `tensor_elemwise_complex.h` and `tensor_elemwise_complex_fn.h` (the
  parallel of `_real.h` / `_real_fn.h`), with `_tt`, `_ts`, `_st`,
  `_bcast_tt` helpers per op (plus, minus, times, rdivide).
- Routing in `_elemwise.ts`: when either operand is complex,
  emit the `_complex` helper variant.
- `mtimes` for tensor-tensor: `tensor_mtimes_complex.h`. Matrix–
  vector inner-product (1×k \* k×1 → scalar) variant.
- Scalar mtimes: handled by the scalar-complex path of phase 1.
- Tensor unary `-`: `tensor_uminus_complex.h` (or, since unary on
  complex is just per-element negate, fold into the elemwise op).
- Subtests slot into `tensors.m` (complex-tensor arithmetic), and
  `mtimes.m` (complex matrix multiply).

### Phase 4 — Complex unary math

What this lands:

- For each of: `sqrt`, `exp`, `log`, `log2`, `log10`, `sin`, `cos`,
  `tan`, `atan`, `floor`, `ceil`, `round`, `fix`, `sign`:
  - Drop the `requireRealDouble` guard, replace with
    `requireRealOrComplex`.
  - In `transfer`, accept complex input; result is complex (except
    `abs`, already phase 1).
  - In `codegenC`, emit `c<name>(...)` for scalar complex and route
    tensor variants through `tensor_<name>_complex.h` siblings.
- `mod` and `rem` reject complex (MATLAB does too).
- `atan2` rejects complex (two-arg form is real-only in MATLAB).
- `hypot` accepts complex per numbl's behavior (operates on
  magnitudes).
- `clog2.h`, `clog10.h` runtime helpers (C99 has no `clog2`/`clog10`).
- Subtests slot into `math_builtins.m` with complex-arg cases per op,
  next to the real cases.

### Phase 5 — Complex indexing

What this lands:

- `lowerIndexLoad`, `lowerIndexSlice`, `lowerIndexStore`,
  `lowerIndexSliceStore` thread `isComplex` through the result type
  and the codegen path.
- Scalar reads of a complex tensor element: codegen composes
  `(base.real[off] + base.imag[off] * I)` — same as inside an iter
  loop. Hoist to a `double _Complex _mtoc2_tN` temp when used twice.
- Scalar writes into a complex tensor: split RHS via
  `creal/cimag` into the two lanes.
- Slice reads: alloc result via `mtoc2_tensor_alloc_complex` and
  copy both lanes in parallel.
- Slice writes: write both lanes per element.
- Explicit error attribution for "complex RHS into real base" —
  silently dropping the imag part would be a footgun. Use a
  `TypeError` with span pointing at the offending index store.
- Subtests slot into `indexing.m`.

### Phase 6 — Complex reductions, reshape, transpose

What this lands:

- `tensor_reduce_complex.h` (parallel of `_real.h` macro).
- `sum`, `prod`, `mean`, `min`, `max` thread isComplex through
  transfer + codegen. `min` / `max` compare on `|z|` with `atan2`
  tiebreak, matching numbl's `complexIsBetter` — the runtime helper
  encapsulates this.
- `any` / `all` use the same `toBool` rule as logical — they work
  for free once `toBool` is taught complex.
- `reshape` complex: `tensor_reshape_complex.h` (parallel of real).
  The element-count discipline is unchanged; reshape just walks
  both lanes.
- `transpose` complex: `tensor_transpose_complex.h`. Decision: this
  is `.'` (non-conjugating). The conjugate form `'` lowers to
  `transpose(conj(z))` at the lowering level (`unaryOpBuiltin`
  branches on the operand's `isComplex`).
- Subtests slot into `reducers.m`, `reshape_basics.m`,
  `shape_misc.m`, `tensors_nd.m`.

### Phase 7 — Cleanups & docs

What this lands:

- Audit `CLAUDE.md` and remove "complex" from the "Not yet supported"
  list. Update the scope description.
- `docs/type_system.md`: remove "reserved, not yet wired" caveats.
  Document the complex propagation rule and the
  `factory-enforces-sign-on-complex` invariant.
- `docs/architecture.md`: add a short section on the parallel
  `_real.h` / `_complex.h` runtime helper pattern.
- `docs/testing.md`: note that complex tests sit next to real
  counterparts in the same topic file.

## 6. File-by-file change inventory

Rough count by phase. Each row is "files touched / new" for
the phase. The list is the audit — at PR time we'll cross
each off.

### Phase 1 — scalar foundation

| File                                                                   | Change                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lowering/ir.ts`                                                   | Add `ImagLit` IR node and union member.                                                                                                                                                                                                   |
| `src/lowering/types.ts`                                                | Add `scalarComplex(exact?)`; tighten `arithResult` propagation rule; ensure every factory sets `sign: "unknown"` when `isComplex`.                                                                                                        |
| `src/lowering/lower.ts`                                                | Add `ImagUnit` AST → `ImagLit` lowering case; in `Binary` lowering add the `Mul(NumLit, ImagLit(1))` collapse. Drop `isComplex \|\| throw` from any sites where complex is now legal (e.g. handle captures, struct fields, return types). |
| `src/lowering/builtins/_shared.ts`                                     | Add `requireRealOrComplex(t, what, span)`; add `exactComplex(t)`; keep `requireRealDouble` for the not-yet-allowed sites.                                                                                                                 |
| `src/lowering/builtins/arithmetic/_elemwise.ts`                        | Generalize the scalar-OP-scalar fold + codegen to accept complex; keep tensor paths real-only here (phase 3 extends).                                                                                                                     |
| `src/lowering/builtins/arithmetic/{plus,minus,times}.ts`               | Scalar paths gain complex fold + codegen.                                                                                                                                                                                                 |
| `src/lowering/builtins/arithmetic/rdivide.ts`                          | Scalar path: when either operand complex, route through `mtoc2_cdiv`.                                                                                                                                                                     |
| `src/lowering/builtins/arithmetic/mtimes.ts`                           | Scalar path: complex multiplication via infix.                                                                                                                                                                                            |
| `src/lowering/builtins/arithmetic/mpower.ts`                           | Scalar `^`: when result type is complex, emit `cpow(a, b)`.                                                                                                                                                                               |
| `src/lowering/builtins/arithmetic/power.ts`                            | Same. (elemwise pow on complex defers to phase 3, but the scalar fold path here is the easy half.)                                                                                                                                        |
| `src/lowering/builtins/arithmetic/uminus.ts`                           | Scalar complex: emit `(-x)` (C99 supports unary `-` on `_Complex`).                                                                                                                                                                       |
| `src/lowering/builtins/compare/{eq,ne,lt,le,gt,ge}.ts`                 | Scalar complex: `eq`/`ne` compare both parts; `<` family compares real part only. Hoist via `_mtoc2_cx_N` temp if operand is non-Var.                                                                                                     |
| `src/lowering/builtins/logical/not.ts`                                 | Scalar complex: `!(creal(z) != 0 \|\| cimag(z) != 0)`.                                                                                                                                                                                    |
| `src/lowering/builtins/logical/{andand,oror}.ts`                       | Already scalar-only; teach toBool for complex.                                                                                                                                                                                            |
| `src/lowering/builtins/io/disp.ts`                                     | Scalar complex → `mtoc2_disp_complex`.                                                                                                                                                                                                    |
| `src/lowering/builtins/io/_format_args.ts`                             | Allow complex args; emit the right slot tag.                                                                                                                                                                                              |
| `src/lowering/builtins/io/fprintf.ts`                                  | Drop blanket reject-complex; pass through to format engine.                                                                                                                                                                               |
| `src/lowering/builtins/math/abs.ts`                                    | Complex returns real, `hypot(creal, cimag)`.                                                                                                                                                                                              |
| `src/lowering/builtins/math/{real,imag,conj,angle}.ts`                 | New files (4 new builtins).                                                                                                                                                                                                               |
| `src/lowering/builtins/index.ts`                                       | Register new builtins.                                                                                                                                                                                                                    |
| `src/lowering/walk.ts`                                                 | Add `ImagLit` case (no-op like NumLit).                                                                                                                                                                                                   |
| `src/codegen/prettyIR.ts`                                              | Render `ImagLit` in IR pretty-print.                                                                                                                                                                                                      |
| `src/codegen/emit.ts`                                                  | Emit `ImagLit` as `(<value> * I)`; scalar complex var predecl as `double _Complex name = 0.0;`.                                                                                                                                           |
| `src/codegen/typeToC` (in `types.ts`)                                  | Scalar complex → `double _Complex`.                                                                                                                                                                                                       |
| `src/codegen/runtime/cdiv.h`                                           | New. Numbl-compatible signed-Inf behavior + Smith's algorithm.                                                                                                                                                                            |
| `src/codegen/runtime/format_complex.h`                                 | New. Mirrors numbl `formatComplex` byte-for-byte.                                                                                                                                                                                         |
| `src/codegen/runtime/disp_complex.h`                                   | New. Wraps format + printf.                                                                                                                                                                                                               |
| `src/codegen/runtime/format_engine.h`                                  | Edit: add complex-arg handling for `%g/%f/%e`. Reject `%d/%x/%o/%c` with attribution to the spec position.                                                                                                                                |
| `src/codegen/runtime/_format_args.ts`-ish (the TS-side slot tag table) | Add a TAG_COMPLEX value.                                                                                                                                                                                                                  |
| `src/codegen/runtime.ts`                                               | Register `cdiv`, `format_complex`, `disp_complex` snippets.                                                                                                                                                                               |
| `src/codegen/runtime/snippets.gen.ts`                                  | Regenerate via `npm run build:snippets`.                                                                                                                                                                                                  |
| `test_scripts/scalars.m`                                               | New subtests for complex literals/arith/compare/logical/fprintf/disp.                                                                                                                                                                     |
| `test_scripts/math_builtins.m`                                         | New subtests for `abs(complex)`, `real`, `imag`, `conj`, `angle`.                                                                                                                                                                         |
| `tests/translate-complex-scalar.test.ts`                               | New. Emitted-C-shape assertions.                                                                                                                                                                                                          |

### Phase 2 — tensor construction & lifecycle

| File                                               | Change                                                                                                                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lowering/types.ts`                            | Add `tensorComplex(...)` factory. Extend `NumericExact` to allow `{re: Float64Array; im: Float64Array}` for complex-tensor exact carriers. Equality + hashing updates. |
| `src/lowering/lower.ts`                            | `TensorBuild` may have complex elements; result `ty.isComplex = true`. Bracket cells gating: still reject Strings / Voids etc. but accept complex.                     |
| `src/codegen/emit.ts`                              | `TensorBuild` of complex routes through inline `out.real[i] = creal(_); out.imag[i] = cimag(_);` writes (alloc'd via `mtoc2_tensor_alloc_complex`).                    |
| `src/codegen/ownedKinds.ts` (or equivalent)        | TENSOR kind's `copy` and `disp` dispatch on `isComplex`.                                                                                                               |
| `src/codegen/runtime/tensor_alloc_complex.h`       | New.                                                                                                                                                                   |
| `src/codegen/runtime/tensor_alloc_nd_complex.h`    | New.                                                                                                                                                                   |
| `src/codegen/runtime/tensor_copy_complex.h`        | New.                                                                                                                                                                   |
| `src/codegen/runtime/tensor_from_row_complex.h`    | New.                                                                                                                                                                   |
| `src/codegen/runtime/tensor_from_matrix_complex.h` | New.                                                                                                                                                                   |
| `src/codegen/runtime/disp_tensor_complex.h`        | New.                                                                                                                                                                   |
| `src/codegen/runtime.ts`                           | Register the new snippets.                                                                                                                                             |
| `src/codegen/runtime/snippets.gen.ts`              | Regenerate.                                                                                                                                                            |
| `test_scripts/tensors.m`                           | New subtests: complex tensor literal, complex Var read & disp, pass-to-func & return.                                                                                  |
| `test_scripts/bracket_concat.m`                    | New subtests: `[1+2i, 3; 4, 5-6i]` mixing complex and real cells (real promotes to complex).                                                                           |
| `test_scripts/owned.m`                             | New subtests: complex tensor scope-exit / early-free / lifecycle.                                                                                                      |
| `test_scripts/complex_tensors.m`                   | NEW topic file for patterns without a real analogue (only if needed; first pass — slot everything into existing topics).                                               |
| `tests/translate-complex-tensor.test.ts`           | New. Emitted-C-shape assertions for tensor lifecycle.                                                                                                                  |

### Phase 3 — tensor arithmetic

| File                                               | Change                                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/lowering/builtins/arithmetic/_elemwise.ts`    | Generalize tensor paths: when either operand has `isComplex`, route to `mtoc2_tensor_<base>_complex_{tt,ts,st,bcast_tt}`.      |
| `src/lowering/builtins/arithmetic/mtimes.ts`       | Tensor mtimes complex: route to `mtoc2_tensor_mtimes_complex`.                                                                 |
| `src/codegen/runtime/tensor_elemwise_complex.h`    | New.                                                                                                                           |
| `src/codegen/runtime/tensor_elemwise_complex_fn.h` | New. (Mirrors `_real_fn.h` for fn-shape elemwise; only needed if any phase-3 op uses a fn body; phase 4 covers most of these.) |
| `src/codegen/runtime/tensor_mtimes_complex.h`      | New.                                                                                                                           |
| `src/codegen/runtime/snippets.gen.ts`              | Regenerate.                                                                                                                    |
| `test_scripts/tensors.m`                           | New subtests: complex+complex / complex+real-broadcast / scalar+complex-tensor / unary-minus / .\* / ./.                       |
| `test_scripts/mtimes.m`                            | New subtests: complex M*M / complex M*v / complex M\*scalar.                                                                   |

### Phase 4 — complex unary math

| File                                                                                                 | Change                                                                                                  |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/lowering/builtins/math/_unary_real.ts`                                                          | Rename / extend → `_unary.ts` (or add a parallel) that accepts complex. Per-op file updates below.      |
| `src/lowering/builtins/math/{sqrt,exp,log,log2,log10,sin,cos,tan,atan,floor,ceil,round,fix,sign}.ts` | Accept complex; scalar path emits `c<name>` (using `clog2`/`clog10` for those two via runtime helpers). |
| `src/codegen/runtime/clog2.h`                                                                        | New. `clog(z)/log(2.0)`.                                                                                |
| `src/codegen/runtime/clog10.h`                                                                       | New. `clog(z)/log(10.0)`.                                                                               |
| `src/codegen/runtime/tensor_<name>_complex.h` for each affected op                                   | New per-op headers.                                                                                     |
| `src/codegen/runtime/snippets.gen.ts`                                                                | Regenerate.                                                                                             |
| `test_scripts/math_builtins.m`                                                                       | New subtests per op, slotted next to real counterparts.                                                 |

### Phase 5 — complex indexing

| File                                   | Change                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/lowering/lowerIndexLoad.ts`       | Result type carries base's `isComplex`.                                                                      |
| `src/lowering/lowerIndexSlice.ts`      | Same. Slice-result allocator picks `_complex` variant.                                                       |
| `src/lowering/lowerIndexStore.ts`      | If base is real and RHS is complex → TypeError with attribution. Codegen splits complex RHS into both lanes. |
| `src/lowering/lowerIndexSliceStore.ts` | Same.                                                                                                        |
| `src/codegen/emit.ts` (index emission) | Compose `(.real[off] + .imag[off]*I)` for complex reads; split RHS into both lanes on writes.                |
| `test_scripts/indexing.m`              | New subtests: complex scalar read/write, complex slice read/write, real-base-complex-RHS rejection.          |

### Phase 6 — reductions, reshape, transpose

| File                                                         | Change                                                                                                    |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `src/lowering/builtins/reduction/_shape.ts`                  | Thread `isComplex` through transfer + codegen routing.                                                    |
| `src/lowering/builtins/reduction/{sum,prod,mean,min,max}.ts` | Accept complex; route to `_complex` runtime variants. `min`/`max` use the magnitude-compare helper.       |
| `src/lowering/builtins/reduction/{any,all}.ts`               | Already operate via `toBool`; just allow complex input.                                                   |
| `src/lowering/builtins/shape/reshape.ts`                     | Thread `isComplex`; route to `_complex` reshape helper.                                                   |
| `src/lowering/builtins/shape/transpose.ts`                   | Thread `isComplex`; route to `_complex` transpose helper.                                                 |
| `src/lowering/builtins/index.ts` (unaryOpBuiltin)            | For complex operand, `'` lowers to a `conj(transpose(...))` call sequence.                                |
| `src/codegen/runtime/tensor_reduce_complex.h`                | New. Macro-generates `sum/prod/mean/min/max` per the existing real pattern.                               |
| `src/codegen/runtime/tensor_reshape_complex.h`               | New.                                                                                                      |
| `src/codegen/runtime/tensor_transpose_complex.h`             | New.                                                                                                      |
| `src/codegen/runtime/complex_compare.h`                      | New. `mtoc2__complex_isbetter(a, b)` for min/max — magnitude compare with atan2 tiebreak (matches numbl). |
| `test_scripts/reducers.m`                                    | New subtests per op.                                                                                      |
| `test_scripts/reshape_basics.m`                              | New subtests: reshape on complex tensor.                                                                  |
| `test_scripts/shape_misc.m` / `tensors_nd.m`                 | New subtests: transpose / N-D complex.                                                                    |

### Phase 7 — docs

| File                   | Change                                                                     |
| ---------------------- | -------------------------------------------------------------------------- |
| `CLAUDE.md`            | Remove complex from "Not yet supported"; add to scope.                     |
| `docs/type_system.md`  | Remove "reserved, not yet wired" caveats; document propagation rule.       |
| `docs/architecture.md` | Short section on parallel `_real.h`/`_complex.h` runtime pattern.          |
| `docs/testing.md`      | Note: complex tests live next to real counterparts in the same topic file. |

## 7. Test plan

The user constraint is "complex tests live next to the real
counterpart in the same topic file." That maps as follows:

| Topic file                      | Adds                                                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `test_scripts/scalars.m`        | scalar complex literals (`1i`, `2.5i`, `1 + 2i`), arithmetic, compare, logical, disp, fprintf.                                                |
| `test_scripts/math_builtins.m`  | `abs`, `real`, `imag`, `conj`, `angle`, plus complex `sqrt/exp/log/log2/log10/sin/cos/tan/atan/floor/ceil/round/fix/sign` once phase 4 lands. |
| `test_scripts/tensors.m`        | complex tensor literal, complex Var disp, pass-to-func, complex+complex / complex+real / complex+scalar arithmetic.                           |
| `test_scripts/bracket_concat.m` | complex+real cells (real promotes).                                                                                                           |
| `test_scripts/owned.m`          | complex tensor scope-exit / early-free / lifecycle.                                                                                           |
| `test_scripts/mtimes.m`         | complex M*M / M*v / scalar variants.                                                                                                          |
| `test_scripts/indexing.m`       | complex scalar/slice read+write, real-base-complex-RHS rejection.                                                                             |
| `test_scripts/reducers.m`       | complex sum/prod/mean/min/max (default axis + explicit dim + 'all').                                                                          |
| `test_scripts/reshape_basics.m` | complex reshape Form A and Form B.                                                                                                            |
| `test_scripts/shape_misc.m`     | complex `.'` and complex `'` (the conj-transpose lowering).                                                                                   |
| `test_scripts/tensors_nd.m`     | complex N-D tensor disp + arithmetic + indexing.                                                                                              |
| `test_scripts/format_io.m`      | `fprintf("%g", complex)`, sprintf char/string with complex args.                                                                              |
| `test_scripts/functions.m`      | user function with complex arg and complex return type.                                                                                       |
| `test_scripts/handles.m`        | anonymous-handle capture of complex scalar / complex tensor.                                                                                  |
| `test_scripts/structs.m`        | struct field of complex type.                                                                                                                 |
| `test_scripts/classes.m`        | class property of complex type.                                                                                                               |

Only one new topic file is contemplated, `complex_tensors.m`, and
only if a pattern emerges in phase 2 that doesn't fit any existing
topic. First pass: don't add it.

Vitest unit tests:

- `tests/translate-complex-scalar.test.ts` (phase 1): emitted-C
  shape (`1.0 * I`, `mtoc2_cdiv(...)`, `cpow(...)`, comparison hoist).
- `tests/translate-complex-tensor.test.ts` (phase 2): tensor
  predeclaration, copy, free, disp routing.
- `tests/translate-complex-arith.test.ts` (phase 3): complex
  elemwise routing, broadcast variant selection, mtimes.
- `tests/translate-complex-index.test.ts` (phase 5): index store
  rejects complex-RHS into real-base; complex slice read/write.

Per the `CLAUDE.md` instruction "keep the test script count low,"
nothing in this plan adds a per-script entry; everything slots into
existing topic files via local-function subtests.

## 8. Cruft we are intentionally NOT carrying over from mtoc

1. **`normalizeComplexSign` post-pass.** We enforce
   `sign = "unknown"` at every factory site (`scalarComplex`,
   `numericTypeND`, etc.) and at the `arithResult` exit. No post-
   observation normalizer.
2. **`LibmComplexOpts` factory plumbing.** Per-builtin files declare
   their complex sibling inline.
3. **`complex(a, b)` constructor builtin.** Users write `a + b*1i`
   in source. (If a test script demands it, we revisit.)
4. **`ctranspose` runtime helper.** `'` on complex lowers to
   `transpose(conj(z))`.
5. **`cexpm1.h`, `clog1p.h`.** mtoc2 doesn't have `expm1` / `log1p`
   real builtins yet; their complex companions follow the real ones.
6. **`promoteOnDomainMiss` for `sqrt`.** `sqrt(-1)` continues to
   error (or return NaN, matching the current real-only behavior).
   The "lift to complex on domain miss" rule is a one-builtin
   special case; we add it later if a test script actually needs it.
7. **`tensor_ctranspose_complex.h`.** See (4).
8. **mtoc's per-feature `complex/*` subdirectory of test_scripts.**
   We slot complex tests next to real counterparts in the existing
   topic files.
9. **`StorageCategory` discriminator.** mtoc has a `StorageCategory`
   enum that distinguishes `scalar-complex` from `tensor-complex`
   etc. mtoc2's existing `isScalar(t)` / `isMultiElement(t)` plus
   `isComplex` covers the same dispatch — we don't need a new enum.

## 9. Open questions to confirm before coding

1. **Complex `exact` carrier shape for tensors.** Proposed:
   `{ re: Float64Array; im: Float64Array }`. Alternative: a single
   interleaved `Float64Array` of length `2 * n`. The former matches
   the runtime split-buffer layout and keeps the `Float64Array`
   semantic uniform with the real-tensor `exact`. Going with the
   former unless someone has a reason against.

2. **`fprintf("%d", complex)` — error or silently coerce?** Numbl
   coerces to real part and prints `%d`. mtoc's behavior:
   investigate. Default plan: match numbl (real-part coerce).

3. **`exact` on complex tensor literal — at what size limit?** Use
   the existing `EXACT_ARRAY_MAX_ELEMENTS` cap, counted on element
   count (not lane-doubled byte count).

4. **Hoisting non-Var complex sub-expressions in comparisons.**
   mtoc carries a `_mtoc_cx_N` temp counter for double-evaluation
   avoidance in `<`/`<=`/`>`/`>=` (which only need `creal`). We do
   the same — emit `double _Complex _mtoc2_cx_N = <expr>;` once and
   reference its `creal/cimag` twice. The counter sits on the
   codegen state alongside the existing ANF counter.

5. **Pretty-printer (`prettyIR.ts`) format for `ImagLit`?** Render
   as `<value>i` (matching the user's typed source). Decided —
   trivial.

## 10. Estimated landing cost

- Phase 1: ~25 files touched, ~5 new (incl. 3 runtime helpers + 4
  builtin files); ~250-400 LOC.
- Phase 2: ~10 files touched, ~6 new runtime helpers; ~300 LOC.
- Phase 3: ~5 files touched, ~3 new runtime helpers; ~250 LOC.
- Phase 4: ~17 files touched, ~17 new runtime helpers; ~300 LOC.
- Phase 5: ~5 files touched, 0 new runtime helpers; ~250 LOC.
- Phase 6: ~10 files touched, ~5 new runtime helpers; ~250 LOC.
- Phase 7: docs only; minimal LOC.

Total rough budget: ~75 files touched, ~35 new (mostly runtime
`.h` files), ~1500-2000 LOC across the phases, with cross-runner
green at every phase boundary.

Each phase is a candidate PR. Topic of each PR follows the phase
heading.

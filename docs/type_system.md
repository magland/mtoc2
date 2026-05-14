# Type system

mtoc2's type lattice lives in `src/lowering/types.ts`. Every scalar
(and small array) carries an optional `exact` field threaded through
the lowerer by every builtin's `transfer` function. The lattice is
**exact-aware** rather than exact-folding: knowing the value is the
most precise type and feeds two specific consumers, but the lowerer
does NOT substitute literals for runtime computations.

## Where `exact` is used

Two consumers, only:

1. **Function specialization**. The canonical type form includes
   `exact` (see `canonicalizeType` + the FNV-1a hash). So `sq(5)` and
   `sq(2.5)` produce two different specializations, each with its own
   exact-tagged param type. The body lowers under those refined types,
   which (combined with consumer #2) can statically take/drop
   branches.

2. **`if` / `elseif` cond folding**. When the cond expression's
   `ty.exact` is a finite `number`, the lowerer takes the matching
   branch and drops the rest — including any user-function calls the
   dropped arms would have triggered. This is the one place a known
   value short-circuits codegen.

`exact` does NOT cause:

- Substitution of `NumLit` for `Var` at Ident reads.
- Substitution of `NumLit` for a `Binary`/`Unary`/`Call` whose
  transfer returned an exact-tagged scalar.
- Substitution of a compile-time-formatted `fputs` for `disp(a)` when
  `a` is an exact tensor.
- Folding of `length(t)` / `numel(t)` / `sum(t)` to a literal — they
  emit runtime helper calls (with `1.0` as a literal special case
  when the C arg is a bare scalar `double`).

The C compiler does the runtime constant-folding work for arithmetic.
mtoc2 stays out of the way.

For specialization and if-cond folding to work without drift between
mtoc2 and numbl, the JS-side `transfer` of a builtin must produce the
same exact result numbl would produce at runtime. The cross-runner
enforces this byte-for-byte.

## Type variants

```ts
type Type = NumericType | StringType | UnknownType;
```

### NumericType

```ts
{
  kind: "Numeric";
  elem: "double" | "logical" | "char";
  isComplex: boolean;
  dims: DimInfo[];     // abstract lattice, one per axis
  shape?: number[];    // statically-known integer shape (when known)
  sign: Sign;
  exact?: NumericExact;
}
```

- `elem` is the underlying element type. Today's path uses `double`
  (and `logical` for comparison results).
- `isComplex` is a separate axis from `elem` so the lattice stays flat.
- `dims` is a per-axis lattice — `{kind: "one"}` (scalar along that
  axis), `{kind: "notOne"}` (length ≥ 2, statically known), or
  `{kind: "unknown"}`. Scalars carry `[{one}, {one}]`.
- `shape` is the statically-known integer shape when available
  (always set for exact tensors, and for scalars via the factories).
  Consistent with `dims`: `shape[i] === 1` ↔ `dims[i].kind === "one"`.
- `sign` is one of `positive | nonneg | negative | nonpositive | zero
| nonzero | unknown`. Coarser than exact but useful when exact isn't
  available (e.g. `unifySign("positive", "positive") === "positive"`).
- `exact` is the precise value, when known. See below.

### StringType

```ts
{ kind: "String"; exact?: string }
```

Atomic strings (MATLAB string scalars). Char arrays are a separate
shape that goes under `NumericType` with `elem: "char"`.

### UnknownType

Used at control-flow joins that can't be reconciled, and as the
return type of void builtins like `disp` (which the ExprStmt path
discards).

## The exact field

```ts
type NumericExact =
  | number // scalar real
  | { re: number; im: number } // scalar complex (reserved, not yet wired)
  | Float64Array; // dense real array, column-major
```

Arrays are capped by `EXACT_ARRAY_MAX_ELEMENTS` (256 today). A tensor
literal larger than the cap throws `UnsupportedConstruct` at lowering
time. The cap exists so canonical-type strings (used for function
specialization keys) stay bounded.

Tensor `exact` storage is **column-major** — same layout as numbl's
`RuntimeTensor.data`. For shape `[rows, cols]`, the flat index is
`c * rows + r`.

### Strict equality

Two exact values are considered "the same" iff `Object.is` returns
true on each component. That means `+0` and `-0` are distinct (matters
for sign), and `NaN` is never equal to itself. The `unify` path drops
`exact` whenever it can't prove the two sides agree.

### Sign is derivable from exact (but we keep both)

When `exact` is set, the sign is determined. But the lowerer still
populates `sign` so that **after** an op that loses exact (e.g. a
runtime-only call), downstream sites still have sign information to
work with.

## Inference flow

Two rules govern how types thread through the lowerer.

### 1. Control-flow joins drop exact (unless both sides agree)

After an `if`, the env from the then-arm and the env from the else-arm
are merged via `unify(a, b)` for each shared variable. `unify` keeps
`exact` only when:

- Both sides have it set, AND
- They are bit-identical (`numericExactsEqual` via `Object.is`), AND
- The result is still scalar.

Sign widens via `unifySign`. Element type and complex axis must match
or the result drops to `Unknown`.

The same `unify` runs on while/for joins (`envBefore` ∪ `envAfterBody`).

### 2. Loop-body mutations widen entry-state exact

This is the subtle one. Because the lowerer is one-pass, loop bodies
are lowered with the entry env unchanged. If `s = 0` is in env when we
enter `while ...; s = s + 1; end` and we don't widen, then every
transfer inside the body sees `s.ty.exact === 0`, and the resulting
function-call specializations and if-cond folds would freeze iteration-1
into the body forever.

The fix: before lowering the body, walk the body AST and collect every
name that gets assigned (`collectAssignedNames`). Strip `exact` from
each of those env entries (`stripExactFromEnv`). Now `s` is just a
non-exact scalar with `sign: nonneg`, and the body specializes its
function calls against `s` as a generic scalar and never folds an `if
s == 0` branch by accident.

`collectAssignedNames` recurses through `If`/`While`/`For`/`Switch`/
`TryCatch` so a deeply-nested mutation still triggers stripping at
the loop's top.

## Specialization keys

Function calls specialize per (canonicalized) input-type tuple.
`canonicalizeType` produces a stable JSON-ish string; `hashType`
folds it through FNV-1a to an 8-hex tag. The canonical form includes:

- elem, isComplex, dims (only the `kind`s), sign,
- `exact` **when set**.

So `sq(5)` and `sq(2.5)` produce two different specializations, each
with its own exact-tagged param type. The body lowers under the refined
types — and because the if-cond fold is the only place exact short-
circuits codegen, the practical effect of a per-exact-value spec is
that branches guarded on the input value disappear from the emitted
body. Arithmetic still emits as runtime C.

## What's not in the lattice yet

- **Logical as a distinct kind** — comparisons return `elem: "logical"`
  today, but in C they're still emitted as `double` (0.0 or 1.0). Once
  the codegen layer cares (e.g. for bit ops), this might split off.
- **Multiple outputs**. Functions are restricted to one output for now;
  the lattice would extend trivially with a tuple variant.
- **Struct fields, class instances, cells, function handles, sparse,
  dictionaries** — all live in numbl's RuntimeValue model but mtoc2
  hasn't grown the corresponding type-system entries yet. Add them
  when the lowering scope reaches them.

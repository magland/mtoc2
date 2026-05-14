# Type system

mtoc2's type lattice lives in `src/lowering/types.ts`. It's the most
distinctive subsystem in the codebase — the whole compiler is organized
around the **exact-value-first** idea: any scalar (and eventually any
small array) carries an optional `exact` field, and the lowerer treats
"I know this value" as the most precise type rather than a side
optimization.

## Why exact-first

A static compiler that doesn't know any values has to emit a runtime
call for every operation. A static compiler that knows the exact
values can just compute the answer at compile time and emit a literal.
That's the optimization story.

The deeper consequence is that **the compiler becomes a partial
interpreter**. When `sqrt(9)` shows up at compile time, the lowerer
runs the JS `Math.sqrt(9)` and emits `3.0`. When `sqrt(x)` with x of
unknown value shows up, it emits the runtime call. Same code path,
same builtin definition — the difference is whether the inputs
carried `exact`.

For this to work without drift, the JS-side evaluation of a builtin
must produce the same value numbl would produce at runtime. The
cross-runner enforces this byte-for-byte.

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

Three rules govern how types thread through the lowerer.

### 1. Scalar Ident reads substitute literals

When the lowerer looks up `x` in env and finds `ty.exact` is a
scalar-real `number`, it returns a `NumLit` IR node instead of a `Var`.
The C output then contains the literal value where the variable would
have appeared (`mtoc2_disp_double(5.0)` rather than
`mtoc2_disp_double(x)`), letting the C compiler constant-fold
downstream.

Tensor exact does NOT substitute at Ident-read sites — the runtime
variable holds the value (always-materialize), and downstream folding
still works because builtin `transfer` functions read `.exact` from
`argTypes` rather than from the IR node kind. So `b = a + 1` where
`a` has tensor exact still folds the elementwise add at compile time
(the transfer sees both operands' exacts), but `disp(a)` emits
`mtoc2_disp_tensor(a)` using the materialized variable — except that
disp's `codegenC` checks `argTypes[0].exact` and emits a compile-time
`fputs(...)` when the exact is known, ignoring the materialized
variable. Both paths are correct; the difference is whether the C
compiler or our lowerer does the constant work.

### 2. Control-flow joins drop exact (unless both sides agree)

After an `if`, the env from the then-arm and the env from the else-arm
are merged via `unify(a, b)` for each shared variable. `unify` keeps
`exact` only when:

- Both sides have it set, AND
- They are bit-identical (`numericExactsEqual` via `Object.is`), AND
- The result is still scalar.

Sign widens via `unifySign`. Element type and complex axis must match
or the result drops to `Unknown`.

The same `unify` runs on while/for joins (`envBefore` ∪ `envAfterBody`).

### 3. Loop-body mutations widen entry-state exact

This is the subtle one. Because the lowerer is one-pass, loop bodies
are lowered with the entry env unchanged. If `s = 0` is in env when we
enter `while ...; s = s + 1; end`, and we don't widen, then the body's
first read of `s` substitutes literal `0` and we emit `s = 0 + 1` —
baking iteration-1 into the body forever.

The fix: before lowering the body, walk the body AST and collect every
name that gets assigned (`collectAssignedNames`). Strip `exact` from
each of those env entries (`stripExactFromEnv`). Now `s` is just a
non-exact scalar with `sign: nonneg`, and the body emits a real
runtime add.

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
with its own exact-tagged param type. In the MVP this almost always
folds the function call site to a literal (since both inputs are
exact and the body only does exact-foldable operations), in which
case the call is replaced inline and the spec emits as dead code.

This will be more useful once we have ops that can't fold (runtime
math on unknown inputs) — the spec gives us sign-refined param types
to lean on in those bodies.

## What's not in the lattice yet

- **Runtime (non-exact) tensors**. Today only exact tensors live in
  the type system; a tensor whose values aren't known at compile time
  is rejected. The next big design step is the memory model for
  runtime tensors — at which point `exact` becomes an optimization
  fold on top of a general tensor representation.
- **Logical as a distinct kind** — comparisons return `elem: "logical"`
  today, but in C they're still emitted as `double` (0.0 or 1.0). Once
  the codegen layer cares (e.g. for bit ops), this might split off.
- **Multiple outputs**. Functions are restricted to one output for now;
  the lattice would extend trivially with a tuple variant.
- **Struct fields, class instances, cells, function handles, sparse,
  dictionaries** — all live in numbl's RuntimeValue model but mtoc2
  hasn't grown the corresponding type-system entries yet. Add them
  when the lowering scope reaches them.

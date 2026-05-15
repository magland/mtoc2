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
type Type =
  | NumericType
  | StringType
  | CharType
  | UnknownType
  | VoidType
  | HandleType
  | StructType
  | ClassType;
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

- `elem` and `isComplex` are independent axes (complex isn't yet
  wired through codegen).
- `dims` is a per-axis lattice — each axis is either `{kind:
"exact", value: n}` or `{kind: "unknown"}`. `shape` mirrors `dims`
  as a plain `number[]` when every axis is exact, for convenience.
  Both cap at `MTOC2_MAX_NDIM = 8` axes.
- `sign` ∈ `{ positive, nonneg, negative, nonpositive, zero,
  nonzero, unknown }` — coarser than exact but stays useful after
  ops that lose `exact`. Tensor sign is derived from the exact data
  when present (so `sqrt(zeros(N, N))` passes the domain check
  without needing a runtime branch); the `%!numbl:opaque` directive
  strips `exact` but leaves `sign` intact.
- `exact` is the precise value when known. See below.

### StringType

```ts
{ kind: "String"; exact?: string }
```

Atomic strings (MATLAB string scalars; `"foo"`). Owned, backed by
`mtoc2_string_t`. `length("foo") == 1`.

### CharType

```ts
{ kind: "Char"; exact?: string }
```

1×N row of bytes — the single-quoted (`'foo'`) MATLAB char-array.
Owned, backed by `mtoc2_char_tensor_t`. Distinct from `StringType`:
`length('foo') == 3`. Multi-row chars aren't constructable in v1, so
the type has no shape field — `exact.length` is the column count.

### UnknownType

Used at control-flow joins that can't be reconciled, and as the
return type of void builtins like `disp` (which the ExprStmt path
discards).

### HandleType

```ts
interface HandleType {
  kind: "Handle";
  targetName: string; // user-func name or synth "anon_<N>"
  ast: FunctionStmt; // target body for specialization
  captures: ReadonlyArray<{ name: string; ty: Type }>;
}
```

A function handle. `targetName + canonicalized captures` form the
canonical-string shard, so `apply(@foo, x)` and `apply(@bar, x)`
specialize separately. The `ast` rides on the type to feed
`specializeUserFunction` at every `h(args)` call site but is
intentionally excluded from `canonicalizeType` (it would bloat the
hash input).

`unify(a, b)` on handles is exact-match — two handles unify only
when their canonical forms agree; otherwise the join drops to
`UnknownType`. Captures may be scalar real numeric, tensor, struct,
class instance, or another handle. Handles are owned: each per-shape
C typedef ships with `_empty / _copy / _assign / _free`, so owned
capture fields (tensors, nested struct/class/handle) participate
transparently in the scope-exit-free / early-free lifecycle and snap
shot semantics fall out of the same deep-copy convention used for
struct fields. The typedef hash is keyed on
`(captureName, cFieldTypeStr(captureType))`, matching the struct/
class precedent: two handle types that differ only in lattice
precision share a single typedef. See [architecture.md](architecture.md)
(§ Function handles) for the lowering and codegen rules.

### StructType

```ts
interface StructType {
  kind: "Struct";
  fields: ReadonlyArray<{ name: string; ty: Type }>;
}
```

A struct value. Construct via `structType(fields)` so the field list
is sorted by name — two StructTypes with the same shape are
structurally identical regardless of source-level field-write
order. Each field type is normalized through `widenForStorage`
before being recorded, so per-field `sign` / `exact` differences
don't shard the typedef hash.

Structs are introduced by the `struct('f1', v1, ...)` literal — v1
does not auto-create a struct from a bare `s.x = v` assignment.
Once introduced, `s.f = rhs` writes to existing fields are accepted
as long as the rhs occupies the same C-level slot as the field
(`storageEquivalent`, which is `cFieldTypeStr(a) === cFieldTypeStr(b)`).
That accepts any tensor → tensor field, any scalar → scalar field,
or a matching struct/class typedef → its slot. The post-write internal
field type is the rhs's full internal type — env updates so subsequent
reads of `s.f` see the latest precision (sign, exact, tensor shape).

The typedef hash is keyed only on each field's `cFieldTypeStr`, so
writes that change a field's internal type (e.g. exact value, sign,
tensor shape) do NOT shard the typedef. C-type-stable / internal-type-
evolving is the contract: the C side stays uniform, the lattice keeps
threading precision through reads, transfer functions, and function
specialization keys.

Structs are owned. They participate in the predeclare-at-top /
scope-exit-free / early-free / ANF pipeline; the codegen emits one
program-level typedef per canonical shape, shipping the four
owned-kind helpers (`_empty`/`_assign`/`_copy`/`_free`) plus a
`_disp` helper for `disp(s)`.

### ClassType

```ts
interface ClassType {
  kind: "Class";
  className: string;
  properties: ReadonlyArray<{ name: string; ty: Type }>;
}
```

A class instance value. The `className` is the source-level
identifier from `classdef Foo`; `properties` is the canonical
(sorted-by-name) list of declared properties, each carrying the
precise type of its `properties` block default expression. The C
typedef hash uses `cFieldTypeStr` per property (one C-type string),
so the typedef stays stable as constructor / method writes refine
the internal property types through `unify`.

v1 forbids inheritance, handle classes, operator overloads,
`get.`/`set.` accessors, `Events`/`Enumeration`/`Arguments` blocks,
and class attributes — any of these surface at registration time
with `UnsupportedConstruct`. Methods must declare 0 or 1 outputs
(same as user functions). Constructor specialization pre-seeds
the receiver `obj` with the default-valued class instance before
the body lowers, so `obj.x = ...` writes into an already-initialized
slot.

Like structs, class instances are owned and program-emit one
typedef per shape with the four owned-kind helpers. `_disp` is
NOT generated for classes in v1; `disp(classInstance)` is
rejected at lowering.

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

### 3. Indexed writes widen the base's `sign`

A second stale-lattice trap: `x = zeros(1, 5)` enters env with
`sign = nonneg` (derived from the exact zero data), and an `x(3) =
-10` indexed write leaves the type's `sign` lattice unchanged even
though the runtime tensor now contains a negative element. Without
widening, a downstream `sqrt(x)` slips past `requireDomain` and
the emitted C silently produces `NaN` for that element, diverging
from numbl's complex result.

`widenAfterIndexedWrite` (in `types.ts`) handles this: after every
`IndexStore` / `IndexSliceStore` lowering, it drops the base's
`exact` and runs `unifySign(currentSign, rhsSign)`. Same-sign rhs
(e.g. `x(3) = 4` after `zeros(...)`) keeps the lattice tight;
opposite-sign or unknown rhs widens to `unknown`. The same hook
also clears `exact` on String env entries and recursively widens
nested struct/class fields via `withoutExact`.

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

- **Complex** — `isComplex` is reserved on `NumericType` but no
  codegen path wires it through. Builtins with no real-only result
  (e.g. `sqrt` of a negative) currently reject at translate.
- **Logical as a distinct kind** — comparisons carry `elem:
"logical"` but emit as `double` in C. Splitting it off would only
  matter once codegen cares (bit ops, packed storage, etc.).
- **Cells, sparse, dictionaries** — present in numbl's RuntimeValue
  model, absent here. Add when the lowering scope reaches them.

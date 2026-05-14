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

- `elem` is the underlying element type. Today's path uses `double`
  (and `logical` for comparison results).
- `isComplex` is a separate axis from `elem` so the lattice stays flat.
- `dims` is a per-axis lattice — each entry is either
  `{kind: "exact", value: n}` (the axis length is statically known to
  be the non-negative integer `n`) or `{kind: "unknown"}` (no static
  info). Scalars carry `[{exact, 1}, {exact, 1}]`. The convenience
  predicate `isDimOne(d)` covers the common "statically 1" check; call
  sites that need "definitely > 1" inline
  `d.kind === "exact" && d.value > 1`.
- `shape` is the statically-known integer shape when available
  (always set when every `dims[i]` is `exact`, and for scalars via the
  factories). When set, `shape[i]` equals `dims[i].value`.
- Both `dims` and `shape` are variable-length, capped at the same
  `MTOC2_MAX_NDIM = 8` axes that the C runtime allows. ND tensors
  (rank > 2) are constructed via the `zeros` / `ones` builtins;
  every other code path (assign / copy / free / elemwise / `disp` /
  `length` / `numel`) is shape-agnostic.
- `provablyNonEmpty(t: NumericType)` is the lattice-aware
  "definitely contains ≥ 1 element" predicate the reducer family
  uses to refine sign / exact bounds (empty `sum → 0`, `prod → 1`,
  `min/max → NaN`, etc.). True iff every `dims[i]` is `exact` with a
  positive value (equivalently: `shape` is concrete with no zeros).
  Scalars are always provably non-empty.
- `sign` is one of `positive | nonneg | negative | nonpositive | zero
| nonzero | unknown`. Coarser than exact but useful when exact isn't
  available (e.g. `unifySign("positive", "positive") === "positive"`).
  - On **scalars**, set by the factory (`scalarDouble(sign, exact?)`)
    or derived via `signFromNumber` at exact-fold sites.
  - On **tensors**, `tensorDouble(shape, exact?)` auto-derives the
    sign from the exact data via `signFromExactArray`: a literal like
    `[0 1 4 9]` carries `nonneg`, `[1 4 9]` carries `positive`, etc.
    Tensors without exact data inherit `unknown` unless the caller
    sets sign explicitly — the `zeros`/`ones` shape constructors do
    this for results too large to carry exact data, so domain checks
    like `sqrt(zeros(N, N))` succeed at translation time. The
    `%!numbl:opaque` directive only strips `exact`; the derived
    `sign` survives, so an opaque'd tensor that started life as
    `[1 2 3]` is still statically `positive`.
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
- **Multiple outputs**. Functions are restricted to 0 or 1 outputs for
  now (a 0-output call yields the `Void` type, valid only as an
  `ExprStmt` expression — see [architecture.md](architecture.md) for
  the lowering rule). The lattice would extend trivially with a tuple
  variant for multi-output.
- **Structs and class instances** ARE in the lattice now
  (`StructType` / `ClassType`) — both owned, both program-emit one
  typedef per canonical shape. v1 caveats: structs must be introduced
  via the `struct(...)` literal (no auto-create from `s.x = v`),
  class properties must declare a default-value expression, and
  classes have no inheritance / no operator overloads / no
  `get.`/`set.` accessors. See the `StructType` / `ClassType`
  sections above.
- **Cells, sparse, dictionaries** — all live in numbl's RuntimeValue
  model but mtoc2 hasn't grown the corresponding type-system entries
  yet. Add them when the lowering scope reaches them.
- **Function handles** ARE in the lattice (`HandleType`) — for any
  user-function target, with captures of any non-String / non-Void
  type (scalar real numeric, tensor, struct, class instance, or
  another handle). See [architecture.md](architecture.md) for the
  static-dispatch model and the codegen rule that emits one C typedef
  plus owned-helpers per distinct capture-shape.
  `canonicalizeType` for handles shards on `(targetName, captures)` so
  higher-order calls like `apply(@foo, x)` vs `apply(@bar, x)` produce
  distinct specializations. Builtin handles (`@disp`) and capture-
  shape unification across CFG joins are not yet supported and produce
  span-carrying lowering errors.

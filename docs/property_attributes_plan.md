# Property-block attributes — plan

**Status:** Landed (phases A, B, C). Subsequent edits to this doc
should track follow-up work (storage-backed accessors, recursion
guard, multi-output accessors, etc.) rather than rewriting the
landed semantics.

This was the end-to-end gap surfaced by the chunkie driver
(see [chunkie_plan.md](chunkie_plan.md)). Running
`tmp/chunkie_ex01_circle.m` through the interpreter failed at
workspace-build time with
`'properties' block attributes are not supported in v1`, because
`@chunker/chunker.m` declares several `properties(...)` blocks with
attributes: `Access`, `SetAccess`, `Hidden`, and — the only one
with real semantics — `Dependent`.

The doc is the property-block-attributes equivalent of
[cells_plan.md](cells_plan.md): scope, the numbl behavior we are
matching, and a phase plan that lands the feature in cross-runner-
green increments.

## 1. Goals

- Class definitions can declare `properties(<attr>=<v>, ...)` blocks
  for the attribute set chunker uses. Reads and writes behave the
  way numbl behaves — including `Dependent` properties that route
  through `get.<prop>` / `set.<prop>` accessor methods.
- Accessor methods (`function val = get.X(obj)` and
  `function obj = set.X(obj, val)`) parse and lower in all three
  backends. They are stored separately from ordinary methods so
  `obj.X` dispatch can find them at lowering time.
- After this phase, `@chunker/chunker.m` builds in the workspace
  and the chunkie driver moves on to the next concrete blocker.
- Cross-runner stays byte-for-byte aligned with numbl across every
  topic subtest the phase adds.

Non-goals (this milestone):

- **Class-level attributes** (`classdef (Abstract) Foo`,
  `classdef (Sealed) Foo`, `classdef (InferiorClasses=...) Foo`,
  etc.). chunker has none; defer until the next chunkie subclass
  surfaces them.
- **Inheritance** (`classdef Foo < Bar`). Still rejected.
- **`Constant` properties** (compile-time value, no per-instance
  storage). chunker has none; defer.
- **`Abstract` / `Transient` / `NonCopyable` / `Observable`
  property attributes.** chunker has none; reject explicitly.
- **Visibility enforcement.** mtoc2 doesn't enforce `Access` /
  `GetAccess` / `SetAccess` / `Hidden` — these attributes are
  accepted silently and have no effect on dispatch. Matches
  numbl's posture (`extractClassInfo` ignores them too) and lines
  up with mtoc2's single-program scope (one user's code, no
  external consumers to defend against).
- **`get.X` / `set.X` in an external method file**
  (`@Cls/get.X.m`). MATLAB itself doesn't allow this — accessor
  methods must live in the classdef. We follow that.
- **Recursion guard inside accessors.** Numbl carries a runtime
  `activeAccessors` set so a getter that re-reads its own property
  doesn't infinitely recurse. chunker's accessors never do this
  (they read backing storage fields like `obj.rstor`), so we don't
  ship a guard in v1. Document as a limitation; revisit if a real
  program needs it.
- **Multi-output accessors.** `get.X` returns one value; `set.X`
  returns one value (the modified object). Multi-output accessors
  are rejected (matches the existing 0/1-output method rule).
- **Storage-backed properties with a paired accessor.** Numbl
  allows non-`Dependent` properties to declare a `get.X` / `set.X`
  and routes the access through them anyway. chunker doesn't use
  this; v1 only ships accessor routing for `Dependent` properties
  (which by definition have no storage). If a future program
  needs the storage-backed accessor pattern, lift the same
  dispatch rule to all properties — the routing logic is the
  same; only the type-system bookkeeping changes.

## 2. What numbl does — the spec

Numbl's behavior (read
[`runtime/runtimeMemberAccess.ts`](../../numbl/src/numbl-core/runtime/runtimeMemberAccess.ts)
and
[`lowering/classInfo.ts`](../../numbl/src/numbl-core/lowering/classInfo.ts)
for the authoritative implementation):

- **Property attributes silently ignored**: `Access`, `GetAccess`,
  `SetAccess`, `Hidden`. No effect on storage, dispatch, or
  visibility.
- **`Dependent` property**: skipped from `propertyNames` /
  `propertyDefaults` entirely (`classInfo.ts:57`) — no storage
  allocated. Reads route through a `get.<prop>` method; writes
  route through a `set.<prop>` method. Inside the accessor body
  the user reads/writes backing storage fields (e.g. `obj.rstor`).
- **`get.<prop>` / `set.<prop>` method dispatch**: on read,
  numbl's `getMember` checks the class for a `get.<prop>` method
  first; if present, calls it as `getter(1, base)` and returns the
  result. On write, `setMemberReturn` checks for `set.<prop>` and
  calls it as `setter(1, base, rhs)`, treating the return as the
  new instance value.
- **Method body shape** (from chunker):
  ```
  function r = get.r(obj)
      r = obj.rstor(:,:,1:obj.nch);
  end
  function obj = set.r(obj, val)
      obj.rstor(:,:,1:obj.nch) = val;
  end
  ```
  i.e. ordinary single-output functions whose declared name has a
  `get.` / `set.` prefix.

## 3. Type system — minimal changes

The current `ClassRegistration` ([classDefs.ts](../src/lowering/classDefs.ts))
keys properties by name and stores their type. Two structural
extensions:

- **`dependentProperties: Set<string>`** on `ClassRegistration`.
  Listed in declaration order on `propertyNames` (so dispatch can
  look them up by name), but **not** materialized as fields on the
  resulting `ClassType` — i.e. they don't get a C struct slot, a JS
  field, or an interpreter `fields` entry. The type of a
  dependent-property read comes from specializing the matching
  getter at the call site, not from a pre-registered slot type.
- **`getters: Map<string, FuncStmt>`** and
  **`setters: Map<string, FuncStmt>`** on `ClassRegistration`.
  Keyed by the _property_ name (stripping the `get.` / `set.`
  prefix). Accessors are validated the same way as ordinary methods
  (0/1-output for `get.X`, exactly one output for `set.X`, no
  static-block declaration). They are **not** added to `methods`
  — `obj.foo()` should not find `get.foo` as if it were a regular
  method.

The `ClassType.properties` array only contains _storage-backed_
properties. Hash keys, typedef shape, and field iteration all
already work off this array — once dependent properties are
excluded, no downstream code needs to change.

## 4. Dispatch — three backends, one rule

The routing rule at any read / write site:

- **Read `obj.X`**: if the class registration has an entry for
  `X` in `getters`, emit a single-output call
  `Xval = get.X(obj)` and use `Xval` in place of the field load.
  Otherwise emit the existing `MemberLoad`.
- **Write `obj.X = rhs`**: if the class registration has an entry
  for `X` in `setters`, emit `obj = set.X(obj, rhs)` (a single-
  output method call returning self, of the same shape mtoc2
  already supports for `obj = obj.method(args)`). Otherwise emit
  the existing `MemberStore`.
- **Member-rooted indexed access `obj.X(args)`**: if a getter
  exists for `X`, the getter call replaces the
  pre-existing field-load-then-index path: lower
  `tmp = get.X(obj)` then run the standard index lowering on
  `tmp`. If a setter exists, **reject** indexed writes to a
  dependent property for v1 (`obj.X(args) = rhs` — would need to
  invoke `get.X`, splice, then `set.X`; chunker doesn't use
  this pattern). Defer with a clear `UnsupportedConstruct`.

The decision is made at lowering time, since the class is
statically known. The IR shape that comes out of lowering is a
plain method call — no new IR node is required. All three backends
already lower / emit / execute method calls.

### Per-backend wiring

- **Lowerer** (`lowerMember.ts`, `lowerAssignLValue.ts`,
  `lowerMethodCall.ts`):
  - `lowerMember` (member read): before emitting `MemberLoad`,
    consult `classReg(cls).getters`. If present, build a method
    call against the getter and return its result.
  - `lowerAssignLValue` (member write): before emitting
    `MemberStore`, consult `classReg(cls).setters`. If present,
    emit the call-returning-self pattern.
  - `lowerMemberRootedIndex`: same getter check; replace the
    field-load temp with the getter-call result.
- **Interpreter** (`interpExec.ts` member load / store paths):
  mirror numbl's `getMember` / `setMemberReturn` — check the
  class's `getters` / `setters` map before reading / writing
  the backing struct. No recursion guard in v1 (see non-goals).
- **JS-AOT / C-AOT**: the lowerer already produced a `Call`. The
  emitters render method calls today; no new emission paths.

## 5. Tests

Topic files exercise the feature surface (not just the chunker
slice). Add subtests inline in `test_scripts/classes.m` rather
than introducing a new top-level script — keeps the cross-runner
process count down.

Cases the topic-file additions must cover:

- Property block with `Access`, `GetAccess`, `SetAccess`, `Hidden`
  attributes — pass-through semantics. Read / write the property
  as if the attribute weren't there. Verify storage works.
- `Dependent` property with a getter that reads a backing field.
  `obj.X` returns the computed value.
- `Dependent` property with a getter AND setter. `obj.X = rhs`
  invokes the setter, which writes the backing field; subsequent
  reads of `obj.X` observe the new value.
- Multiple dependent properties on one class (covering the
  classRegistration map shape).
- A getter that calls another method on `obj` (covering nested
  method dispatch from inside an accessor).
- Member-rooted indexed read on a dependent property:
  `obj.X(i, j)` should compute `tmp = get.X(obj)` then `tmp(i, j)`.
- A class with `properties(Dependent)` and no defaults on the
  dependent properties (the `pendingProperties` check must not
  fire on them, since they have no storage to initialize).
- **Rejected** cases (each raises a clean `UnsupportedConstruct`):
  - `properties(Constant)` — explicit rejection.
  - `properties(Abstract)` — explicit rejection.
  - `obj.X(args) = rhs` where `X` is dependent — explicit
    rejection.
  - `function [a, b] = get.X(obj)` — multi-output getter rejection
    (already covered by the existing 0/1-output method rule;
    just verify the message is sensible).

## 6. Phased landing

Each phase is its own commit, cross-runner green at the boundary.

### Phase A — pass-through attributes

Accept the four attributes that don't affect semantics (`Access`,
`GetAccess`, `SetAccess`, `Hidden`) in
`registerClassDef`'s property-block branch. Reject everything else
(`Dependent` still rejected here — explicit, with a "phase B" hint
message). Pure parse-tolerance change; no IR or codegen impact.

Test additions in `test_scripts/classes.m`: a class with a private
property that's still readable and writable from outside.

After phase A: re-run the chunkie driver. Expected new failure
point is `Dependent` rejection on chunker's first `properties
(Dependent, ...)` block.

### Phase B — `Dependent` properties + `get.` / `set.` accessors

Two related changes that ship together because they're useless
apart:

1. **`classDefs.ts`**: accept `Dependent` as a property-block
   attribute. Properties in a `Dependent` block:
   - Add to `propertyNames` (so name collisions still trip the
     dup-property error).
   - Add to a new `dependentProperties: Set<string>` on
     `ClassRegistration`.
   - Do **not** add to `propsWithDefault` / `pendingProperties` —
     they have no storage. Defaults on `Dependent` properties are
     rejected (MATLAB doesn't allow them either).
   - Adjust the "no constructor for a class with pending properties"
     check: dependent properties don't count.
2. **Accessor methods**: relax the `get./set.` rejection in
   `classDefs.ts:196`. When the method's name starts with
   `get.<X>`, validate that `X` is declared in some
   `properties(...)` block of this class (whether dependent or
   storage-backed — extra rule for storage-backed is "no-op routing
   in v1"; only dependent properties consult the getter). Same for
   `set.<X>`. Validate output arity: `get.X` must declare one
   output; `set.X` must declare exactly one output (the modified
   object) and exactly two inputs (`obj, rhs`). Store on
   `ClassRegistration.getters` / `.setters`, keyed by `X`.
3. **Lowering / interpreter**: add the getter / setter routing per
   §4 in every read / write site that consults the class
   registration. The lowered IR is a plain `Call`; codegen needs no
   change.

Test additions in `test_scripts/classes.m`: getter + setter on the
same dependent property, getter-only, multiple dependent
properties.

After phase B: re-run the chunkie driver. Expected to either
clear `@chunker/chunker.m` outright or surface the next concrete
gap (some chunker method body using a v1-unsupported construct).

### Phase C — member-rooted indexed read on a dependent property

`obj.X(i, j)` where `X` is dependent. The existing
`lowerMemberRootedIndex` path loads the field into a temp, then
indexes the temp. For dependent properties, the load is replaced by
a getter call. Pure lowerer change.

Indexed _write_ to a dependent property
(`obj.X(i, j) = rhs`) remains rejected.

Test additions: a getter that returns a 3-D array, indexed at the
call site.

After phase C: chunker's own use of dependent properties
(`chnkr.r(:,:,j)`) lowers correctly. The next chunkie blocker is
likely inside `chunkerfunc.m` itself.

## 7. Out-of-scope edge cases (document in commit msg)

- Recursive accessor (`get.X` body that reads `obj.X`): infinite
  recursion at runtime — we don't guard. User error.
- Accessor that reads a not-yet-initialized backing field: same as
  the existing first-write-infers-type rule on storage-backed
  properties. If the getter is called before the constructor writes
  the backing field, the read fails the same way an ordinary
  pre-init read would.
- `set.X` that doesn't actually assign `obj` (e.g. just throws an
  error): supported transparently — the setter's return is whatever
  the method body returns, and the caller's `obj = set.X(obj, rhs)`
  pattern handles it like any other method-returning-self call.

## 8. Acceptance gate for the phase

A change is "done" when:

- `npx tsc` clean.
- `npx tsx scripts/run_test_scripts.ts` green (the new subtests
  byte-match numbl).
- `npx tsx scripts/run_test_scripts_all_modes.ts` green (all three
  backends; xfail directives only used if a genuine backend gap
  exists, not for "I didn't finish wiring this backend yet").
- `npx vitest run`, `npm run lint`, `npm run format:check` clean.
- The chunkie driver advances past
  `'properties' block attributes are not supported in v1` — the
  next failure (if any) is concretely identified in the phase
  commit message.

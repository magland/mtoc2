# Plan: multi-output user functions with tensor (and other owned) returns

**Status:** unstarted. The current N≥2-output ABI is wired but
restricted to scalar real numeric output slots; this slope lifts that
restriction to cover **multi-element tensors**, **structs**, **class
instances**, and **handles** — every type `isOwned` returns `true`
for. Unblocks `lege.polsum`, `lege.rts_stab`, and the rest of
`chunkie_simple/+lege/`.

## Goal

After this slope, a user function declared as

```matlab
function [pol, der, tot] = polsum(xs, n)
  ...
  pol = ...;       % some 2-D or N-D tensor
  der = ...;       % tensor
  tot = ...;       % tensor
end
```

can be called as

```matlab
[pol, der, tot] = lege.polsum(xs, n);
[~, ~, tot]     = lege.polsum(xs, n);   % ignore the first two
[pol, der]      = lege.polsum(xs, n);   % drop trailing — relies on the
                                        % `nargout` fold to skip the
                                        % `if nargout >= 3` body
```

and produce byte-for-byte stdout parity with numbl on every script the
cross-runner exercises. The owned-value lifecycle holds: the caller's
output slots are pre-declared `_empty()` and freed at scope exit; the
callee transfers ownership at function exit and skips its own
scope-exit free for output locals.

**Out of scope:**

- 0/1-output functions returning tensor / struct / class. Those
  already work via the single-output return-by-value ABI; nothing
  changes there.
- Expression-context call sites for multi-output functions
  (`x = polsum(xs, n)` calling a 3-output `polsum`). Numbl supports
  this via nargout=1; mtoc2 v1 keeps the existing rejection. The
  `nargout` slope already lets the caller call `[a] = f(...)` which
  specializes the callee for nargout=1, so the simulator pattern
  `[~,~,tot] = f(...)` is the documented escape hatch.
- Out-of-order or partial output reads (numbl's `varargout` /
  `nargout < N` skip-trailing optimization). The callee MUST assign
  every output slot it declares; rejected at lowering via the
  existing "output X was never assigned" check.

## What's already in place

The scaffolding for this slope was put in deliberately during the
scalar-multi-output work — every comment in the codebase that begins
_"(Unreachable in v1; for the future-tensor-output extension.)"_ is a
hook that flips on when the lowering check is relaxed.

- **IR — `MultiAssignCall` already carries the right shape.**
  `outputs: ReadonlyArray<{ ty: Type; binding: { name; cName } | null }>`
  has no scalar-only assumption (see
  [src/lowering/ir.ts](../../src/lowering/ir.ts) line ~380). The
  binding's `cName` and `ty` are everything codegen needs.

- **Caller-side discard temps** for `null` bindings already branch on
  `isOwned(slot.ty)` and emit `<helpers>.empty()` / `<helpers>.free()`
  around the call (`emit.ts` ~line 870, 893). Currently latent —
  flips on when the lowerer permits owned slots.

- **`collectOwnedLocals`** walks `MultiAssignCall.outputs` and adds
  owned-bound slots to the function-top declaration list
  (`emit.ts` ~line 420). Already structurally correct; just inert
  today.

- **Liveness — `topLevelOwnedDefs`** treats each owned-bound slot as
  an owned `Assign` for early-free and `nullAtScopeExit` purposes
  (`liveness.ts` ~line 85). Already complete.

- **`recordAssignment`** allocates the slot binding's `cName` and
  registers it in env with the slot's `ty` — owned or scalar makes
  no structural difference (lower.ts ~line 950–968).

- **`nargout`** is now a per-specialization compile-time constant.
  When the caller writes `[a, b] = polsum(xs)`, the callee's
  `nargout` folds to 2 — the `if nargout >= 3` body is dead and gets
  eliminated by the existing if-cond fold path. This means the
  callee can ALREADY produce the right number of output values per
  caller pattern; only the C ABI plumbing for tensor outputs is
  missing.

The two restrictions that need to fall:

1. **Lowering side** — the per-slot scalar check in
   `lowerMultiAssign` (`lower.ts` ~line 936). Today:

   ```ts
   if (!isScalarRealNumeric(slotTy)) {
     throw new UnsupportedConstruct(
       `multi-output function '${callName}': output ` +
         `'${fnAst.outputs[i]}' has type ${typeToString(slotTy)}; ` +
         `only scalar real numeric outputs are supported for ` +
         `multi-output functions`,
       s.span
     );
   }
   ```

   Lift this to allow any value-typed slot. Void / Unknown / String
   stay rejected (no C representation that fits the sret slot).

2. **Codegen side** — the defensive guard in `emit.ts`'s
   `emitFunction` (~line 607):

   ```ts
   if (isMulti) {
     for (let i = 0; i < nOutputs; i++) {
       if (isOwned(fn.outputTypes[i])) {
         throw new Error(
           `internal: multi-output owned slot at index ${i} of '${fn.name}' — codegen does not yet transfer ownership for N≥2 outputs (would double-free at scope exit)`
         );
       }
       lines.push(`  *_mtoc2_o${i} = ${fn.cOutputs[i]};`);
     }
   }
   ```

   Replace with the ownership-transfer path described below.

## The ABI change in one paragraph

For a multi-output user function with declared outputs `[o1, …, oN]`:

- Caller pre-declares each owned-typed `oi` local via the kind's
  `_empty()` helper (already done by `collectOwnedLocals`).
- Caller passes `&oi_local` for each named slot and
  `&_mtoc2_discard_<callIdx>_<i>` for each `~` slot (already done).
- Callee writes each output via the kind's `_assign` helper:
  `mtoc2_tensor_assign(_mtoc2_o<i>, <local>)`. The helper frees the
  destination's prior contents (always NULL on a freshly-empty slot
  — but a reassignment-of-the-same-output across iterations of a
  for-loop wraps this is what makes `_assign` the right helper).
  After the assign, the callee's `<local>` is treated as **moved-out**:
  its scope-exit free is skipped (the buffer pointers now live in
  `*_mtoc2_o<i>`).
- Scope-exit free skip is gated on `outputCNames` for the multi-
  output case (mirrors the single-output `if (nOutputs === 1 &&
o.cName === fn.cOutputs[0]) continue;` rule).

That's it. Owned struct/class/handle outputs follow the same shape
through their kind's `_assign` helper — `ownedHelpersFor(ty)` already
covers every owned kind in mtoc2.

## Edge cases worth calling out

- **`future-touch` analysis at body end.** The single-output path
  passes `ownedOutput = { cName, ty }` to `computeFutureTouches` so
  the return-statement-equivalent is treated as a use of the output,
  preventing a stray early-free of the to-be-returned buffer. The
  multi-output path needs the same treatment for **every** owned
  output (`liveness.ts` line ~205-235). Change the API from
  `ownedOutput: { cName, ty } | null` to
  `ownedOutputCNames: ReadonlyArray<string>` (treat each as a
  touch at body end).

- **Reassignment-of-output inside the body.** `pol = xs; pol = pol * 2;`
  is two `mtoc2_tensor_assign` calls into the local. The local's
  prior buffer is freed by the second assign; only the final buffer
  survives. After the body, the sret write transfers exactly that
  final buffer. Existing Assign codegen handles this — no change.

- **Output written inside a loop.** Same as above; the loop's last
  iteration's `_assign` leaves the local in its final state and the
  prior-iteration buffer was freed by the helper.

- **Output written inside a branch.** `mergeBranchEnvs` already
  unifies the output's type across branches. If one arm doesn't
  write the output, the "output never assigned" check fires at
  function-spec time (same as today). The MATLAB semantics of
  "output is undefined if the branch that defined it didn't fire"
  isn't supported in mtoc2 v1 — same restriction as scalars today.

- **Reassignment-of-output across a discard temp.** Calling
  `[~, ~, tot] = polsum(xs, n)` twice in a row: the first call's
  discard temps allocate fresh storage and free at the call block's
  closing brace (existing emission). No persistent state, no
  reassignment hazard.

- **The callee's output local appearing on the RHS of another
  expression late in the body.** E.g. `der = pol * 2;`. With the
  body-end-future-touch seeding fixed (above), both `pol` and `der`
  stay alive through the body. The early-free analysis won't touch
  them.

- **Function calls itself recursively?** Not yet supported per
  `specializeUserFunction`'s placeholder mechanism; recursion is a
  separate slope and orthogonal to this one.

- **Handle / struct / class outputs.** The same `_assign` pattern
  works for every owned kind. The struct/class case has the same
  buffer-aliasing concern (the typedef-shape struct holds owned
  fields like tensors; copy + free dance is in
  `<typedef>_assign` / `<typedef>_free`). No new runtime helpers
  needed — every owned kind already ships with `_empty / _copy /
_assign / _free` via `ownedHelpersFor`.

## Phases

### Phase 1 — lift the lowering restriction

In [src/lowering/lower.ts](../../src/lowering/lower.ts)
(`lowerMultiAssign`, around line 936): replace the
`!isScalarRealNumeric` check with a permissive check that accepts
any value-typed slot:

```ts
// Accept scalar real numeric, owned types (tensor / struct / class /
// handle), or anything `isValueSlot` recognizes. Void / Unknown /
// String stay rejected (no C representation that fits the sret).
if (!isMultiOutputSlotType(slotTy)) {
  throw new UnsupportedConstruct(
    `multi-output function '${callName}': output ` +
      `'${fnAst.outputs[i]}' has type ${typeToString(slotTy)}; ` +
      `this type isn't supported in a multi-output slot yet`,
    s.span
  );
}
```

Define `isMultiOutputSlotType` in `types.ts`:

```ts
export function isMultiOutputSlotType(t: Type): boolean {
  if (isScalarRealNumeric(t)) return true;
  if (isOwned(t)) return true; // tensor / struct / class / handle
  return false;
}
```

No other lowering change needed. The `recordAssignment` /
binding-cName allocation path is type-agnostic.

### Phase 2 — extend the future-touch analysis

In [src/codegen/liveness.ts](../../src/codegen/liveness.ts):

- Change `computeFutureTouches`'s signature from
  `ownedOutput: { cName: string; ty: Type } | null` to
  `ownedOutputs: ReadonlyArray<{ cName: string; ty: Type }>` — array
  of zero-or-more owned outputs. Seed `bodyEnd` with every entry's
  cName.
- Adjust `TouchCtx.ownedOutputCName` similarly (rename to
  `ownedOutputCNames: ReadonlySet<string>`).
- Adjust the one call site in `emitFunction` to pass either an
  empty array (scalar / void / single-non-owned-output cases) or
  the full owned-output list.

### Phase 3 — codegen the sret transfer

In [src/codegen/emit.ts](../../src/codegen/emit.ts)'s `emitFunction`
(line ~607–615):

Replace the throw-on-owned-slot guard with the ownership-transfer
emission. The transfer uses the owned kind's `_assign` helper so
the destination's prior contents are released (NULL → no-op on
fresh slots; matters only when the caller reuses the local across
calls — see the edge-cases section). Each output local then becomes
moved-out and its scope-exit free is skipped.

```ts
if (isMulti) {
  // Output writes: scalar slots → bare struct copy; owned slots →
  // ownership transfer via the kind's `_assign` helper. After the
  // assign, the callee's local is moved-out; its scope-exit free is
  // suppressed below (see `transferredOutputCNames`).
  for (let i = 0; i < nOutputs; i++) {
    const outTy = fn.outputTypes[i];
    if (isOwned(outTy)) {
      activateOwnedRuntime(outTy, state);
      const h = ownedHelpersFor(outTy);
      lines.push(`  ${h.assign}(_mtoc2_o${i}, ${fn.cOutputs[i]});`);
    } else {
      lines.push(`  *_mtoc2_o${i} = ${fn.cOutputs[i]};`);
    }
  }
}
```

And in the scope-exit free walk a few lines below, add a skip for
output cNames in the multi-output case (the analog of the
`nOutputs === 1` skip):

```ts
for (const o of [...owned, ...ownedParams]) {
  if (fnNullAtExit.has(o.cName)) continue;
  if (nOutputs === 1 && o.cName === fn.cOutputs[0]) continue;
  // NEW: multi-output transferred-ownership outputs are moved-out
  // by the sret writes above; their scope-exit free would double-
  // free what the caller now owns.
  if (isMulti && outputCNames.has(o.cName)) continue;
  // ... existing free emission ...
}
```

### Phase 4 — tests

Add **two** test scripts:

#### `test_scripts/multi_output_tensor.m`

Cross-runner script exercising the typical patterns:

```matlab
test_two_tensor_outputs_simple();
test_three_tensor_outputs();
test_discard_first_output();
test_discard_middle_outputs();
test_partial_dropping_via_nargout();
test_reassign_outputs_in_body();
test_outputs_written_in_branch();
test_outputs_written_in_loop();
test_nested_multi_output();
test_mixed_scalar_and_tensor_outputs();

function test_two_tensor_outputs_simple()
  [a, b] = swap_double([1 2 3], [4 5 6]);
  disp(a);
  disp(b);
end

function test_three_tensor_outputs()
  [p, d, t] = compute_pdt(4);
  disp(p);
  disp(d);
  disp(t);
end

function test_discard_first_output()
  [~, d] = swap_double([1 2 3], [4 5 6]);
  disp(d);
end

function test_discard_middle_outputs()
  [a, ~, t] = compute_pdt(4);
  disp(a);
  disp(t);
end

function test_partial_dropping_via_nargout()
  % Calls compute_pdt with only 2 lvalues. The `nargout` fold in
  % its body skips the third-output computation. Spec key shards
  % per nargout, so this is a distinct specialization from the
  % 3-lvalue site above.
  [p, d] = compute_pdt(4);
  disp(p);
  disp(d);
end

function test_reassign_outputs_in_body()
  [a, b] = reassign_in_body(3);
  disp(a);
  disp(b);
end

function test_outputs_written_in_branch()
  [a, b] = branch_writes(5);
  disp(a);
  disp(b);
  [c, d] = branch_writes(-5);
  disp(c);
  disp(d);
end

function test_outputs_written_in_loop()
  [a, b] = loop_writes(3);
  disp(a);
  disp(b);
end

function test_nested_multi_output()
  % Outer function uses an inner multi-output call.
  [r, s] = nested_caller(4);
  disp(r);
  disp(s);
end

function test_mixed_scalar_and_tensor_outputs()
  [k, v] = mixed_outputs(7);
  disp(k);
  disp(v);
end

% — helpers

function [a, b] = swap_double(x, y)
  a = y;
  b = x;
end

function [pol, der, tot] = compute_pdt(n)
  pol = ones(1, n);
  der = zeros(1, n);
  for k = 1:n
    pol(k) = k;
    der(k) = k * 2;
  end
  if nargout >= 3
    tot = pol + der;
  else
    tot = zeros(1, n);
  end
end

function [a, b] = reassign_in_body(n)
  a = ones(1, n);
  a = a + 1;
  a = a .* 3;
  b = zeros(1, n);
  for k = 1:n
    b(k) = a(k) + 10;
  end
end

function [a, b] = branch_writes(x)
  if x > 0
    a = [1 2 3];
    b = [4 5 6];
  else
    a = [-1 -2 -3];
    b = [-4 -5 -6];
  end
end

function [a, b] = loop_writes(n)
  a = zeros(1, n);
  b = zeros(1, n);
  for k = 1:n
    a = a + k;
    b = b * 2 + 1;
  end
end

function [r, s] = nested_caller(n)
  [r, s] = swap_double(ones(1, n), ones(1, n) * 2);
end

function [k, v] = mixed_outputs(n)
  k = n + 1;          % scalar
  v = ones(1, n);     % tensor
end
```

#### `test_scripts/multi_output_struct.m`

A smaller script that just exercises struct-typed outputs:

```matlab
test_struct_outputs();
test_struct_with_tensor_field();

function test_struct_outputs()
  [s1, s2] = make_two_structs(3, 4);
  disp(s1.x);
  disp(s2.y);
end

function test_struct_with_tensor_field()
  [bag, total] = make_bag([1 2 3 4 5]);
  disp(bag.data);
  disp(total);
end

function [a, b] = make_two_structs(x, y)
  a = struct('x', x);
  b = struct('y', y);
end

function [b, t] = make_bag(d)
  b = struct('data', d);
  t = sum(d);
end
```

These cover the non-tensor owned-kind paths (struct, by extension
class instances and handles when their lifecycles are exercised
similarly).

### Phase 5 — verify with chunkie_simple/+lege

Drop-in test (NOT cross-runner; vitest or a manual smoke run):

```bash
mkdir -p /tmp/lege_test
cp -r chunkie_simple/+lege /tmp/lege_test/
cat > /tmp/lege_test/main.m <<EOF
[x, w, u, v] = lege.exps(4);
disp(x);
disp(w);
EOF
npx tsx src/cli.ts run /tmp/lege_test/main.m
```

After this slope this should run cleanly. If it doesn't, the next
blocker surfaces — almost certainly something in `+lege/rts_stab.m`
or `+lege/polsum.m` that the lege code uses but mtoc2 hasn't built
yet (likely member-rooted indexing or a missing scalar builtin).

## Acceptance criteria

```
npx tsc
npm run lint
npm run format:check
npx tsx scripts/run_test_scripts.ts
```

stays green. Both new test scripts cross-run byte-for-byte with
numbl. The chunkie_simple lege smoke from Phase 5 runs cleanly.

Manual spot-check: compile a `[pol, der, tot] = polsum(xs, n)` call
and inspect the emitted C. The callee should end with:

```c
  mtoc2_tensor_assign(_mtoc2_o0, pol);
  mtoc2_tensor_assign(_mtoc2_o1, der);
  mtoc2_tensor_assign(_mtoc2_o2, tot);
  return;
```

with no `mtoc2_tensor_free(&pol)` / `_free(&der)` / `_free(&tot)`
on the path (those locals are now moved-out). Owned **non-output**
locals in the same function should still be freed at scope exit.

The caller-side should look like:

```c
{
  mtoc2_tensor_t pol = mtoc2_tensor_empty();   /* pre-declared at function top */
  mtoc2_tensor_t der = mtoc2_tensor_empty();
  mtoc2_tensor_t tot = mtoc2_tensor_empty();
  polsum__<hex>(xs_copy, n, &pol, &der, &tot);
  /* ... uses ... */
  /* scope exit (function top declarations): */
  mtoc2_tensor_free(&pol);
  mtoc2_tensor_free(&der);
  mtoc2_tensor_free(&tot);
}
```

## What this slope explicitly does NOT enable

- Single-lvalue call of an N≥2-output function (`x = polsum(...)`).
  Numbl handles this via nargout=1; mtoc2 keeps the existing
  rejection. Workaround: `[x] = polsum(...)`.
- `varargout` / `varargin` (variadic returns or args).
- Recursive multi-output functions. Same recursion restriction as
  every other user function.
- Multi-output method calls on class instances (`[a, b] = obj.foo()`).
  Methods stay 1-output; this is a separate slope.
- Outputs whose type changes across branches in a way that can't
  unify (e.g. one branch sets `a = scalar`, the other sets
  `a = tensor`). Same "scalar↔tensor boundary" rejection as
  ordinary Assign — covered by the existing `recordAssignment`
  check.

## Followups (separate slopes)

- **Single-lvalue call of multi-output func** (`x = polsum(...)`).
  Requires the call site to specialize the callee with nargout=1
  and switch from sret to return-by-value for the single output.
  Modest change; can land when needed.
- **Multi-output method dispatch.** `[a, b] = obj.foo(x)` —
  currently the method-call lowering rejects ≥2-output methods.
  Same template as this slope, just at the method-dispatch site.
- **`varargout`.** Materializes a runtime-sized cell of outputs.
  Requires cell arrays — not yet supported.
- **`nargout < declared` skip-trailing without `nargout` checks.**
  Numbl's call site silently ignores trailing outputs the callee
  doesn't assign; mtoc2 requires every declared output be assigned.
  Defer until a real script needs it.

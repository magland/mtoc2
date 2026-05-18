/**
 * `emitExpr` and the per-IRExpr-kind helpers that don't belong in
 * their own module. The big switch dispatches on `IRExpr.kind` and
 * returns the C expression string. Owned-aware sites (Var copy,
 * StructLit owned fields, …) route through `emitOwnedRhs`, which is
 * also defined here so the regular-expression and consume-site emit
 * paths share a single source of truth.
 */

import type { IRExpr } from "../lowering/ir.js";
import {
  classTypedefName,
  handleTypedefName,
  isNumeric,
  isOwned,
  structTypedefName,
} from "../lowering/types.js";
import { formatDouble } from "./cHelpers.js";
import {
  lookupBuiltin,
  makeEmitUseRuntime,
  useRuntimeByName,
  type RuntimeState,
} from "./runtime.js";
import { cStringLiteral, dimsProductExpr } from "./cFormat.js";
import { emitTensorConcat } from "./emitTensorConcat.js";
import { emitIndexSliceProducer, emitNdScalarOffset } from "./emitIndex.js";
import { activateOwnedRuntime, activatedOwnedHelpers } from "./emit.js";

/** Owned-typed RHS for an Assign or MemberStore (or a Call arg that
 *  binds to an owned callee param). Every owned C value produced
 *  here is freshly-owned; the consumer's `_assign` helper releases
 *  the prior slot and consumes the rhs.
 *
 *  - `Var`               → `<type>_copy(name)` (deep copy)
 *  - `MemberLoad`        → `<type>_copy(<base>.<field>)` (the load
 *                          itself is a struct-by-value read; we wrap
 *                          it in copy so the consumer gets a freshly-
 *                          owned buffer)
 *  - `HandleCaptureLoad` → `<type>_copy(<base>.cap_<name>)` (same
 *                          rationale — the handle's capture slot is
 *                          read by value and we copy it for the
 *                          consumer)
 *  - anything else       → `emitExpr` (TensorBuild / StructLit /
 *                          HandleLit / Binary / Call etc. already
 *                          emit fresh-allocating helpers) */
export function emitOwnedRhs(e: IRExpr, state: RuntimeState): string {
  if (e.kind === "Var") {
    const h = activatedOwnedHelpers(e.ty, state);
    return `${h.copy}(${e.cName})`;
  }
  if (e.kind === "MemberLoad" && isOwned(e.ty)) {
    const h = activatedOwnedHelpers(e.ty, state);
    return `${h.copy}(${emitMemberLoadBare(e, state)})`;
  }
  if (e.kind === "HandleCaptureLoad" && isOwned(e.ty)) {
    const h = activatedOwnedHelpers(e.ty, state);
    return `${h.copy}(${e.base.cName}.cap_${e.captureName})`;
  }
  return emitExpr(e, state);
}

/** Render a `MemberLoad` chain as a bare C field-access string, no
 *  copy wrapping. Used by `emitOwnedRhs` and inside `emitExpr` for
 *  non-owning contexts. */
function emitMemberLoadBare(
  e: Extract<IRExpr, { kind: "MemberLoad" }>,
  state: RuntimeState
): string {
  const baseStr =
    e.base.kind === "MemberLoad"
      ? emitMemberLoadBare(e.base, state)
      : emitExpr(e.base, state);
  return `${baseStr}.${e.field}`;
}

/** Lower a scalar cond expression to a C bool expression. Complex
 *  scalars use the numbl/MATLAB `creal(z) != 0 || cimag(z) != 0` rule
 *  via the `mtoc2_cnonzero` helper; real scalars compare against `0.0`. */
export function emitCondToBoolExpr(e: IRExpr, state: RuntimeState): string {
  const c = emitExpr(e, state);
  if (isNumeric(e.ty) && e.ty.isComplex) {
    useRuntimeByName(state, "mtoc2_cscalar");
    return `mtoc2_cnonzero(${c})`;
  }
  return `${c} != 0.0`;
}

export function emitExpr(e: IRExpr, state: RuntimeState): string {
  switch (e.kind) {
    case "NumLit":
      return formatDouble(e.value);
    case "ImagLit":
      useRuntimeByName(state, "mtoc2_cscalar");
      return `mtoc2_cmake(0.0, ${formatDouble(e.value)})`;
    case "StringLit": {
      // Text literal — kind comes from `e.ty`: `Char` (single-quoted,
      // 1×N char array) or `String` (double-quoted, scalar handle).
      // The reducer-builtin slot path (`sum(A, 'all')`, etc.) doesn't
      // route through emitExpr — those builtins' codegenC drops the
      // slot — so the bare C-string-literal fallback isn't load-bearing
      // anymore. Every reached `StringLit` here is a value-producing
      // text literal that needs the owned struct.
      const { lit, byteLen } = cStringLiteral(e.value);
      if (e.ty.kind === "String") {
        useRuntimeByName(state, "mtoc2_string_from_literal");
        return `mtoc2_string_from_literal(${lit}, ${byteLen})`;
      }
      if (e.ty.kind === "Char") {
        useRuntimeByName(state, "mtoc2_char_tensor_from_literal");
        return `mtoc2_char_tensor_from_literal(${lit}, ${byteLen})`;
      }
      // Reducer-builtin slot context (e.g. `'all'` to `sum`/`min`/`max`):
      // the surrounding builtin reads `ty.exact` at transfer time and
      // drops the slot in codegenC, so this bare literal is unreachable
      // by emitted C. Return a plain C literal as a safe stub.
      return lit;
    }
    case "TensorBuild": {
      // Runtime tensor construction. Both row-vector and matrix cases
      // route through the same compound-literal flat array (the data
      // is already in column-major order). 1×N picks `from_row` for
      // a marginally tighter helper.
      const [rows, cols] = e.shape;
      const isComplex = isNumeric(e.ty) && e.ty.isComplex;
      if (isComplex) {
        // Two parallel `double[]` arrays — real parts and imag parts.
        // Real-typed cells project to `(re, 0.0)`; complex cells
        // split via `mtoc2_creal` / `mtoc2_cimag`. This avoids ever
        // passing `double _Complex *` arrays around (which c2js
        // can't translate), and keeps each compound literal a plain
        // real-double array.
        const reParts: string[] = [];
        const imParts: string[] = [];
        for (const el of e.elements) {
          const c = emitExpr(el, state);
          if (isNumeric(el.ty) && el.ty.isComplex) {
            useRuntimeByName(state, "mtoc2_cscalar");
            reParts.push(`mtoc2_creal(${c})`);
            imParts.push(`mtoc2_cimag(${c})`);
          } else {
            reParts.push(c);
            imParts.push("0.0");
          }
        }
        const reFlat = reParts.join(", ");
        const imFlat = imParts.join(", ");
        if (rows === 1) {
          useRuntimeByName(state, "mtoc2_tensor_from_row_complex");
          return `mtoc2_tensor_from_row_complex((double[]){${reFlat}}, (double[]){${imFlat}}, ${cols})`;
        }
        useRuntimeByName(state, "mtoc2_tensor_from_matrix_complex");
        return `mtoc2_tensor_from_matrix_complex((double[]){${reFlat}}, (double[]){${imFlat}}, ${rows}, ${cols})`;
      }
      const flat = e.elements.map(el => emitExpr(el, state)).join(", ");
      if (rows === 1) {
        useRuntimeByName(state, "mtoc2_tensor_from_row");
        return `mtoc2_tensor_from_row((double[]){${flat}}, ${cols})`;
      }
      useRuntimeByName(state, "mtoc2_tensor_from_matrix");
      return `mtoc2_tensor_from_matrix((double[]){${flat}}, ${rows}, ${cols})`;
    }
    case "TensorConcat":
      return emitTensorConcat(e, state);
    case "Var":
      // Tensor Var reads pass the struct by value; downstream context
      // (Assign RHS, user-function call) wraps in copy where needed.
      return e.cName;
    case "Binary": {
      const b = lookupBuiltin(state, e.builtin);
      if (!b) throw new Error(`emit: builtin '${e.builtin}' not found`);
      return b.emit({
        argsC: [emitExpr(e.left, state), emitExpr(e.right, state)],
        argTypes: [e.left.ty, e.right.ty],
        nargout: 1,
        useRuntime: makeEmitUseRuntime(state),
      });
    }
    case "Unary": {
      const b = lookupBuiltin(state, e.builtin);
      if (!b) throw new Error(`emit: builtin '${e.builtin}' not found`);
      return b.emit({
        argsC: [emitExpr(e.operand, state)],
        argTypes: [e.operand.ty],
        nargout: 1,
        useRuntime: makeEmitUseRuntime(state),
      });
    }
    case "Call": {
      const builtinB = lookupBuiltin(state, e.name);
      if (builtinB) {
        return builtinB.emit({
          argsC: e.args.map(a => emitExpr(a, state)),
          argTypes: e.args.map(a => a.ty),
          nargout: 1,
          useRuntime: makeEmitUseRuntime(state),
        });
      }
      // Lowerer-synthesized bare-`toc;` print form. Not registered as
      // a public builtin (the registry only knows about value-returning
      // `toc`); the lowerer routes here for ExprStmt-position calls.
      // Activate the tic/toc runtime snippet so `mtoc2_toc_print` is
      // declared.
      if (e.name === "toc_print" && e.cName === "mtoc2_toc_print") {
        useRuntimeByName(state, "mtoc2_tic_toc");
        return `mtoc2_toc_print()`;
      }
      // Lowerer-synthesized bare-`toc(t0);` print form (1-arg handle
      // variant). Same activation path as `toc_print`.
      if (
        e.name === "toc_handle_print" &&
        e.cName === "mtoc2_toc_handle_print"
      ) {
        useRuntimeByName(state, "mtoc2_tic_toc");
        const argC = emitExpr(e.args[0], state);
        return `mtoc2_toc_handle_print(${argC})`;
      }
      // User function call: owned args wrap in copy (callee owns).
      const args = e.args
        .map(a => (isOwned(a.ty) ? emitOwnedRhs(a, state) : emitExpr(a, state)))
        .join(", ");
      return `${e.cName}(${args})`;
    }
    case "HandleLit": {
      // No-capture handles share the placeholder typedef and call
      // through its `_empty()` to mirror the struct/class lifecycle.
      // Capture-bearing handles emit a designated initializer; each
      // owned-typed capture value is routed through `emitOwnedRhs`
      // so a Var read of the enclosing scope's binding wraps in
      // `<innerTypedef>_copy`, giving the handle struct its own
      // freshly-owned snapshot (MATLAB by-value capture semantics).
      if (e.ty.kind !== "Handle") {
        throw new Error("emit: HandleLit with non-Handle ty");
      }
      const cTy = handleTypedefName(e.ty);
      if (e.captures.length === 0) {
        activateOwnedRuntime(e.ty, state);
        return `${cTy}_empty()`;
      }
      const parts = e.captures.map(c => {
        const v = isOwned(c.value.ty)
          ? emitOwnedRhs(c.value, state)
          : emitExpr(c.value, state);
        return `.cap_${c.name} = ${v}`;
      });
      return `(${cTy}){${parts.join(", ")}}`;
    }
    case "HandleCaptureLoad":
      return `${e.base.cName}.cap_${e.captureName}`;
    case "StructLit": {
      if (e.ty.kind !== "Struct" && e.ty.kind !== "Class") {
        throw new Error(
          `emit: StructLit ty is ${e.ty.kind}, expected Struct or Class`
        );
      }
      const typedef =
        e.ty.kind === "Struct"
          ? structTypedefName(e.ty)
          : classTypedefName(e.ty);
      // Each field value is consumed by the freshly-allocated struct
      // — owned values must already be fresh producers (ANF
      // guarantees this for any non-Var owned RHS; a `Var` is wrapped
      // in copy here so the struct owns its own buffer copy).
      const parts = e.fields.map(f => {
        const v = isOwned(f.value.ty)
          ? emitOwnedRhs(f.value, state)
          : emitExpr(f.value, state);
        return `.${f.name} = ${v}`;
      });
      return `(${typedef}){${parts.join(", ")}}`;
    }
    case "MemberLoad":
      // Bare field-access read; the load passes the field by value.
      // Owned-typed reads at owned-consuming sites are wrapped in
      // `_copy` by emitOwnedRhs, not here. (Non-owning sites — e.g.
      // a tensor field passed to `disp` — pass the struct by value
      // and don't take ownership.)
      return emitMemberLoadBare(e, state);
    case "IndexLoad": {
      if (e.base.kind !== "Var") {
        throw new Error(
          `emit internal: IndexLoad base must be a Var after ANF (got ${e.base.kind})`
        );
      }
      const offset = emitNdScalarOffset(state, e.indices, e.base.cName);
      if (isNumeric(e.base.ty) && e.base.ty.isComplex) {
        // Compose the complex value from both lanes via `mtoc2_cmake`
        // so the c2js side reuses its `{re, im}` JS impl. Avoid
        // recomputing the offset twice by hoisting through a GCC
        // statement-expression — the offset may include autoinc /
        // bounds-checked sub-calls we don't want to re-evaluate.
        useRuntimeByName(state, "mtoc2_cscalar");
        return `({ long _mtoc2_off = ${offset}; mtoc2_cmake(${e.base.cName}.real[_mtoc2_off], ${e.base.cName}.imag[_mtoc2_off]); })`;
      }
      return `${e.base.cName}.real[${offset}]`;
    }
    case "IndexSlice":
      return emitIndexSliceProducer(e, state);
    case "EndRef":
      // The lowerer (`lowerEndKeyword`) folds statically-known shapes
      // to a `NumLit` before they ever land in an `EndRef`, so by the
      // time we're here `baseTy.shape` is unset and we always emit a
      // dynamic `.dims[]` read.
      if (e.baseTy.kind !== "Numeric") {
        throw new Error("emit internal: EndRef with non-numeric baseTy");
      }
      if (e.axis === "linear") {
        return `(double)(${dimsProductExpr(e.baseCName, e.baseTy)})`;
      }
      return `(double)${e.baseCName}.dims[${e.axis}]`;
    case "MakeRange":
      return emitMakeRange(e, state);
  }
}

/** Emit a `MakeRange` expression. Activates the runtime helper. */
function emitMakeRange(
  e: Extract<IRExpr, { kind: "MakeRange" }>,
  state: RuntimeState
): string {
  useRuntimeByName(state, "mtoc2_tensor_make_range");
  const startStr = emitExpr(e.start, state);
  const stepStr = emitExpr(e.step, state);
  const endStr = emitExpr(e.end, state);
  return `mtoc2_tensor_make_range(${startStr}, ${stepStr}, ${endStr})`;
}

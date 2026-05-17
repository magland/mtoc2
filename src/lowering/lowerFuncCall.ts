/**
 * Bare-name function-call lowering: `name(args)`.
 *
 * Resolution priority — checked in this order:
 *   0. The literal name `struct` (no shadowing local) → `StructLit`.
 *   1. The literal name `bsxfun` (no shadowing local) → rewrite to
 *      `fn(A, B)` when the first arg is `@<knownElementwiseBinary>`.
 *   2. An in-scope `HandleType` variable → `dispatchHandleCall`.
 *   3. An in-scope class name with no shadowing local → class
 *      constructor.
 *   4. An in-scope variable: multi-element numeric routes through
 *      the index helpers; other types raise UnsupportedConstruct.
 *   5. Zero-arity builtin paren-form (`pi()`, `Inf()`).
 *   6. Numbl resolver verdict — builtin / user-function / class
 *      method.
 *   7. Fallback to mtoc2's own builtin registry for plot-drawing
 *      builtins numbl wires through runtime dispatch.
 */

import type { Expr } from "../parser/index.js";
import { TypeError, UnsupportedConstruct } from "./errors.js";
import type { IRExpr } from "./ir.js";
import {
  classMethodSpecSource,
  isHandle,
  isMultiElement,
  isNumeric,
  structType,
  typeToString,
} from "./types.js";
import { getBuiltin } from "./builtins/index.js";
import { arityAccepts, arityDescribe } from "./builtins/registry.js";
import { isSliceArg } from "./indexResolve.js";
import { lowerIndexLoad } from "./lowerIndexLoad.js";
import { lowerIndexSlice } from "./lowerIndexSlice.js";
import { lowerClassConstructorCall } from "./lowerClassConstructor.js";
import { dispatchHandleCall } from "./lowerHandle.js";
import { buildUserFunctionCall } from "./specialize.js";
import type { Lowerer } from "./lower.js";
import { stripQuotes } from "./lower.js";

export function lowerFuncCall(
  this: Lowerer,
  e: Extract<Expr, { type: "FuncCall" }>
): IRExpr {
  // Look up the env BEFORE the `struct(...)` constructor shortcut so
  // `struct = [1 2 3]; struct(2)` reads the local (yields `2`) rather
  // than dispatching to the `struct(...)` constructor and erroring on
  // "expects an even number of args". MATLAB precedence is env >
  // builtin; this honors it for the one builtin name that has
  // special-cased lowering. Other in-scope-variable cases (handle,
  // multi-element numeric, scalar) are handled below.
  const envEntry = this.env.get(e.name);
  if (envEntry === undefined && e.name === "struct") {
    return lowerStructConstructor.call(this, e);
  }
  if (envEntry === undefined && e.name === "bsxfun") {
    const rewritten = tryRewriteBsxfun.call(this, e);
    if (rewritten !== null) return rewritten;
  }
  if (envEntry !== undefined && isHandle(envEntry.ty)) {
    return dispatchHandleCall.call(this, e.name, envEntry, e.args, e.span);
  }
  if (envEntry === undefined && this.workspace.isClass(e.name)) {
    return lowerClassConstructorCall.call(
      this,
      this.workspace.classes.get(e.name)!,
      e.args,
      e.span
    );
  }
  if (envEntry !== undefined) {
    // MATLAB's "workspace shadows functions" rule: `v(i)` reads as an
    // indexed access when `v` is in scope. Multi-element numeric
    // bases route through the index helpers; scalar variables get a
    // clearer error than "unknown function". Other types (handle is
    // handled above, struct / class / string) keep the existing
    // "cannot be called" error.
    if (isNumeric(envEntry.ty) && isMultiElement(envEntry.ty)) {
      if (e.args.some(isSliceArg)) {
        return lowerIndexSlice.call(this, e.name, e.args, e.span);
      }
      return lowerIndexLoad.call(this, e.name, e.args, e.span);
    }
    throw new UnsupportedConstruct(
      `'${e.name}' is an in-scope variable of type ` +
        `${typeToString(envEntry.ty)}; cannot be called as a function ` +
        `(scalar indexing and dynamically-typed handles are not supported)`,
      e.span
    );
  }

  const args = e.args.map(a => this.lowerExpr(a));
  for (const a of args) {
    this.requireValueType(a, `argument to '${e.name}'`);
  }
  const argTypes = args.map(a => a.ty);

  // Zero-arity mtoc2 builtins like `pi()` / `Inf()` / `NaN()`. Numbl
  // resolves these through a separate constants table
  // (`BUILTIN_CONSTANTS`) not in `index.builtins`, so
  // `workspace.resolve` returns null. The bare-name read path in
  // `lowerIdent` already handles `pi` (no parens); this branch
  // handles the paren-form. `e.args.length === 0` is the gate so we
  // don't accidentally claim a 1-arg call like `pi(2,3)` (which
  // numbl/MATLAB treat as a fill constructor — out of scope for
  // mtoc2 v1).
  if (args.length === 0) {
    const b = getBuiltin(e.name);
    if (b !== undefined && b.arity === 0) {
      const ty = b.transfer([], e.span);
      return {
        kind: "Call",
        cName: e.name,
        name: e.name,
        args: [],
        ty,
        span: e.span,
      };
    }
  }

  const target = this.workspace.resolve(
    e.name,
    argTypes,
    this.callSite(),
    e.span
  );
  if (!target) {
    // Fall back to mtoc2's builtin registry when numbl exposes the
    // name via a non-index surface (e.g. plot drawing primitives like
    // `plot`/`surf`/`imagesc`/`bar`, which numbl wires through its
    // runtime dispatch rather than `index.builtins`). The
    // validate-then-route shape is identical to the standard builtin
    // branch below; we just don't have numbl's blessing.
    const fallback = getBuiltin(e.name);
    if (fallback !== undefined && arityAccepts(fallback.arity, args.length)) {
      const ty = fallback.transfer(argTypes, e.span);
      return {
        kind: "Call",
        cName: e.name,
        name: e.name,
        args,
        ty,
        span: e.span,
      };
    }
    throw new UnsupportedConstruct(`unknown function '${e.name}'`, e.span);
  }
  switch (target.kind) {
    case "builtin": {
      // Numbl agreed it's a builtin; mtoc2 still requires the builtin
      // to be registered in its own table (and to match arity).
      const b = getBuiltin(e.name);
      if (!b) {
        throw new UnsupportedConstruct(
          `builtin '${e.name}' is not supported by mtoc2`,
          e.span
        );
      }
      if (!arityAccepts(b.arity, args.length)) {
        throw new TypeError(
          `'${e.name}' expects ${arityDescribe(b.arity)} arg(s), got ${args.length}`,
          e.span
        );
      }
      const ty = b.transfer(argTypes, e.span);
      return {
        kind: "Call",
        cName: e.name,
        name: e.name,
        args,
        ty,
        span: e.span,
      };
    }
    case "userFunction": {
      // Expression-context: request nargout=1 (the call site's single
      // lvalue). A multi-output declared function specializes with
      // truncated output list — see `buildUserFunctionCall`.
      return buildUserFunctionCall.call(
        this,
        target.ast,
        args,
        e.name,
        e.span,
        {
          definingFile: target.file,
        }
      );
    }
    case "classMethod": {
      // `method(obj, args)` syntax — the resolver decided this name
      // is a class method because one of the arg types is a
      // ClassInstance. Route through the same path as the dot form.
      const reg = this.classReg(target.className);
      if (reg === undefined) {
        throw new UnsupportedConstruct(
          `internal: class '${target.className}' missing from workspace registry`,
          e.span
        );
      }
      const method = target.stripInstance
        ? reg.staticMethods.get(target.methodName)
        : reg.methods.get(target.methodName);
      if (method === undefined) {
        throw new TypeError(
          `class '${target.className}' has no ${target.stripInstance ? "static " : ""}method '${target.methodName}'`,
          e.span
        );
      }
      if (method.outputs.length >= 2) {
        throw new UnsupportedConstruct(
          `class method '${target.className}.${target.methodName}' has ` +
            `${method.outputs.length} outputs; multi-output methods can ` +
            `only be called via '[a, b, ...] = ...' (not yet supported ` +
            `for class methods) or as a bare statement`,
          e.span
        );
      }
      const callArgs = target.stripInstance ? args.slice(1) : args;
      return buildUserFunctionCall.call(
        this,
        method,
        callArgs,
        `${target.className}.${target.methodName}`,
        e.span,
        {
          specSource: classMethodSpecSource(
            target.className,
            target.methodName
          ),
          definingFile: reg.file,
        }
      );
    }
    case "classConstructor": {
      // Shouldn't fire because we short-circuit above on
      // `isClass(name)`, but kept for completeness.
      const reg = this.classReg(target.className);
      if (reg === undefined) {
        throw new UnsupportedConstruct(
          `internal: class '${target.className}' missing from workspace registry`,
          e.span
        );
      }
      return lowerClassConstructorCall.call(this, reg, e.args, e.span);
    }
  }
}

/** `bsxfun(@fn, A, B)` — when `@fn` is a function-handle literal
 *  whose name is one of the elementwise binary builtins, rewrite to
 *  `fn(A, B)` and let the existing implicit-expansion path do the
 *  work. Returns the lowered IR on success, or `null` to fall through
 *  to the generic call path (which will surface a clearer error for
 *  unsupported handle targets). Custom function-handle bsxfun is
 *  deferred. */
function tryRewriteBsxfun(
  this: Lowerer,
  e: Extract<Expr, { type: "FuncCall" }>
): IRExpr | null {
  if (e.args.length !== 3) return null;
  const handleArg = e.args[0];
  if (handleArg.type !== "FuncHandle") {
    throw new UnsupportedConstruct(
      `'bsxfun' first arg must be a function-handle literal (e.g. @times); ` +
        `dynamic handle-value bsxfun is not yet supported`,
      e.span
    );
  }
  const handleName = handleArg.name;
  const knownOps = new Set([
    "plus",
    "minus",
    "times",
    "rdivide",
    "power",
    "eq",
    "ne",
    "lt",
    "le",
    "gt",
    "ge",
    "mod",
    "rem",
    "atan2",
    "hypot",
    "max",
    "min",
  ]);
  if (!knownOps.has(handleName)) {
    throw new UnsupportedConstruct(
      `'bsxfun' with handle target '@${handleName}' is not supported; ` +
        `supported targets: ${[...knownOps].sort().join(", ")}`,
      e.span
    );
  }
  const synthCall: Extract<Expr, { type: "FuncCall" }> = {
    type: "FuncCall",
    name: handleName,
    args: [e.args[1], e.args[2]],
    span: e.span,
  };
  return lowerFuncCall.call(this, synthCall);
}

/** `struct('f1', v1, 'f2', v2, ...)`. Validates that args come in
 *  (string-literal-name, value) pairs and that no field is
 *  duplicated. Each value's storage type drives the field's recorded
 *  type — typedef shape is stable across writes because storage types
 *  are widened (no `exact`, no `sign`). */
function lowerStructConstructor(
  this: Lowerer,
  e: Extract<Expr, { type: "FuncCall" }>
): IRExpr {
  if (e.args.length % 2 !== 0) {
    throw new TypeError(
      `'struct' expects an even number of args (name, value, name, value, ...)`,
      e.span
    );
  }
  const fields: { name: string; value: IRExpr }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < e.args.length; i += 2) {
    const nameExpr = e.args[i];
    if (nameExpr.type !== "String" && nameExpr.type !== "Char") {
      throw new TypeError(
        `'struct' field name (arg ${i + 1}) must be a string or char literal`,
        nameExpr.span
      );
    }
    // numbl's parser stores the literal's source text (including the
    // surrounding `'`/`"` quotes) in `value`. Strip them so the
    // recorded field name matches the user-visible name. Also
    // require a non-empty, identifier-shaped field name (no embedded
    // quotes/escapes etc).
    const fname = stripQuotes(nameExpr.value);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(fname)) {
      throw new TypeError(
        `'struct' field name '${fname}' is not a valid identifier`,
        nameExpr.span
      );
    }
    if (seen.has(fname)) {
      throw new TypeError(
        `'struct': duplicate field '${fname}'`,
        nameExpr.span
      );
    }
    seen.add(fname);
    const v = this.lowerExpr(e.args[i + 1]);
    this.requireValueType(v, `value for field '${fname}'`);
    // Only types that have a stable owned-or-POD C representation
    // are allowed as struct field values. Reject handles (POD but
    // their typedef matrix gets messy), void, and Unknown.
    if (v.ty.kind === "Void" || v.ty.kind === "Unknown") {
      throw new TypeError(
        `value for field '${fname}': type ${typeToString(v.ty)} is not a valid struct field type`,
        e.args[i + 1].span
      );
    }
    fields.push({ name: fname, value: v });
  }
  // Build the StructType from each value's precise type. The typedef
  // hash uses `cFieldTypeStr` (one C-type string per field), so
  // different `exact` / `sign` / tensor-shape values across
  // constructions still share one C typedef. Carrying the precise
  // type through the IR lets a subsequent `aa = s.x` read return e.g.
  // `double[1×1]:positive=1` instead of a sign-stripped form.
  const tyFields = fields.map(f => ({
    name: f.name,
    ty: f.value.ty,
  }));
  const ty = structType(tyFields);
  // Re-order the values to match the canonical (sorted) field list
  // so the IR's `StructLit.fields` lines up with `ty.fields`.
  const sortedValues = fields
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  return {
    kind: "StructLit",
    fields: sortedValues,
    ty,
    span: e.span,
  };
}

/**
 * Function-call dispatch: callByName, callUserFunction, callHandle,
 * constructClassInstance, invokeBuiltin. Attached to
 * `Interpreter.prototype` from `interpreter.ts`.
 *
 * Mirrors numbl's interpreterFunctions.ts split — same role here,
 * adapted to mtoc2's builtin registry (which routes through
 * `Builtin.call` rather than numbl's `IBuiltin.resolve`).
 */

import type { Expr, Stmt, Span } from "../parser/index.js";
import type { Type } from "../lowering/types.js";
import type { ClassRegistration } from "../lowering/classDefs.js";
import {
  isChar as isCharRV,
  isHandleValue,
  type RuntimeHandle,
  type RuntimeValue,
} from "../runtime/value.js";
import { getBuiltin } from "../builtins/index.js";
import type { Builtin } from "../builtins/registry.js";
import { inferTypeFromValue } from "../runtime/inferType.js";
import { RuntimeError, UnsupportedConstruct } from "../lowering/errors.js";
import { Environment } from "./environment.js";
import { Interpreter } from "./interpreter.js";

// ── Dispatch ──────────────────────────────────────────────────────────────

/** Operator-builtin dispatch. The Binary / Unary / conjugate-transpose
 *  paths in `evalExpr` use this instead of `callByName` because MATLAB
 *  operators do NOT resolve through the workspace function index —
 *  `a * b` always goes to the `mtimes` builtin (or a class operator
 *  overload, when one applies; mtoc2 v1 has no operator overloads
 *  yet), even when a `mtimes.m` workspace file exists. The c-aot
 *  lowerer's `lowerBinary` / `lowerUnary` paths bypass `workspace.resolve`
 *  for the same reason. */
export function callOpBuiltin(
  this: Interpreter,
  name: string,
  args: RuntimeValue[],
  span: Span
): RuntimeValue {
  const b = getBuiltin(name);
  if (b === undefined) {
    throw new RuntimeError(
      `internal: operator builtin '${name}' not registered`,
      span
    );
  }
  const argTypes = args.map(inferTypeFromValue);
  return this.invokeBuiltin(b, args, argTypes, 1, name)[0];
}

/** Resolve `name` against the workspace + builtin registry per MATLAB
 *  precedence (local function in current file > workspace functions >
 *  class methods > builtins; numbl's `resolveFunction` is the source
 *  of truth). Used by source-level `name(args)` calls (FuncCall,
 *  MultiAssign, named handles). Operator paths bypass this — see
 *  `callOpBuiltin` above. Returns one value per `nargout`. */
export function callByName(
  this: Interpreter,
  name: string,
  args: RuntimeValue[],
  nargout: number,
  span: Span
): RuntimeValue[] {
  // `struct(name, value, name, value, ...)` is special-cased in the
  // c-aot path's lowerFuncCall — it doesn't go through the builtin
  // registry. Match that here so the interpreter sees the same
  // dialect: a plain object with the named fields. Field-name args
  // must be Char or String; values pass through unchanged.
  if (name === "struct") {
    if (args.length % 2 !== 0) {
      throw new UnsupportedConstruct(
        `'struct' expects an even number of args (name, value, name, value, ...)`,
        span
      );
    }
    const out: Record<string, RuntimeValue> = {};
    for (let i = 0; i < args.length; i += 2) {
      const k = args[i];
      let fname: string;
      if (typeof k === "string") fname = k;
      else if (isCharRV(k)) fname = k.value;
      else {
        throw new UnsupportedConstruct(
          `'struct' field name (arg ${i + 1}) must be a string or char literal`,
          span
        );
      }
      out[fname] = args[i + 1];
    }
    return [out as unknown as RuntimeValue];
  }
  // `feval(handle_or_name, args...)` — parallel to the AOT lowerer's
  // `rewriteFevalToDirectCall`. Routes the call to the underlying
  // handle via `callHandle`, or to the named function via a recursive
  // `callByName`. `nargout` from the outer caller flows through to
  // the dispatched target. Runtime-computed first-arg shapes (e.g.
  // class instances) fall through to MATLAB's standard "feval as a
  // method" resolution — mtoc2 v1 rejects those with a clear error.
  if (name === "feval") {
    if (args.length < 1) {
      throw new UnsupportedConstruct(
        `'feval' expects at least 1 argument (the function handle or name), ` +
          `got 0`,
        span
      );
    }
    const first = args[0];
    const rest = args.slice(1);
    if (isHandleValue(first)) {
      return this.callHandle(first, rest, nargout, span);
    }
    if (isCharRV(first)) {
      return this.callByName(first.value, rest, nargout, span);
    }
    if (typeof first === "string") {
      return this.callByName(first, rest, nargout, span);
    }
    throw new UnsupportedConstruct(
      `'feval' first argument must be a function handle or a function-name ` +
        `string; got value of type '${typeof first}' (runtime-computed ` +
        `handle expressions and class-instance dispatch are not supported)`,
      span
    );
  }
  // `cell(n)` / `cell(n, m, ...)` constructor — parallel to the
  // `struct` special-case. Mirrors numbl `type-constructors.ts:442`:
  // every slot is the canonical empty-double tensor `[0×0]`.
  if (name === "cell") {
    let dims: number[];
    if (args.length === 0) {
      dims = [0, 0];
    } else if (args.length === 1) {
      const n = Math.max(0, Math.floor(Number(args[0] as number)));
      dims = [n, n];
    } else {
      dims = args.map(a => {
        const n = Math.floor(Number(a as number));
        return n > 0 ? n : 0;
      });
    }
    let total = 1;
    for (const d of dims) total *= d;
    const data: RuntimeValue[] = new Array(total);
    for (let i = 0; i < total; i++) {
      data[i] = {
        mtoc2Tag: "tensor",
        shape: [0, 0],
        data: new Float64Array(0),
      } as unknown as RuntimeValue;
    }
    return [
      {
        mtoc2Tag: "cell",
        shape: dims,
        data,
      } as unknown as RuntimeValue,
    ];
  }
  const argTypes = args.map(inferTypeFromValue);

  // Workspace dispatch first — numbl's `resolveFunction` applies the
  // full MATLAB precedence rule (local function in current file >
  // workspace functions / packages > class methods > builtins), so a
  // user-supplied `disp.m` correctly shadows the global `disp`
  // builtin. The prior order (registry → workspace) skipped the
  // shadow check for any name the registry knew about. Without a
  // workspace (vitest fixture) we fall straight through to the bare
  // registry at the bottom.
  if (this.workspace !== undefined) {
    const target = this.workspace.resolve(
      name,
      argTypes,
      { file: this.currentFile },
      span
    );
    if (target !== null) {
      switch (target.kind) {
        case "builtin": {
          const fb = getBuiltin(target.name);
          if (!fb) {
            throw new UnsupportedConstruct(
              `interpreter: workspace resolved '${name}' to builtin ` +
                `'${target.name}' but no such builtin is registered`,
              span
            );
          }
          return this.invokeBuiltin(fb, args, argTypes, nargout, name);
        }
        case "userFunction":
          return this.callUserFunction(
            target.ast,
            args,
            nargout,
            span,
            target.file
          );
        case "mtoc2UserFunction": {
          const ub = this.workspace.getUserBuiltin(target.name);
          if (!ub) {
            throw new UnsupportedConstruct(
              `interpreter: workspace claimed '${name}' is a .mtoc2.js ` +
                `user function but no Builtin is registered`,
              span
            );
          }
          return this.invokeBuiltin(ub, args, argTypes, nargout, name);
        }
        case "classConstructor": {
          const reg = this.workspace.classes.get(target.className);
          if (reg === undefined) {
            throw new UnsupportedConstruct(
              `interpreter: workspace resolved '${name}' as a class but ` +
                `no registration found for '${target.className}'`,
              span
            );
          }
          return this.constructClassInstance(reg, args, span);
        }
        case "classMethod": {
          const reg = this.workspace.classes.get(target.className);
          if (reg === undefined) {
            throw new UnsupportedConstruct(
              `interpreter: workspace resolved '${name}' as a class method ` +
                `but no registration found for '${target.className}'`,
              span
            );
          }
          // Static methods are called as `ClassName.method(args)`
          // and don't have a receiver to thread; instance methods
          // receive the receiver as their first parameter.
          const fn =
            reg.staticMethods.get(target.methodName) ??
            reg.methods.get(target.methodName);
          if (fn === undefined) {
            throw new UnsupportedConstruct(
              `interpreter: class '${target.className}' has no method ` +
                `'${target.methodName}'`,
              span
            );
          }
          // Pass the method's source file so calls from within the
          // method body resolve in the right scope — external method
          // files own per-method-file local helpers, and the resolver
          // looks them up by the executing method's file path.
          return this.callUserFunction(fn, args, nargout, span, fn.span.file);
        }
      }
    }
  }

  // Workspace had no verdict, OR no workspace at all. Fall back to
  // the global builtin registry directly — covers vitest fixtures
  // and any mtoc2 builtin numbl's resolver doesn't yet know about.
  const b = getBuiltin(name);
  if (b !== undefined) {
    return this.invokeBuiltin(b, args, argTypes, nargout, name);
  }

  throw new RuntimeError(`Undefined function or variable '${name}'`, span);
}

/** Dispatch a function handle. Named handles (`@foo`) re-route
 *  through `callByName` so the same resolution rules (workspace,
 *  classes, packages) apply at the call site. Anonymous handles
 *  (`@(x) x+1`) run in a fresh env seeded with the captures plus the
 *  params bound to args; the body is evaluated as an expr. */
export function callHandle(
  this: Interpreter,
  h: RuntimeHandle,
  args: RuntimeValue[],
  nargout: number,
  span: Span
): RuntimeValue[] {
  if (h.kind === "named") {
    return this.callByName(h.name, args, nargout, span);
  }
  // Anonymous: bind params + captures in a child env. The body is a
  // single expression, so the function can produce exactly one
  // output. A multi-output request (`[a, b] = (@(x) x+1)(3)`)
  // throws a `RuntimeError` matching numbl's
  // `runtime/runtimeAnonymous.ts` — chunkie's `try [r,d,d2] = fcurve(ta)`
  // pattern relies on this throw landing in the surrounding catch.
  if (args.length !== h.params.length) {
    throw new UnsupportedConstruct(
      `interpreter: anonymous handle expects ${h.params.length} arg(s) ` +
        `(got ${args.length})`,
      span
    );
  }
  if (nargout > 1) {
    throw new RuntimeError("Too many output arguments.", span);
  }
  const child = new Environment();
  for (const [k, v] of Object.entries(h.captures)) child.set(k, v);
  for (let i = 0; i < h.params.length; i++) child.set(h.params[i], args[i]);
  const inner = new Interpreter(this.ctx, {
    env: child,
    ...(this.workspace !== undefined ? { workspace: this.workspace } : {}),
    currentFile: this.currentFile,
  });
  const result = inner.evalExpr(h.body as Expr);
  return nargout === 0 ? [] : [result];
}

/** Build a class instance: initialize properties to defaults, run the
 *  constructor body (if any) on that initial receiver, and return the
 *  resulting object. Mirrors numbl's classdef semantics: the
 *  constructor's `obj` parameter is bound to the default-valued
 *  receiver, and the constructor body writes through `obj.<prop>` to
 *  mutate properties before returning `obj`. */
export function constructClassInstance(
  this: Interpreter,
  reg: ClassRegistration,
  args: RuntimeValue[],
  span: Span
): RuntimeValue[] {
  const initial: Record<string, RuntimeValue> = {};
  // Tag the instance with its class name so MethodCall dispatch can
  // look up the right method registration at the call site. The tag
  // is non-enumerable so it doesn't show up in disp / Object.keys,
  // keeping struct-shaped behavior elsewhere.
  Object.defineProperty(initial, "mtoc2Class", {
    value: reg.className,
    enumerable: false,
    writable: false,
  });
  for (const name of reg.propertyNames) {
    const def = reg.defaults.get(name);
    if (def !== undefined) {
      initial[name] = this.evalExpr(def.expr);
    } else {
      // No default — leave the slot unset; the constructor must
      // assign before the first read. Use `0` as a neutral
      // placeholder so a stray read doesn't blow up with `undefined`
      // (matches numbl's "empty struct field" feel).
      initial[name] = 0;
    }
  }
  if (reg.constructor === null) {
    if (args.length !== 0) {
      throw new RuntimeError(
        `'${reg.className}' has no constructor; the default form takes no args ` +
          `(got ${args.length})`,
        span
      );
    }
    return [initial as RuntimeValue];
  }
  // Bind the constructor's output param to `initial`, then run.
  const fn = reg.constructor;
  if (args.length > fn.params.length) {
    throw new RuntimeError(
      `Too many input arguments to '${fn.name}' (${args.length} > ${fn.params.length})`,
      span
    );
  }
  const child = new Environment();
  for (let i = 0; i < args.length; i++) child.set(fn.params[i], args[i]);
  // The first output (typically `obj`) starts as the default-valued
  // receiver so the constructor body can write through it.
  if (fn.outputs.length > 0) {
    child.set(fn.outputs[0], initial as RuntimeValue);
  }
  child.set("$nargin", args.length);
  child.set("$nargout", 1);
  const inner = new Interpreter(this.ctx, {
    env: child,
    ...(this.workspace !== undefined ? { workspace: this.workspace } : {}),
    currentFile: this.currentFile,
  });
  inner.runProgram(fn.body);
  const outName = fn.outputs[0];
  const result = outName !== undefined ? child.get(outName) : undefined;
  if (result === undefined) {
    throw new RuntimeError(
      `'${fn.name}': constructor output '${outName}' was never assigned`,
      span
    );
  }
  return [result];
}

/** Invoke a builtin via its `call` hook. Runs `transfer` first for
 *  validation, then dispatches; both share the `argTypes` shape, so
 *  the per-backend dispatch (c-aot's emitC vs js-aot's emitJs vs
 *  interpreter's call) stays parallel. */
export function invokeBuiltin(
  this: Interpreter,
  b: Builtin,
  args: RuntimeValue[],
  argTypes: Type[],
  nargout: number,
  sourceName: string
): RuntimeValue[] {
  if (!b.call) {
    throw new UnsupportedConstruct(
      `builtin '${sourceName}' has no interpreter implementation (call hook)`
    );
  }
  // Validate via transfer first, on the same `argTypes` the c-aot
  // and js-aot paths consume. This is the contract: if transfer
  // rejects an arg shape, every backend rejects it the same way.
  b.transfer(argTypes, nargout);
  return b.call({ args, argTypes, nargout, ctx: this.ctx });
}

/** Execute a user-function body in a fresh `Environment`, binding
 *  parameters and returning the declared outputs. Mirrors numbl's
 *  callUserFunction:
 *   - Too-many-args / too-many-outputs / unassigned-output are
 *     `RuntimeError` (user-facing, not "feature missing").
 *   - `$nargin` / `$nargout` are bound under prefixed names so user
 *     code cannot shadow the slots that the `nargin` / `nargout`
 *     pseudo-vars dereference (the eval-switch intercepts those
 *     idents and reads the `$`-prefixed env entries).
 *   - When `nargout === 0` and the function declares outputs, still
 *     collect the first output for `ans` assignment — guards like
 *     `if nargout > 0` still see the runtime nargout. Recursion is
 *     allowed; JS's own stack is the depth bound.
 *
 *  ExprStmt-of-a-void-function: mtoc2's eval-switch calls every
 *  FuncCall with `nargout=1` (the call-site convention shared with
 *  the builtin registry). For a user function declaring zero
 *  outputs, that would falsely trip the too-many-outputs guard, so
 *  treat the request as `nargout=0` and return [] — the ExprStmt
 *  handler sees `undefined` and skips the `ans` write. */
export function callUserFunction(
  this: Interpreter,
  fn: Extract<Stmt, { type: "Function" }>,
  args: RuntimeValue[],
  nargout: number,
  span: Span,
  sourceFile?: string
): RuntimeValue[] {
  if (args.length > fn.params.length) {
    throw new RuntimeError(
      `Too many input arguments to '${fn.name}' (${args.length} > ${fn.params.length})`,
      span
    );
  }
  const effectiveNargout =
    fn.outputs.length === 0 && nargout === 1 ? 0 : nargout;
  if (effectiveNargout > fn.outputs.length) {
    throw new RuntimeError("Too many output arguments.", span);
  }
  const child = new Environment();
  for (let i = 0; i < args.length; i++) {
    child.set(fn.params[i], args[i]);
  }
  child.set("$nargin", args.length);
  child.set("$nargout", effectiveNargout);
  const inner = new Interpreter(this.ctx, {
    env: child,
    ...(this.workspace !== undefined ? { workspace: this.workspace } : {}),
    currentFile: sourceFile ?? this.currentFile,
  });
  inner.runProgram(fn.body);
  // Numbl: when effectiveNargout==0 but the function declares outputs,
  // still collect the first output so the caller (ExprStmt) can use
  // it as `ans`. The body already saw $nargout==0, so guards behave.
  const collectCount =
    effectiveNargout === 0 && fn.outputs.length > 0
      ? 1
      : Math.min(effectiveNargout, fn.outputs.length);
  const out: RuntimeValue[] = [];
  for (let i = 0; i < collectCount; i++) {
    const name = fn.outputs[i];
    const v = child.get(name);
    if (v === undefined && effectiveNargout >= i + 1) {
      throw new RuntimeError(
        `Output argument '${name}' (and maybe others) not assigned during call to '${fn.name}'`,
        span
      );
    }
    out.push(v ?? 0);
  }
  return out;
}

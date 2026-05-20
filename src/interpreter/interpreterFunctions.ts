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
  type RuntimeHandle,
  type RuntimeValue,
} from "../runtime/value.js";
import { getBuiltin } from "../builtins/index.js";
import type { Builtin } from "../builtins/registry.js";
import { inferTypeFromValue } from "../runtime/inferType.js";
import { UnsupportedConstruct } from "../lowering/errors.js";
import { Environment } from "./environment.js";
import { Interpreter } from "./interpreter.js";

// ── Dispatch ──────────────────────────────────────────────────────────────

/** Resolve `name` against (in order): the global builtin registry,
 *  workspace-loaded `.mtoc2.js` user functions, and the workspace
 *  function index (via numbl's `resolveFunction`). Returns one value
 *  per `nargout`. */
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
  const argTypes = args.map(inferTypeFromValue);

  // Global builtin registry first.
  const b = getBuiltin(name);
  if (b !== undefined) {
    return this.invokeBuiltin(b, args, argTypes, nargout, name);
  }

  // Workspace dispatch — `.mtoc2.js` user functions, workspace
  // functions, class methods, etc. Without a workspace we can only
  // reach builtins (vitest unit-tests that hand-build a tiny env).
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
          return this.callUserFunction(fn, args, nargout, span);
        }
      }
    }
  }

  throw new UnsupportedConstruct(
    `interpreter: undefined identifier or function '${name}'`,
    span
  );
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
  span: Span
): RuntimeValue {
  if (h.kind === "named") {
    const out = this.callByName(h.name, args, 1, span);
    return out[0];
  }
  // Anonymous: bind params + captures in a child env.
  if (args.length !== h.params.length) {
    throw new UnsupportedConstruct(
      `interpreter: anonymous handle expects ${h.params.length} arg(s) ` +
        `(got ${args.length})`,
      span
    );
  }
  const child = new Environment();
  for (const [k, v] of Object.entries(h.captures)) child.set(k, v);
  for (let i = 0; i < h.params.length; i++) child.set(h.params[i], args[i]);
  const inner = new Interpreter(this.ctx, {
    env: child,
    ...(this.workspace !== undefined ? { workspace: this.workspace } : {}),
    currentFile: this.currentFile,
  });
  return inner.evalExpr(h.body as Expr);
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
      throw new UnsupportedConstruct(
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
    throw new UnsupportedConstruct(
      `'${fn.name}': too many arguments (${args.length} > ${fn.params.length})`,
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
  child.set("nargin", args.length);
  child.set("nargout", 1);
  const inner = new Interpreter(this.ctx, {
    env: child,
    ...(this.workspace !== undefined ? { workspace: this.workspace } : {}),
    currentFile: this.currentFile,
  });
  this.active.add(fn.name);
  try {
    inner.runProgram(fn.body);
  } finally {
    this.active.delete(fn.name);
  }
  const outName = fn.outputs[0];
  const result = outName !== undefined ? child.get(outName) : undefined;
  if (result === undefined) {
    throw new UnsupportedConstruct(
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
 *  parameters and returning the declared outputs. */
export function callUserFunction(
  this: Interpreter,
  fn: Extract<Stmt, { type: "Function" }>,
  args: RuntimeValue[],
  nargout: number,
  span: Span,
  sourceFile?: string
): RuntimeValue[] {
  if (this.active.has(fn.name)) {
    throw new UnsupportedConstruct(
      `interpreter: recursion is not yet implemented ('${fn.name}')`,
      span
    );
  }
  if (args.length > fn.params.length) {
    throw new UnsupportedConstruct(
      `'${fn.name}': too many arguments (${args.length} > ${fn.params.length})`,
      span
    );
  }
  const child = new Environment();
  for (let i = 0; i < args.length; i++) {
    child.set(fn.params[i], args[i]);
  }
  // Bind the pseudo-variables `nargin` and `nargout` so the body
  // can read them. Matches the c-aot path, which folds them at
  // lowering time into compile-time constants (the lowerer reads
  // them off the specialization key). Here they're just locals.
  child.set("nargin", args.length);
  child.set("nargout", nargout);
  const inner = new Interpreter(this.ctx, {
    env: child,
    ...(this.workspace !== undefined ? { workspace: this.workspace } : {}),
    currentFile: sourceFile ?? this.currentFile,
  });
  this.active.add(fn.name);
  try {
    inner.runProgram(fn.body);
  } finally {
    this.active.delete(fn.name);
  }
  // Return the requested nargout, clamped to what the function
  // actually declares. A 0-output function called as an expression
  // (`f()` at the top level of an ExprStmt) gets nargout=1 from the
  // expression evaluator; we honor that by returning [] and letting
  // the caller see undefined for the missing slot — ExprStmt drops
  // undefined, so the bare-statement form works naturally.
  const effective = Math.min(nargout, fn.outputs.length);
  const out: RuntimeValue[] = [];
  for (let i = 0; i < effective; i++) {
    const name = fn.outputs[i];
    const v = child.get(name);
    if (v === undefined) {
      throw new UnsupportedConstruct(
        `'${fn.name}': output '${name}' was never assigned`,
        span
      );
    }
    out.push(v);
  }
  return out;
}

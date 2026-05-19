/**
 * Variable scope for the interpreter. One frame for top-level
 * scripts; nested frames for user-function calls. Lookups walk the
 * chain; writes bind in the current frame only.
 */

import type { RuntimeValue } from "../runtime/value.js";

export class Environment {
  private vars = new Map<string, RuntimeValue>();
  private readonly parent?: Environment;

  constructor(parent?: Environment) {
    if (parent) this.parent = parent;
  }

  has(name: string): boolean {
    if (this.vars.has(name)) return true;
    if (this.parent) return this.parent.has(name);
    return false;
  }

  get(name: string): RuntimeValue | undefined {
    if (this.vars.has(name)) return this.vars.get(name);
    if (this.parent) return this.parent.get(name);
    return undefined;
  }

  /** Bind a name in the current frame. */
  set(name: string, value: RuntimeValue): void {
    this.vars.set(name, value);
  }

  /** Spawn a child frame whose lookups fall through to this one. */
  child(): Environment {
    return new Environment(this);
  }
}

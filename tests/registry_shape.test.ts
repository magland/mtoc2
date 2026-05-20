/**
 * Registry-shape invariants.
 *
 * mtoc2's three backends (interpreter, js-aot, c-aot) consume the same
 * builtin registry. The contract is: every registered builtin
 * implements `transfer` (required) plus the three optional hooks
 * `emitC` / `emitJs` / `call`. A builtin that can't yet support a
 * backend should declare an explicit hook that throws
 * `UnsupportedConstruct` with a builtin-specific message, rather
 * than leaving the hook undefined and letting the framework's
 * generic "internal: no emitJs hook" surface.
 *
 * These tests fail loudly the moment that contract is broken:
 *  - a builtin missing a hook (besselh-style structural gap)
 *  - a builtin whose `transfer` isn't a function (registration drift)
 *  - a registry mutation that produces duplicates
 *
 * Without this test the gap is silent until someone tries to call
 * the affected builtin on the right backend and gets a confusing
 * framework error.
 */

import { describe, it, expect } from "vitest";
import "../src/builtins/index.js";
import { allBuiltinNames, getBuiltin } from "../src/builtins/registry.js";

const NAMES = allBuiltinNames();

describe("builtin registry shape", () => {
  it("has at least the canonical core builtins registered", () => {
    // Sanity floor — if the registry is empty the import side-effect
    // didn't fire and every other test below would falsely pass.
    const core = [
      "plus",
      "minus",
      "times",
      "rdivide",
      "mtimes",
      "disp",
      "fprintf",
      "sum",
      "zeros",
      "ones",
      "size",
    ];
    for (const c of core) {
      expect(NAMES, `core builtin '${c}' missing`).toContain(c);
    }
  });

  it("contains no duplicate names", () => {
    const seen = new Set<string>();
    for (const n of NAMES) {
      expect(seen.has(n), `duplicate builtin name '${n}'`).toBe(false);
      seen.add(n);
    }
  });

  it.each(NAMES)("'%s' has a transfer function", name => {
    const b = getBuiltin(name);
    expect(b).toBeDefined();
    expect(typeof b!.transfer).toBe("function");
  });

  // Every builtin must implement all three backend hooks so the
  // framework never raises its generic "internal: no <hook> hook"
  // error. A backend-specific UnsupportedConstruct throw is fine —
  // and preferable to an undefined hook — because the user sees a
  // builtin-aware message.
  it.each(NAMES)("'%s' implements emitC", name => {
    const b = getBuiltin(name);
    expect(typeof b!.emitC, `'${name}' missing emitC`).toBe("function");
  });

  it.each(NAMES)("'%s' implements emitJs", name => {
    const b = getBuiltin(name);
    expect(typeof b!.emitJs, `'${name}' missing emitJs`).toBe("function");
  });

  it.each(NAMES)("'%s' implements call", name => {
    const b = getBuiltin(name);
    expect(typeof b!.call, `'${name}' missing call`).toBe("function");
  });
});

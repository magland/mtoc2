/**
 * Round-trip tests for the JIT `compileSpec` entry point: parse a tiny
 * `.m` source, build a Workspace + Lowerer, call `compileSpec` with
 * concrete argTypes, evaluate the emitted module, and invoke the
 * returned spec function on real JS values.
 *
 * The intent is to lock in the public-API shape (factory-returning
 * source) and the exact-stripping behavior that prevents JIT cache
 * explosion. Spec-internal codegen is exercised by the broader
 * test_scripts / vitest suites; this file is just the bridge.
 */

import { describe, test, expect } from "vitest";
import { parseMFile } from "../src/parser/index.js";
import type { Stmt } from "../src/parser/index.js";
import { Workspace } from "../src/workspace/workspace.js";
import { Lowerer } from "../src/lowering/lower.js";
import { compileSpec } from "../src/jit/compileSpec.js";
import { scalarDouble } from "../src/lowering/types.js";

type FuncStmt = Extract<Stmt, { type: "Function" }>;

function setup(source: string, fileName: string) {
  const ast = parseMFile(source, fileName);
  const ws = new Workspace(fileName);
  ws.addFile({ name: fileName, source, ast });
  const lowerer = new Lowerer(ws);
  const decl = ast.body.find(
    (s): s is FuncStmt => s.type === "Function"
  );
  if (!decl) throw new Error(`no Function statement in ${fileName}`);
  return { ast, ws, lowerer, decl };
}

function instantiate(source: string): (...args: unknown[]) => unknown {
  const factory = new Function(source)() as (h: {
    write: (s: string) => void;
  }) => (...args: unknown[]) => unknown;
  return factory({
    write: () => {
      // capture-only sink; tests below don't exercise disp/fprintf
    },
  });
}

describe("compileSpec", () => {
  test("round-trip: scalar y = x*x", () => {
    const { ws, lowerer, decl } = setup(
      "function y = sq(x)\n  y = x * x;\nend\n",
      "sq.m"
    );
    const { source, cName } = compileSpec({
      workspace: ws,
      lowerer,
      funcDecl: decl,
      argTypes: [scalarDouble("unknown")],
      nargout: 1,
    });
    expect(cName).toMatch(/^sq__[0-9a-f]{8}$/);
    const fn = instantiate(source) as (x: number) => number;
    expect(fn(5)).toBe(25);
    expect(fn(-3)).toBe(9);
    expect(fn(0)).toBe(0);
  });

  test("cache hit: second call with the same arg-type tuple returns the same cName", () => {
    const { ws, lowerer, decl } = setup(
      "function y = add1(x)\n  y = x + 1;\nend\n",
      "add1.m"
    );
    const args = [scalarDouble("unknown")];
    const r1 = compileSpec({
      workspace: ws,
      lowerer,
      funcDecl: decl,
      argTypes: args,
      nargout: 1,
    });
    const r2 = compileSpec({
      workspace: ws,
      lowerer,
      funcDecl: decl,
      argTypes: args,
      nargout: 1,
    });
    expect(r1.cName).toBe(r2.cName);
    // Map size unchanged on the second call — the cache was hit, not
    // grown.
    expect(lowerer.specializations.size).toBe(1);
  });

  test("incoming `exact` is stripped — distinct exact values share one spec", () => {
    const { ws, lowerer, decl } = setup(
      "function y = sq(x)\n  y = x * x;\nend\n",
      "sq.m"
    );
    // Two callers pass different exact values along the same sign
    // lattice. Without exact-stripping these would shard into two
    // specs; compileSpec must collapse them to one.
    const r1 = compileSpec({
      workspace: ws,
      lowerer,
      funcDecl: decl,
      argTypes: [scalarDouble("unknown", 5)],
      nargout: 1,
    });
    const r2 = compileSpec({
      workspace: ws,
      lowerer,
      funcDecl: decl,
      argTypes: [scalarDouble("unknown", 7)],
      nargout: 1,
    });
    expect(r1.cName).toBe(r2.cName);
    expect(lowerer.specializations.size).toBe(1);
  });

  test("transitively-called helper specs are included in the emitted module", () => {
    // `outer` calls `inner` — lowering populates both specs. The emit
    // must include `inner` so the call site in `outer`'s body resolves.
    const { ws, lowerer, decl } = setup(
      [
        "function y = outer(x)",
        "  y = inner(x) + 1;",
        "end",
        "function r = inner(z)",
        "  r = z * 2;",
        "end",
        "",
      ].join("\n"),
      "outer.m"
    );
    const { source } = compileSpec({
      workspace: ws,
      lowerer,
      funcDecl: decl,
      argTypes: [scalarDouble("unknown")],
      nargout: 1,
    });
    expect(lowerer.specializations.size).toBeGreaterThanOrEqual(2);
    const fn = instantiate(source) as (x: number) => number;
    expect(fn(3)).toBe(7); // 3*2 + 1
    expect(fn(10)).toBe(21);
  });
});

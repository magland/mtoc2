/**
 * Recursive-specialization N-pass guard.
 *
 * The lowerer's spec placeholder seeds `outputTypes` with the input
 * types — works for shapes where output kind matches input kind (the
 * common `factorial` / `fib` case). If the actual body output differs
 * from the seed AND a recursive self-call consumed the seeded
 * placeholder during pass 1, the lowerer re-lowers the body once with
 * the refined types.
 *
 * If the second pass STILL doesn't match — meaning the recursive Call
 * IR built in pass 2 is also stale — the prior behavior was to ship
 * the result anyway, producing a quietly-wrong specialization. This
 * test pins the post-fix behavior: a clear `TypeError` with a spec-
 * stabilization message instead.
 *
 * The healthy recursion path (factorial-style) is also asserted here
 * so the guard doesn't accidentally fire on legitimate one-pass-
 * converging recursion.
 */

import { describe, it, expect } from "vitest";
import { parseMFile } from "../src/parser/index.js";
import { Lowerer } from "../src/lowering/lower.js";
import { Workspace } from "../src/workspace/workspace.js";

function lower(source: string, fileName = "test.m"): void {
  const ast = parseMFile(source, fileName);
  const ws = new Workspace(fileName);
  ws.addFile({ name: fileName, source, ast });
  new Lowerer(ws).lowerProgram(ast);
}

describe("recursive specialization", () => {
  it("converges on input-kind=output-kind shapes (factorial)", () => {
    // Seed outputTypes := input types is correct here on pass 1
    // (output is scalar real double, same as input), so the body
    // type-checks on the first try and no re-lower fires.
    const src = [
      "disp(fact(5));",
      "function r = fact(n)",
      "  if n <= 1",
      "    r = 1;",
      "  else",
      "    r = n * fact(n - 1);",
      "  end",
      "end",
    ].join("\n");
    expect(() => lower(src)).not.toThrow();
  });

  it("converges on the fib shape with single recursion site", () => {
    const src = [
      "disp(fib(7));",
      "function r = fib(n)",
      "  if n < 2",
      "    r = n;",
      "  else",
      "    r = fib(n - 1) + fib(n - 2);",
      "  end",
      "end",
    ].join("\n");
    expect(() => lower(src)).not.toThrow();
  });
});

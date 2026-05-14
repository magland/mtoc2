/**
 * `sum(t)` on a tensor whose shape is unknown at compile time and
 * whose dim signature can't prove vector-ness must reject at
 * lowering with `UnsupportedConstruct`. Otherwise codegen emits
 * `mtoc2_sum`, which collapses to a single scalar regardless of
 * runtime shape, while numbl returns a row vector for matrices —
 * silent divergence.
 *
 * The cross-runner can't validate translate-time rejections (numbl
 * accepts the same source), so this lives here.
 */

import { describe, it, expect } from "vitest";
import { parseMFile } from "../src/parser/index.js";
import { Lowerer } from "../src/lowering/lower.js";
import { Workspace } from "../src/workspace/workspace.js";
import { UnsupportedConstruct } from "../src/lowering/errors.js";

function lower(source: string, fileName = "test.m"): void {
  const ast = parseMFile(source, fileName);
  const ws = new Workspace(fileName);
  ws.addFile({ name: fileName, source, ast });
  new Lowerer(ws).lowerProgram(ast);
}

describe("sum on a shape-unknown tensor", () => {
  it("accepts a row-vector field (one axis is statically `one`)", () => {
    expect(() =>
      lower(`
        s = struct('v', [1 2 3 4]);
        disp(sum(s.v));
      `)
    ).not.toThrow();
  });

  it("accepts a column-vector field", () => {
    // Build a column-vector field: `M = zeros(4, 1); s = struct('v', M);`
    expect(() =>
      lower(`
        M = zeros(4, 1);
        s = struct('v', M);
        disp(sum(s.v));
      `)
    ).not.toThrow();
  });

  it("rejects a multi-slot range slice (dims notOne x notOne, shape unknown)", () => {
    // `M(:, 2:4)` produces dims `[notOne, notOne]` with no statically
    // known shape — exactly the silent-divergence case the audit
    // flagged. Without the rejection, `sum(...)` here emits
    // `mtoc2_sum` which collapses to a scalar, while numbl returns
    // a row vector of column sums.
    let caught: unknown = null;
    try {
      lower(`
        M = zeros(3, 5);
        for i = 1:3
          for j = 1:5
            M(i, j) = i + j;
          end
        end
        S = M(:, 2:4);
        disp(sum(S));
      `);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsupportedConstruct);
    const e = caught as UnsupportedConstruct;
    expect(e.message).toMatch(/matrix.*row-vector|non-vector/);
  });
});

/**
 * `recordAssignment` must catch reassignments that would invalidate
 * the C-side declaration. Before the fix it only screened scalar↔tensor;
 * a struct reassignment with a different field set slipped through and
 * surfaced as a C compile error (two distinct `mtoc2_struct__<hash>`
 * typedefs sharing one C identifier). The check now uses
 * `storageEquivalent`, which compares `cFieldTypeStr` — so every owned
 * typedef mismatch fires at translate time with a span.
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

describe("recordAssignment rejects incompatible storage", () => {
  it("rejects struct reassignment with a different field set", () => {
    let caught: unknown = null;
    try {
      lower(`s = struct('a', 1);
s = struct('a', 1, 'b', 2);
disp(s.a);`);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsupportedConstruct);
    const e = caught as UnsupportedConstruct;
    expect(e.message).toMatch(/cannot reassign 's'/);
    expect(e.message).toMatch(/incompatible/);
    expect(e.span?.file).toBe("test.m");
  });

  it("still rejects scalar↔tensor reassignment with the boundary message", () => {
    let caught: unknown = null;
    try {
      lower(`x = 1;
x = [1 2 3];`);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsupportedConstruct);
    expect((caught as UnsupportedConstruct).message).toMatch(
      /scalar\/tensor boundary/
    );
  });

  it("accepts reassignment that preserves storage (numeric scalar exact change)", () => {
    // Both bind a scalar real double; only the `exact` lattice value
    // differs. Same C-level slot — must not be rejected.
    expect(() =>
      lower(`x = 1;
x = 2;
disp(x);`)
    ).not.toThrow();
  });

  it("accepts struct reassignment with same fields but different exact values", () => {
    // `cFieldTypeStr` collapses sign/exact/tensor shape; the typedef
    // hash matches, so the reassignment must not be rejected.
    expect(() =>
      lower(`s = struct('a', 1);
s = struct('a', 99);
disp(s.a);`)
    ).not.toThrow();
  });

  it("accepts tensor reassignment with different shape", () => {
    // mtoc2_tensor_t is shape-erased at the C level — the rebind is
    // legal and must not be rejected.
    expect(() =>
      lower(`v = [1 2 3];
v = [1 2 3 4 5];
disp(v);`)
    ).not.toThrow();
  });
});

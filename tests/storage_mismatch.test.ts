/**
 * `recordAssignment` handles a reassignment whose new value can't share
 * the prior binding's C variable (different struct field set,
 * scalar↔tensor, char↔double, ...). At the top level of a scope it
 * SPLITS — allocating a fresh `_mtoc2_<cName>__v<N>` local and repointing
 * the name at it — so the program type-checks and the predeclare walk
 * (keyed by cName) declares each binding independently. Inside non-folded
 * control flow it can't split (the branch / loop env merge keeps one
 * cName per name), so it throws `UnsupportedConstruct` with a span.
 *
 * `storageEquivalent` (comparing `cFieldTypeStr`) decides "incompatible":
 * an owned typedef mismatch — e.g. two distinct `mtoc2_struct__<hash>` —
 * triggers a split / throw rather than two typedefs sharing one C
 * identifier (which used to surface as a C compile error).
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

describe("recordAssignment splits incompatible storage at top level", () => {
  it("splits a struct reassignment with a different field set", () => {
    expect(() =>
      lower(`s = struct('a', 1);
s = struct('a', 1, 'b', 2);
disp(s.b);`)
    ).not.toThrow();
  });

  it("splits a scalar↔tensor reassignment", () => {
    expect(() =>
      lower(`x = 1;
x = [1 2 3];
disp(x);`)
    ).not.toThrow();
  });

  it("splits a char↔double reassignment", () => {
    expect(() =>
      lower(`x = 'hello';
disp(x);
x = 5;
disp(x);`)
    ).not.toThrow();
  });
});

describe("recordAssignment rejects incompatible storage inside control flow", () => {
  it("rejects a scalar↔tensor reassignment inside a non-folded branch", () => {
    let caught: unknown = null;
    try {
      lower(`x = 1;
%!numbl:opaque x
if x > 0
  x = [1 2 3];
end`);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsupportedConstruct);
    const e = caught as UnsupportedConstruct;
    expect(e.message).toMatch(/scalar\/tensor boundary/);
    expect(e.message).toMatch(/inside control flow/);
    expect(e.span?.file).toBe("test.m");
  });

  it("rejects a char↔double reassignment inside a non-folded branch", () => {
    let caught: unknown = null;
    try {
      lower(`x = 'hi';
n = numel([1 2 3]);
%!numbl:opaque n
if n > 0
  x = 5;
end`);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsupportedConstruct);
    expect((caught as UnsupportedConstruct).message).toMatch(
      /incompatible.*inside control flow/s
    );
  });
});

describe("recordAssignment accepts storage-preserving reassignment", () => {
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

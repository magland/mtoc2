/**
 * Tensor pass-by-value semantics in the interpreter.
 *
 * MATLAB binds parameters and ordinary assignments by value: an
 * indexed write through one alias must not be visible through any
 * other alias. The interpreter (which has no refcounting) used to
 * mutate `RuntimeTensor.data` in place, which silently aliased the
 * buffer across:
 *
 *   - function parameters: `function fn(x); x(i) = v; end` with
 *     `a = [1 2 3]; fn(a);` mutated the caller's `a`,
 *   - simple aliasing: `b = a; b(i) = v;` mutated `a`,
 *   - struct field reads: `s.f` returning `t` then `t(i) = v` would
 *     mutate `s.f`'s tensor in place.
 *
 * The fix clones the tensor's data (and imag, if complex) and
 * rebinds the lvalue's env entry to the fresh copy before any write
 * happens. These tests pin that behavior.
 *
 * The cross-runner doesn't yet catch these because none of the
 * topic scripts exercise post-write inspection of the aliased
 * binding — the interpreter passed by coincidence, not contract.
 */

import { describe, it, expect } from "vitest";
import { parseMFile } from "../src/parser/index.js";
import { Workspace } from "../src/workspace/workspace.js";
import { Interpreter } from "../src/interpreter/interpreter.js";

function runScript(source: string, fileName = "test.m"): string {
  const ast = parseMFile(source, fileName);
  const ws = new Workspace(fileName);
  ws.addFile({ name: fileName, source, ast });
  ws.finalize();
  let out = "";
  const ctx = { helpers: { write: (s: string) => (out += s) } };
  new Interpreter(ctx, { workspace: ws, currentFile: fileName }).runProgram(
    ast.body
  );
  return out;
}

describe("interpreter tensor pass-by-value", () => {
  it("indexed write through a function param does not mutate the caller", () => {
    // The call `mutate(a)` binds `x` to the same RuntimeTensor object
    // as `a`. Pre-fix, `x(2) = 99` wrote into `a.data[1]` and the
    // post-call `disp(a)` showed `1 99 3`. Post-fix, `disp(a)` shows
    // the original `1 2 3`.
    const out = runScript(
      [
        "a = [1 2 3];",
        "mutate(a);",
        "disp(a);",
        "function mutate(x)",
        "  x(2) = 99;",
        "end",
      ].join("\n")
    );
    expect(out).toContain("1");
    expect(out).toContain("2");
    expect(out).toContain("3");
    expect(out).not.toContain("99");
  });

  it("indexed write through a simple alias does not mutate the original", () => {
    // `b = a` binds `b` to the same RuntimeTensor. `b(1) = 999` must
    // leave `a` at its construction values.
    const out = runScript(
      ["a = [10 20 30];", "b = a;", "b(1) = 999;", "disp(a);"].join("\n")
    );
    expect(out).toContain("10");
    expect(out).toContain("20");
    expect(out).toContain("30");
    expect(out).not.toContain("999");
  });

  it("indexed write into an aliased var reflects the new value on that name", () => {
    // Positive case: the write IS visible through the binding it
    // was performed on. (Without this assertion the cloning logic
    // could no-op and still pass the negative tests above.)
    const out = runScript(
      ["a = [10 20 30];", "b = a;", "b(1) = 999;", "disp(b);"].join("\n")
    );
    expect(out).toContain("999");
    expect(out).toContain("20");
    expect(out).toContain("30");
  });
});

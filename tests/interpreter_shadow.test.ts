/**
 * MATLAB function precedence in the interpreter.
 *
 * Numbl's `resolveFunction` (used by the workspace adapter) applies
 * the full MATLAB precedence rule: local function in the current
 * file > workspace functions / packages > class methods > builtins.
 * A user `disp.m` in the workspace must shadow the global `disp`
 * builtin for any call site in that workspace.
 *
 * The interpreter used to check the global builtin registry FIRST
 * and only fall through to `workspace.resolve` on a miss — so a
 * shadowed builtin was silently never shadowed. This test pins the
 * post-fix behavior and protects the precedence contract documented
 * in CLAUDE.md ("The interpreter uses the same Workspace.resolve
 * path the lowerer does").
 */

import { describe, it, expect } from "vitest";
import { parseMFile } from "../src/parser/index.js";
import { Workspace } from "../src/workspace/workspace.js";
import { Interpreter } from "../src/interpreter/interpreter.js";

function runWorkspace(mainFile: string, files: Record<string, string>): string {
  const ws = new Workspace(mainFile);
  for (const [name, source] of Object.entries(files)) {
    const ast = parseMFile(source, name);
    ws.addFile({ name, source, ast });
  }
  ws.finalize();
  let out = "";
  const ctx = { helpers: { write: (s: string) => (out += s) } };
  const mainAst = ws.files.get(mainFile)!.ast!;
  new Interpreter(ctx, { workspace: ws, currentFile: mainFile }).runProgram(
    mainAst.body
  );
  return out;
}

describe("interpreter MATLAB function precedence", () => {
  it("a workspace function named like a builtin shadows the builtin", () => {
    // `disp.m` defines a user `disp` that writes `SHADOWED <x>` to
    // stdout instead of the builtin's auto-format. Pre-fix, the
    // interpreter called the global builtin `disp` and the user's
    // function never ran.
    const out = runWorkspace("main.m", {
      "main.m": "disp(42);",
      "disp.m": [
        "function disp(x)",
        "  fprintf('SHADOWED %d\\n', x);",
        "end",
      ].join("\n"),
    });
    expect(out).toBe("SHADOWED 42\n");
  });

  it("a workspace function name that is NOT a builtin still resolves", () => {
    // Sanity check: ordinary workspace dispatch (no shadow) is
    // unaffected by the reorder.
    const out = runWorkspace("main.m", {
      "main.m": "greet();",
      "greet.m": ["function greet()", "  fprintf('hello\\n');", "end"].join(
        "\n"
      ),
    });
    expect(out).toBe("hello\n");
  });

  it("a name with no workspace function falls through to the builtin", () => {
    // Sanity check: the registry fallback still fires for unshadowed
    // builtins so the bulk of the call sites (every `disp`, `sum`,
    // `fprintf`, ...) keeps working.
    const out = runWorkspace("main.m", { "main.m": "disp(7);" });
    expect(out).toContain("7");
  });
});

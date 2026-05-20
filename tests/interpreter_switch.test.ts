/**
 * Tree-walking interpreter `switch` coverage.
 *
 * The interpreter is supposed to be the always-available execution
 * path and mirror numbl's semantics. `switch` is one of the AST node
 * kinds it was missing — the lowerer (c-aot / js-aot) still rejects
 * it for now, so cross-runner coverage isn't yet possible; this
 * vitest pins the interpreter's behavior directly.
 *
 * Match rules mirror numbl's `switchValuesMatch` / `valuesAreEqual`:
 *  - numeric / logical scalars via `===`,
 *  - char ↔ string ↔ char tensor equality by inner text,
 *  - tensor equality by element data + matching imag (no shape check),
 *  - falls through to the `otherwise` body when no case matches,
 *  - at most one case body executes (no C-style fall-through).
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

describe("interpreter Switch", () => {
  it("dispatches on a scalar numeric case", () => {
    const out = runScript(
      [
        "x = 2;",
        "switch x",
        "  case 1; disp(10);",
        "  case 2; disp(20);",
        "  case 3; disp(30);",
        "end",
      ].join("\n")
    );
    expect(out).toContain("20");
    expect(out).not.toContain("10");
    expect(out).not.toContain("30");
  });

  it("falls through to otherwise when no case matches", () => {
    const out = runScript(
      [
        "x = 99;",
        "switch x",
        "  case 1; disp(1);",
        "  case 2; disp(2);",
        "  otherwise; disp(0);",
        "end",
      ].join("\n")
    );
    expect(out).toContain("0");
  });

  it("matches char-quoted strings against same text", () => {
    const out = runScript(
      [
        "tag = 'b';",
        "switch tag",
        "  case 'a'; disp(1);",
        "  case 'b'; disp(2);",
        "  case 'c'; disp(3);",
        "end",
      ].join("\n")
    );
    expect(out).toContain("2");
  });

  it("treats char and string with the same inner text as equal", () => {
    // numbl `switchValuesMatch` collapses across the two text kinds.
    const out = runScript(
      [
        'tag = "hi";',
        "switch tag",
        "  case 'hi'; disp(7);",
        "  otherwise; disp(0);",
        "end",
      ].join("\n")
    );
    expect(out).toContain("7");
  });

  it("executes at most one case body (no fall-through)", () => {
    const out = runScript(
      [
        "x = 1;",
        "switch x",
        "  case 1; disp(1);",
        "  case 1; disp(2);", // would match too, must NOT run
        "end",
      ].join("\n")
    );
    expect(out).toContain("1");
    expect(out).not.toContain("2");
  });

  it("returns silently when no case matches and otherwise is absent", () => {
    const out = runScript(
      [
        "x = 5;",
        "disp(0);",
        "switch x",
        "  case 1; disp(99);",
        "  case 2; disp(98);",
        "end",
      ].join("\n")
    );
    // Only the leading `disp(0)` should have produced output.
    expect(out).toContain("0");
    expect(out).not.toContain("99");
    expect(out).not.toContain("98");
  });

  it("respects break inside a case body when nested in a loop", () => {
    // `break` inside a case escapes the enclosing loop, not the switch.
    // The interpreter's `Switch` doesn't catch BreakSignal, so the
    // break propagates out to the surrounding For.
    const out = runScript(
      [
        "for k = 1:5",
        "  switch k",
        "    case 3; disp(100); break;",
        "  end",
        "  disp(k);",
        "end",
      ].join("\n")
    );
    // 1, 2 print their `k`, then case 3 hits break (skips `disp(k)`
    // for k=3 and exits the loop entirely). 100 prints once.
    expect(out).toContain("1\n");
    expect(out).toContain("2\n");
    expect(out).toContain("100");
    expect(out).not.toContain("4\n");
    expect(out).not.toContain("5\n");
  });
});

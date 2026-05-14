/**
 * Unit tests for the type-introspection directives:
 *   - `%!numbl:showtype` emits a `/_ type ... _/` comment in the
 *     generated C at the directive's source position.
 *   - `%!numbl:printtype` writes the same snapshot to stderr at
 *     compile time (one line per entry, per specialization).
 *
 * The cross-runner can't validate either (showtype only affects C
 * comments; printtype only writes to a side channel), so vitest is
 * the right home for pinning the format.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseMFile } from "../src/parser/index.js";
import {
  Lowerer,
  setPrintTypeSink,
  resetPrintTypeSink,
} from "../src/lowering/lower.js";
import { emitProgram } from "../src/codegen/emit.js";

function translate(source: string, fileName = "test.m"): string {
  const ast = parseMFile(source, fileName);
  const lowerer = new Lowerer(source);
  const prog = lowerer.lowerProgram(ast);
  return emitProgram(prog);
}

describe("%!numbl:showtype", () => {
  it("emits a comment with the snapshotted type for a scalar with exact", () => {
    const src = ["x = 2 + 3;", "%!numbl:showtype x", "disp(x);"].join("\n");
    const c = translate(src);
    expect(c).toContain("/* type x (x) :: double[1×1]:positive=5 */");
  });

  it("reflects exact-stripping done by a prior `%!numbl:opaque`", () => {
    const src = [
      "x = 7;",
      "%!numbl:opaque x",
      "%!numbl:showtype x",
      "disp(x);",
    ].join("\n");
    const c = translate(src);
    // `opaque` drops `exact` but retains the `sign` lattice entry, so
    // the snapshot still shows `:positive` — but no `=7`.
    expect(c).toContain("/* type x (x) :: double[1×1]:positive */");
    expect(c).not.toMatch(/type x \([^)]+\) :: double\[1×1\][^*]*=7/);
  });

  it("fires once per function specialization with each spec's param type", () => {
    const src = [
      "disp(sq(3));",
      "disp(sq(5));",
      "function y = sq(x)",
      "  %!numbl:showtype x",
      "  y = x * x;",
      "end",
    ].join("\n");
    const c = translate(src);
    expect(c).toContain("/* type x (x) :: double[1×1]:positive=3 */");
    expect(c).toContain("/* type x (x) :: double[1×1]:positive=5 */");
  });

  it("throws on an unknown variable, with span pointing at the directive", () => {
    const src = ["x = 1;", "%!numbl:showtype y", "disp(x);"].join("\n");
    expect(() => translate(src)).toThrowError(
      /'%!numbl:showtype' references unknown variable 'y'/
    );
  });

  it("snapshots an owned-tensor type without affecting codegen", () => {
    const src = [
      "a = [1 2 3];",
      "%!numbl:opaque a",
      "%!numbl:showtype a",
      "disp(a);",
    ].join("\n");
    const c = translate(src);
    // The snapshotted type is rendered with the runtime shape and
    // (with exact stripped by opaque) no `=...` payload.
    expect(c).toMatch(/\/\* type a \([^)]+\) :: double\[1×3\] \*\//);
  });
});

describe("%!numbl:printtype", () => {
  const lines: string[] = [];

  beforeEach(() => {
    lines.length = 0;
    setPrintTypeSink(line => lines.push(line));
  });
  afterEach(() => {
    resetPrintTypeSink();
  });

  it("emits one stderr line per entry, with file:line:col + type", () => {
    const src = ["x = 2 + 3;", "%!numbl:printtype x", "disp(x);"].join("\n");
    translate(src, "demo.m");
    expect(lines).toEqual(["demo.m:2:1: type x :: double[1×1]:positive=5"]);
  });

  it("emits no C-level artifact (only the side-channel line)", () => {
    const src = ["x = 1;", "%!numbl:printtype x", "disp(x);"].join("\n");
    const c = translate(src);
    expect(c).not.toContain("type x");
  });

  it("fires once per function specialization", () => {
    const src = [
      "disp(sq(3));",
      "disp(sq(5));",
      "function y = sq(x)",
      "  %!numbl:printtype x",
      "  y = x * x;",
      "end",
    ].join("\n");
    translate(src, "demo.m");
    // Two specializations of `sq` → two stderr lines.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^demo\.m:4:3: type x :: double\[1×1\]:positive=3$/
    );
    expect(lines[1]).toMatch(
      /^demo\.m:4:3: type x :: double\[1×1\]:positive=5$/
    );
  });

  it("supports multiple names in a single directive", () => {
    const src = [
      "a = 1;",
      "b = 2 + 3;",
      "%!numbl:printtype a b",
      "disp(a + b);",
    ].join("\n");
    translate(src, "demo.m");
    expect(lines).toEqual([
      "demo.m:3:1: type a :: double[1×1]:positive=1",
      "demo.m:3:1: type b :: double[1×1]:positive=5",
    ]);
  });

  it("throws on an unknown variable", () => {
    const src = ["x = 1;", "%!numbl:printtype y"].join("\n");
    expect(() => translate(src, "demo.m")).toThrowError(
      /'%!numbl:printtype' references unknown variable 'y'/
    );
  });
});

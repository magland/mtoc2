/**
 * Driver-script `addpath` prologue: accept / reject cases.
 *
 * The cross-runner only validates the happy path
 * ([test_scripts/addpath_basics/](../test_scripts/addpath_basics/)).
 * The rejection cases (call inside a function body, non-literal arg,
 * `rmpath` / `savepath`, etc.) hit code paths the runner doesn't
 * exercise, so they live here.
 */
import { describe, it, expect } from "vitest";
import { parseMFile } from "../src/parser/index.js";
import { extractDriverPrologue } from "../src/workspace/driverPrologue.js";
import { translateProject } from "../src/translate.js";
import { UnsupportedConstruct } from "../src/lowering/errors.js";

function extract(
  source: string,
  opts: { allowAddpath?: boolean } = {}
): ReturnType<typeof extractDriverPrologue> {
  const ast = parseMFile(source, "drv.m");
  return extractDriverPrologue(ast, opts);
}

describe("extractDriverPrologue — accept cases", () => {
  it("returns a single addpath dir at the begin position", () => {
    const r = extract("addpath('foo');\nx = 1;\n", { allowAddpath: true });
    expect(r.addpaths).toEqual([
      expect.objectContaining({ dir: "foo", position: "begin" }),
    ]);
    expect(r.remainingBody).toHaveLength(1);
  });

  it("handles multi-arg addpath with the trailing -end flag", () => {
    const r = extract("addpath('a', 'b', '-end');\n", { allowAddpath: true });
    expect(r.addpaths.map(a => ({ dir: a.dir, position: a.position }))).toEqual(
      [
        { dir: "a", position: "end" },
        { dir: "b", position: "end" },
      ]
    );
  });

  it("preserves source order across multiple addpath calls", () => {
    const r = extract("addpath('a');\naddpath('b','-end');\naddpath('c');\n", {
      allowAddpath: true,
    });
    expect(r.addpaths.map(a => ({ dir: a.dir, position: a.position }))).toEqual(
      [
        { dir: "a", position: "begin" },
        { dir: "b", position: "end" },
        { dir: "c", position: "begin" },
      ]
    );
  });

  it("accepts double-quoted string literals", () => {
    const r = extract('addpath("foo");\n', { allowAddpath: true });
    expect(r.addpaths[0].dir).toBe("foo");
  });

  it("strips the addpath stmt from remainingBody", () => {
    const r = extract("addpath('foo');\ny = 2;\ndisp(y);\n", {
      allowAddpath: true,
    });
    expect(r.remainingBody).toHaveLength(2);
    expect(r.remainingBody[0].type).toBe("Assign");
  });

  it("returns the full body when there is no addpath prologue", () => {
    const r = extract("x = 1;\naddpath('foo');\n", { allowAddpath: true });
    expect(r.addpaths).toEqual([]);
    expect(r.remainingBody).toHaveLength(2);
  });
});

describe("extractDriverPrologue — reject cases", () => {
  it("rejects addpath when allowAddpath is false (web IDE case)", () => {
    expect(() => extract("addpath('foo');\n")).toThrow(UnsupportedConstruct);
  });

  it("rejects a non-literal addpath argument", () => {
    expect(() =>
      extract("p = 'foo';\naddpath(p);\n", { allowAddpath: true })
    ).not.toThrow(); // addpath isn't at the prologue here; it's after an assign
    expect(() => extract("addpath(p);\n", { allowAddpath: true })).toThrow(
      /literal strings/
    );
  });

  it("rejects a zero-arg addpath", () => {
    expect(() => extract("addpath();\n", { allowAddpath: true })).toThrow(
      /at least 1/
    );
  });

  it("rejects -end / -begin in a non-trailing position", () => {
    expect(() =>
      extract("addpath('-end', 'a');\n", { allowAddpath: true })
    ).toThrow(/may only appear as the last/);
  });
});

describe("addpath outside the prologue — rejected at lowering", () => {
  // translateProject runs the prologue extractor before lowering,
  // then any addpath left in the AST hits the builtin's `transfer`,
  // which throws `UnsupportedConstruct` with a span. Using the
  // default `allowAddpath: false` so we test the "in-memory translate
  // without a filesystem" path consistently.
  it("flags addpath inside a function body", () => {
    const src = [
      "x = 1;",
      "f();",
      "function f()",
      "  addpath('foo');",
      "end",
    ].join("\n");
    const result = translateProject([{ name: "drv.m", source: src }], "drv.m");
    expect(result.error?.kind).toBe("UnsupportedConstruct");
    expect(result.error?.message).toMatch(/addpath/);
  });

  it("flags addpath that appears after a non-comment top-level stmt", () => {
    const src = ["x = 1;", "addpath('foo');"].join("\n");
    const result = translateProject([{ name: "drv.m", source: src }], "drv.m");
    expect(result.error?.kind).toBe("UnsupportedConstruct");
    expect(result.error?.message).toMatch(/addpath/);
  });

  it("rejects rmpath even at the very top of the driver", () => {
    const src = ["rmpath('foo');"].join("\n");
    const result = translateProject([{ name: "drv.m", source: src }], "drv.m");
    expect(result.error?.kind).toBe("UnsupportedConstruct");
    expect(result.error?.message).toMatch(/rmpath/);
  });

  it("rejects savepath", () => {
    const src = ["savepath();"].join("\n");
    const result = translateProject([{ name: "drv.m", source: src }], "drv.m");
    expect(result.error?.kind).toBe("UnsupportedConstruct");
    expect(result.error?.message).toMatch(/savepath/);
  });
});

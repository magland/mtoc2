/**
 * Snippet-activation regression: when a builtin's scalar emit-C path
 * references a `mtoc2_`-prefixed helper, the corresponding runtime
 * snippet must activate so the helper's definition is included in
 * the emitted C.
 *
 * The bug this guards against: `defineUnaryRealMath` /
 * `defineElemwiseRealBinaryFn` only activated the runtime snippet
 * on the TENSOR path, so a script using only the scalar form
 * (e.g. `disp(mod(7, 3))`, `disp(round(0.5))`, `disp(sign(5))`)
 * produced C that called undefined functions and failed at `cc`
 * with "implicit declaration of function 'mtoc2_mod_real'".
 *
 * Existing test_scripts didn't catch this because they intermix
 * scalar and tensor uses; the tensor path coincidentally activated
 * the helper. These vitest cases isolate the scalar form so a
 * future refactor can't silently reintroduce the bug.
 */

import { describe, it, expect } from "vitest";
import { parseMFile } from "../src/parser/index.js";
import { Lowerer } from "../src/lowering/lower.js";
import { emitProgram } from "../src/codegen/emit.js";
import { Workspace } from "../src/workspace/workspace.js";

function translate(source: string): string {
  const ast = parseMFile(source, "test.m");
  const ws = new Workspace("test.m");
  ws.addFile({ name: "test.m", source, ast });
  return emitProgram(new Lowerer(ws).lowerProgram(ast));
}

describe("scalar emit activates the matching runtime helper", () => {
  it("scalar mod activates mtoc2_mod_real", () => {
    // Opaque the args so the transfer-time fold doesn't collapse the
    // call to a literal — we want the runtime helper invocation to
    // appear in the emitted C.
    const src = [
      "a = 7;",
      "b = 3;",
      "%!numbl:opaque a",
      "%!numbl:opaque b",
      "disp(mod(a, b));",
    ].join("\n");
    const c = translate(src);
    expect(c).toContain("mtoc2_mod_real(");
    // Definition must be present — without it `cc` errors with
    // "implicit declaration of function 'mtoc2_mod_real'".
    expect(c).toMatch(/static\s+double\s+mtoc2_mod_real\s*\(/);
  });

  it("scalar round activates mtoc2_round_half_away", () => {
    const src = ["x = -0.5;", "%!numbl:opaque x", "disp(round(x));"].join("\n");
    const c = translate(src);
    expect(c).toContain("mtoc2_round_half_away(");
    expect(c).toMatch(/static\s+double\s+mtoc2_round_half_away\s*\(/);
  });

  it("scalar sign activates mtoc2_signum", () => {
    const src = ["x = -3;", "%!numbl:opaque x", "disp(sign(x));"].join("\n");
    const c = translate(src);
    expect(c).toContain("mtoc2_signum(");
    expect(c).toMatch(/static\s+double\s+mtoc2_signum\s*\(/);
  });

  it("scalar atan2 / hypot don't gratuitously activate the tensor snippet", () => {
    // Counter-test: libc functions (`atan2`, `hypot`) are declared
    // via `<math.h>`, so they SHOULD NOT pull in the elemwise tensor
    // snippet on a scalar-only call site. This guards against an
    // over-eager activation that would bloat every scalar-math
    // emission.
    const src = [
      "a = 1;",
      "b = 1;",
      "%!numbl:opaque a",
      "%!numbl:opaque b",
      "disp(atan2(a, b));",
      "disp(hypot(a, b));",
    ].join("\n");
    const c = translate(src);
    expect(c).toContain("atan2(");
    expect(c).toContain("hypot(");
    // The tensor-elemwise snippet defines `mtoc2_tensor_atan2_tt` etc.
    // Those should NOT appear when only scalar forms are used.
    expect(c).not.toContain("mtoc2_tensor_atan2_tt");
    expect(c).not.toContain("mtoc2_tensor_hypot_tt");
  });
});

/**
 * Per-function specialization cap. Exact-value tracking in the
 * type system shards each user function's spec cache by arg value,
 * so a value-keyed call site (`sq(1) + sq(2) + ... + sq(N)`) can
 * grow without bound. The lowerer caps this with a clean error
 * rather than letting the spec map and emitted code bloat silently.
 *
 * The cap defaults to 256 and reads `MTOC2_MAX_SPECS_PER_FUNCTION`
 * once at module load — these tests trigger it at a smaller
 * effective ceiling by spamming distinct exact-arg specs and
 * checking the error message.
 */

import { describe, it, expect } from "vitest";
import { parseMFile } from "../src/parser/index.js";
import { Lowerer } from "../src/lowering/lower.js";
import { Workspace } from "../src/workspace/workspace.js";
import { UnsupportedConstruct } from "../src/lowering/errors.js";

function lower(source: string, fileName = "test.m"): Lowerer {
  const ast = parseMFile(source, fileName);
  const ws = new Workspace(fileName);
  ws.addFile({ name: fileName, source, ast });
  const lw = new Lowerer(ws);
  lw.lowerProgram(ast);
  return lw;
}

function makeProgramWith(uniqueSpecs: number): string {
  // Each `disp(sq(N))` carries a distinct exact arg, so each shards
  // into its own specialization. `sq` is declared once at the top.
  const calls: string[] = [];
  for (let i = 1; i <= uniqueSpecs; i++) {
    calls.push(`disp(sq(${i}));`);
  }
  return [`function y = sq(x)`, `  y = x * x;`, `end`, ``, ...calls, ``].join(
    "\n"
  );
}

describe("per-function specialization cap", () => {
  it("allows specs up to the default ceiling (256)", () => {
    // 200 distinct specs sits well below the 256 default — this should
    // lower cleanly. Verifies the cap doesn't fire on reasonable
    // value-keyed code.
    const lw = lower(makeProgramWith(200));
    // sq has exactly 200 specs; the spec map also contains nothing
    // else for this program, so total = 200.
    expect(lw.specializations.size).toBe(200);
  });

  it("aborts with UnsupportedConstruct beyond the cap", () => {
    // 300 distinct specs crosses the default 256 ceiling on call #257.
    // The error should name the offending function and explain the
    // workaround (opaque + env var).
    let err: unknown;
    try {
      lower(makeProgramWith(300));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UnsupportedConstruct);
    const msg = (err as Error).message;
    expect(msg).toContain("'sq'");
    expect(msg).toContain("specialization cap");
    expect(msg).toContain("MTOC2_MAX_SPECS_PER_FUNCTION");
  });

  it("does not double-count cache hits", () => {
    // Calling sq with the same exact arg twice in a row hits the cache
    // on the second call — the count must track distinct specs, not
    // invocations, so a 200-call program that all hit the same arg
    // produces exactly one spec.
    const repeats = Array.from({ length: 200 }, () => "disp(sq(7));").join(
      "\n"
    );
    const src = [
      `function y = sq(x)`,
      `  y = x * x;`,
      `end`,
      ``,
      repeats,
      ``,
    ].join("\n");
    const lw = lower(src);
    expect(lw.specializations.size).toBe(1);
  });
});

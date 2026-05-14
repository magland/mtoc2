/**
 * Spec-key canonicalization must distinguish non-finite exact values.
 * Before the fix, `JSON.stringify` collapsed `NaN`, `+Infinity`, and
 * `-Infinity` all to `"null"`, so distinct exact tensors / scalars
 * with non-finite values collided on the specialization key.
 */

import { describe, it, expect } from "vitest";
import {
  scalarDouble,
  tensorDouble,
  canonicalizeType,
} from "../src/lowering/types.js";

describe("canonicalizeType distinguishes non-finite exact values", () => {
  it("scalar NaN, +Inf, -Inf produce distinct canons", () => {
    const nan = canonicalizeType(scalarDouble("unknown", NaN));
    const pInf = canonicalizeType(scalarDouble("positive", Infinity));
    const nInf = canonicalizeType(scalarDouble("negative", -Infinity));
    expect(nan).not.toBe(pInf);
    expect(pInf).not.toBe(nInf);
    expect(nan).not.toBe(nInf);
  });

  it("scalar -0 is distinct from +0", () => {
    const posZero = canonicalizeType(scalarDouble("zero", 0));
    const negZero = canonicalizeType(scalarDouble("zero", -0));
    expect(posZero).not.toBe(negZero);
  });

  it("tensor [NaN, +Inf] and [+Inf, NaN] produce distinct canons", () => {
    const a = canonicalizeType(
      tensorDouble([1, 2], new Float64Array([NaN, Infinity]))
    );
    const b = canonicalizeType(
      tensorDouble([1, 2], new Float64Array([Infinity, NaN]))
    );
    expect(a).not.toBe(b);
  });

  it("tensor [Inf, Inf] and [Inf, -Inf] produce distinct canons", () => {
    const a = canonicalizeType(
      tensorDouble([1, 2], new Float64Array([Infinity, Infinity]))
    );
    const b = canonicalizeType(
      tensorDouble([1, 2], new Float64Array([Infinity, -Infinity]))
    );
    expect(a).not.toBe(b);
  });

  it("finite-only scalars are unaffected by the encoding", () => {
    // Regression guard: ordinary numbers still round-trip through the
    // canonical key as numbers (not tagged strings).
    const key = canonicalizeType(scalarDouble("positive", 3.14));
    expect(key).toContain('"x":3.14');
  });
});

/**
 * `unify` must align ranks via trailing-singleton normalization before
 * the dim-length compare. Otherwise an IF arm producing `zeros(2, 3)`
 * and an ELSE arm producing `zeros(2, 3, 1)` would collapse to
 * `Unknown` after the join.
 */

import { describe, it, expect } from "vitest";
import {
  unify,
  tensorDoubleFromDims,
  tensorDouble,
  DIM_ONE,
  isNumeric,
} from "../src/lowering/types.js";

describe("unify trailing-singleton normalization", () => {
  it("merges (2, 3) with (2, 3, 1) without collapsing", () => {
    const a = tensorDoubleFromDims([
      { kind: "exact", value: 2 },
      { kind: "exact", value: 3 },
    ]);
    const b = tensorDoubleFromDims([
      { kind: "exact", value: 2 },
      { kind: "exact", value: 3 },
      DIM_ONE,
    ]);
    const merged = unify(a, b);
    expect(merged.kind).toBe("Numeric");
    if (!isNumeric(merged)) throw new Error("not numeric");
    expect(merged.dims.length).toBe(2);
    expect(merged.dims[0]).toEqual({ kind: "exact", value: 2 });
    expect(merged.dims[1]).toEqual({ kind: "exact", value: 3 });
    expect(merged.shape).toEqual([2, 3]);
  });

  it("merges shape-form (2,3) with dims-form (2,3,1) via shape-trim", () => {
    const a = tensorDouble([2, 3]);
    const b = tensorDouble([2, 3, 1]);
    const merged = unify(a, b);
    expect(merged.kind).toBe("Numeric");
    if (!isNumeric(merged)) throw new Error("not numeric");
    expect(merged.dims.length).toBe(2);
    expect(merged.shape).toEqual([2, 3]);
  });

  it("still rejects genuinely-incompatible ranks", () => {
    const a = tensorDouble([2, 3]);
    const b = tensorDouble([2, 4]); // different non-singleton size
    const merged = unify(a, b);
    expect(merged.kind).toBe("Numeric");
    if (!isNumeric(merged)) throw new Error("not numeric");
    // Dims of length 2 still, but second axis becomes unknown.
    expect(merged.dims.length).toBe(2);
    expect(merged.dims[0]).toEqual({ kind: "exact", value: 2 });
    expect(merged.dims[1]).toEqual({ kind: "unknown" });
    expect(merged.shape).toBeUndefined();
  });

  it("collapses to Unknown when trimmed ranks differ", () => {
    // (2, 3) vs (2, 3, 4) — the trailing 4 is non-singleton, so no
    // trim is possible.
    const a = tensorDouble([2, 3]);
    const b = tensorDouble([2, 3, 4]);
    const merged = unify(a, b);
    expect(merged.kind).toBe("Unknown");
  });
});

/**
 * Transfer-table snapshot.
 *
 * Each builtin's `transfer(argTypes, nargout)` is the single source of
 * truth that decides what input shapes the builtin accepts and what
 * type the call produces. All three backends consume the same
 * `transfer` output — so a silent change there ripples through
 * interpreter / js-aot / c-aot in lockstep, and the cross-runner
 * can't see it until a specific .m script exercises the changed
 * path.
 *
 * This file probes a representative set of builtins with canonical
 * argument tuples and snapshots the result. Adding a builtin /
 * extending coverage is the same shape: append to PROBES, run
 * vitest, review the snapshot diff.
 *
 * What this catches that the cross-runner doesn't:
 *  - exact-value propagation regressions (an arithmetic transfer
 *    losing `exact` on all-exact inputs)
 *  - sign lattice drift (a math builtin no longer narrowing
 *    `sign` correctly)
 *  - output-type drift (a reducer changing its result shape)
 *  - rejection-semantics drift (a transfer that used to throw
 *    TypeError now accepts the input — or vice versa)
 */

import { describe, expect, it } from "vitest";
import "../src/builtins/index.js";
import { getBuiltin } from "../src/builtins/registry.js";
import {
  scalarDouble,
  scalarComplex,
  tensorDouble,
  tensorComplex,
  typeToString,
  type Type,
} from "../src/lowering/types.js";
import { TypeError, UnsupportedConstruct } from "../src/lowering/errors.js";

interface Probe {
  /** Human-readable label baked into the snapshot key. */
  label: string;
  argTypes: Type[];
  /** Defaults to 1. */
  nargout?: number;
}

interface ProbeResult {
  ok: boolean;
  /** When ok: per-output `typeToString` for snapshot stability. */
  outputs?: string[];
  /** When !ok: error class + message. The cross-runner already
   *  covers the rejection path; here we just record that the throw
   *  happened so the snapshot diffs catch a "throws → returns"
   *  regression. */
  errorClass?: string;
  errorMessage?: string;
}

function run(builtinName: string, probe: Probe): ProbeResult {
  const b = getBuiltin(builtinName);
  if (!b) return { ok: false, errorClass: "Missing", errorMessage: "not registered" };
  try {
    const out = b.transfer(probe.argTypes, probe.nargout ?? 1);
    return { ok: true, outputs: out.map(typeToString) };
  } catch (e) {
    if (e instanceof TypeError || e instanceof UnsupportedConstruct) {
      return {
        ok: false,
        errorClass: e.name,
        errorMessage: e.message,
      };
    }
    throw e;
  }
}

// ── Probe families ─────────────────────────────────────────────────────────

const ELEMWISE_REAL_BIN: Probe[] = [
  {
    label: "scalar-scalar exact",
    argTypes: [scalarDouble("positive", 3), scalarDouble("positive", 4)],
  },
  {
    label: "scalar-scalar opaque",
    argTypes: [scalarDouble(), scalarDouble()],
  },
  {
    label: "tensor3-scalar",
    argTypes: [tensorDouble([3, 1]), scalarDouble("nonneg", 2)],
  },
  {
    label: "tensor3-tensor3",
    argTypes: [tensorDouble([3, 1]), tensorDouble([3, 1])],
  },
];

const ELEMWISE_WITH_COMPLEX_BIN: Probe[] = [
  ...ELEMWISE_REAL_BIN,
  {
    label: "scalar-complex scalar",
    argTypes: [scalarDouble("positive", 2), scalarComplex({ re: 1, im: 1 })],
  },
  {
    label: "tensor-real tensor-complex",
    argTypes: [tensorDouble([2, 2]), tensorComplex([2, 2])],
  },
];

const UNARY_REAL: Probe[] = [
  {
    label: "scalar positive exact",
    argTypes: [scalarDouble("positive", 1)],
  },
  {
    label: "scalar opaque",
    argTypes: [scalarDouble()],
  },
  {
    label: "tensor nonneg",
    argTypes: [{ ...tensorDouble([4]), sign: "nonneg" as const }],
  },
];

const REDUCER: Probe[] = [
  {
    label: "scalar real",
    argTypes: [scalarDouble("positive", 7)],
  },
  {
    label: "row vector",
    argTypes: [tensorDouble([1, 5])],
  },
  {
    label: "matrix default dim",
    argTypes: [tensorDouble([3, 4])],
  },
];

// ── Specific per-builtin probes ────────────────────────────────────────────

const PROBES: Record<string, Probe[]> = {
  // Elementwise arithmetic — full complex coverage where available.
  plus: ELEMWISE_WITH_COMPLEX_BIN,
  minus: ELEMWISE_WITH_COMPLEX_BIN,
  times: ELEMWISE_WITH_COMPLEX_BIN,
  rdivide: ELEMWISE_WITH_COMPLEX_BIN,

  // Comparison — produces logical.
  eq: ELEMWISE_REAL_BIN,
  ne: ELEMWISE_REAL_BIN,
  lt: ELEMWISE_REAL_BIN,
  le: ELEMWISE_REAL_BIN,
  gt: ELEMWISE_REAL_BIN,
  ge: ELEMWISE_REAL_BIN,

  // Real-only binary math (currently no complex support).
  atan2: ELEMWISE_REAL_BIN,
  hypot: ELEMWISE_REAL_BIN,

  // Unary math.
  sin: UNARY_REAL,
  cos: UNARY_REAL,
  exp: UNARY_REAL,
  sqrt: UNARY_REAL,
  abs: [...UNARY_REAL, { label: "scalar complex", argTypes: [scalarComplex()] }],

  // Reductions.
  sum: REDUCER,
  prod: REDUCER,
  mean: REDUCER,
  min: REDUCER,
  max: REDUCER,
  any: REDUCER,
  all: REDUCER,
  length: REDUCER,
  numel: REDUCER,

  // Shape constructors. zeros/ones take exact integer dims via exact
  // scalars; the transfer reads the `exact` to compute the output
  // shape statically.
  zeros: [
    { label: "1-arg scalar dim", argTypes: [scalarDouble("positive", 4)] },
    {
      label: "2-arg row/col dims",
      argTypes: [scalarDouble("positive", 3), scalarDouble("positive", 4)],
    },
  ],
  ones: [
    { label: "1-arg scalar dim", argTypes: [scalarDouble("positive", 4)] },
    {
      label: "2-arg row/col dims",
      argTypes: [scalarDouble("positive", 3), scalarDouble("positive", 4)],
    },
  ],

  // Matrix multiply.
  mtimes: [
    {
      label: "3x4 * 4x2",
      argTypes: [tensorDouble([3, 4]), tensorDouble([4, 2])],
    },
    {
      label: "scalar * scalar",
      argTypes: [scalarDouble("positive", 2), scalarDouble("positive", 5)],
    },
  ],

  // Unary negation.
  uminus: [
    { label: "scalar positive exact", argTypes: [scalarDouble("positive", 7)] },
    { label: "scalar complex", argTypes: [scalarComplex({ re: 1, im: 1 })] },
    { label: "tensor real", argTypes: [tensorDouble([3, 3])] },
  ],

  // Logical not.
  not: [
    { label: "scalar real", argTypes: [scalarDouble("positive", 1)] },
    { label: "tensor real", argTypes: [tensorDouble([3])] },
  ],
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe("builtin transfer-table snapshot", () => {
  for (const [name, probes] of Object.entries(PROBES)) {
    describe(name, () => {
      for (const probe of probes) {
        it(probe.label, () => {
          expect(run(name, probe)).toMatchSnapshot();
        });
      }
    });
  }
});

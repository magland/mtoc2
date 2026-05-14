import type { Builtin } from "../registry.js";
import { defineElemwiseRealBinary, signDiff } from "./_elemwise.js";

export const minus: Builtin = defineElemwiseRealBinary(
  "minus",
  "-",
  "minus",
  false,
  (a, b) => a - b,
  signDiff
);

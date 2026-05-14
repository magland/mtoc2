import type { Builtin } from "../registry.js";
import { defineElemwiseRealBinary, signSum } from "./_elemwise.js";

export const plus: Builtin = defineElemwiseRealBinary(
  "plus",
  "+",
  "plus",
  true,
  (a, b) => a + b,
  signSum
);

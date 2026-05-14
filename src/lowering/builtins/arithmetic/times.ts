import type { Builtin } from "../registry.js";
import { defineElemwiseRealBinary, signProd } from "./_elemwise.js";

export const times: Builtin = defineElemwiseRealBinary(
  "times",
  "*",
  "times",
  true,
  (a, b) => a * b,
  signProd
);

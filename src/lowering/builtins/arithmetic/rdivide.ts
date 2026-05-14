import type { Builtin } from "../registry.js";
import { defineElemwiseRealBinary, signProd } from "./_elemwise.js";

export const rdivide: Builtin = defineElemwiseRealBinary(
  "rdivide",
  "/",
  "rdivide",
  false,
  (a, b) => a / b,
  signProd
);

import { defineElemwiseRealBinaryFn } from "../arithmetic/_elemwise.js";
import type { NumericType, Sign } from "../../types.js";

/** MATLAB `mod(a, b)`: result has the sign of `b`. Differs from C's
 *  `fmod` (which has the sign of `a`); the runtime calls our own
 *  `mtoc2_mod_real` helper. Special case: `mod(a, 0) = a`. */
function modFn(a: number, b: number): number {
  if (b === 0) return a;
  let r = a % b;
  if (r !== 0 && r < 0 !== b < 0) r += b;
  return r;
}

function modSign(_a: NumericType, b: NumericType): Sign {
  return b.sign;
}

export const mod = defineElemwiseRealBinaryFn({
  name: "mod",
  cFn: "mtoc2_mod_real",
  helperBase: "mod",
  commutative: false,
  fold: modFn,
  signRule: modSign,
  runtimeDep: "mtoc2_tensor_elemwise_real_fn",
});

/**
 * Factory for elementwise real → logical predicate builtins
 * (`isnan`, `logical`). One real-double argument; the result is a
 * logical value of the same shape (scalar → logical scalar, tensor →
 * logical tensor of 1s / 0s).
 *
 * The per-element rule is supplied three ways so all backends stay in
 * sync: a C scalar expression, a JS scalar expression, and a JS
 * function (used for compile-time folding and the interpreter). The
 * tensor path delegates to a `mtoc2_tensor_*` helper from
 * `tensor_predicate.h`.
 */
import { TypeError, UnsupportedConstruct } from "../../../lowering/errors.js";
import {
  scalarLogical,
  tensorDouble,
  tensorDoubleFromDims,
  shapeNumel,
  isMultiElement,
  isScalar,
  EXACT_ARRAY_MAX_ELEMENTS,
  type NumericType,
  type Type,
} from "../../../lowering/types.js";
import { requireRealDouble, exactDouble, exactRealArray } from "../_shared.js";
import type { Builtin } from "../../registry.js";
import { isTensor, type RuntimeValue } from "../../../runtime/value.js";

/** Re-tag a double-typed result as logical (same Float64 buffer, the
 *  values are all 0 / 1). */
function asLogical(t: NumericType): NumericType {
  return { ...t, elem: "logical", sign: "nonneg" };
}

export interface UnaryPredOpts {
  name: string;
  /** C scalar expression given the arg's C text. */
  cScalar: (arg: string) => string;
  /** JS scalar expression given the arg's JS text. */
  jsScalar: (arg: string) => string;
  /** JS fold / interpreter rule. */
  jsFn: (x: number) => boolean;
  /** Runtime tensor helper name (in `tensor_predicate.h`). */
  tensorHelper: string;
}

export function defineUnaryPred(opts: UnaryPredOpts): Builtin {
  const { name, cScalar, jsScalar, jsFn, tensorHelper } = opts;
  return {
    name,
    transfer(argTypes, nargout) {
      if (argTypes.length !== 1) {
        throw new TypeError(
          `'${name}' expects 1 arg(s), got ${argTypes.length}`
        );
      }
      if (nargout !== 1) {
        throw new UnsupportedConstruct(
          `'${name}' does not support multi-output (nargout=${nargout})`
        );
      }
      requireRealDouble(argTypes[0], `'${name}' arg`);
      const a = argTypes[0] as NumericType;
      if (isScalar(a)) {
        const ex = exactDouble(a);
        if (ex !== undefined) return [scalarLogical(jsFn(ex))];
        return [scalarLogical()];
      }
      // Tensor: fold when the data is statically known and small.
      const arr = exactRealArray(a);
      if (arr !== undefined && a.shape !== undefined) {
        const total = shapeNumel(a.shape);
        if (total <= EXACT_ARRAY_MAX_ELEMENTS) {
          const out = new Float64Array(total);
          for (let i = 0; i < total; i++) out[i] = jsFn(arr[i]) ? 1 : 0;
          return [asLogical(tensorDouble(a.shape, out))];
        }
      }
      return [asLogical(tensorDoubleFromDims(a.dims.slice()))];
    },
    emitC({ argsC, argTypes, useRuntime }) {
      const a = argTypes[0] as NumericType;
      if (isMultiElement(a)) {
        useRuntime(tensorHelper);
        return `mtoc2_tensor_${name}(${argsC[0]})`;
      }
      return cScalar(argsC[0]);
    },
    emitJs({ argsJs, argTypes, useRuntime }) {
      const a = argTypes[0] as NumericType;
      if (isMultiElement(a)) {
        useRuntime(tensorHelper);
        return `mtoc2_tensor_${name}(${argsJs[0]})`;
      }
      return jsScalar(argsJs[0]);
    },
    call({ args, argTypes }) {
      const a = argTypes[0] as Type;
      const v = args[0];
      if (isMultiElement(a) && isTensor(v)) {
        const out = new Float64Array(v.data.length);
        for (let i = 0; i < v.data.length; i++)
          out[i] = jsFn(v.data[i]) ? 1 : 0;
        const r: RuntimeValue = {
          mtoc2Tag: "tensor",
          shape: v.shape.slice(),
          data: out,
          isLogical: true,
        };
        return [r];
      }
      const n = typeof v === "number" ? v : Number(v);
      return [jsFn(n) ? 1 : 0];
    },
    elementwise: true,
  };
}

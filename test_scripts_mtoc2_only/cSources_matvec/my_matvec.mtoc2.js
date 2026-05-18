// `my_matvec(A, x)` — matrix-vector multiply. Demonstrates
// `exports.cSources`: the loop nest lives in `my_matvec_impl.c`
// (compiled along with mtoc2's main C), and `cBody` is a thin
// wrapper that hands raw pointers from `mtoc2_tensor_t` to the
// external implementation.

exports.name = "my_matvec";

exports.cSources = ["my_matvec_impl.c", "my_matvec_impl.h"];

// The cBody allocates the output tensor via mtoc2's runtime helper;
// activate it so the helper's definition lands in the emitted C.
exports.runtimeDeps = ["mtoc2_tensor_alloc_nd"];

exports.transfer = function (argTypes, nargout) {
  if (argTypes.length !== 2) {
    throw new Error("'my_matvec' expects 2 args, got " + argTypes.length);
  }
  if (nargout !== 1) {
    throw new Error("'my_matvec' is single-output");
  }
  const A = argTypes[0];
  const x = argTypes[1];
  if (
    A.kind !== "Numeric" ||
    A.isComplex ||
    A.elem !== "double" ||
    A.dims.length !== 2
  ) {
    throw new Error("'my_matvec' arg 1 must be a real-double 2-D tensor");
  }
  if (
    x.kind !== "Numeric" ||
    x.isComplex ||
    x.elem !== "double" ||
    x.dims.length !== 2
  ) {
    throw new Error("'my_matvec' arg 2 must be a real-double 2-D tensor");
  }
  // Static inner-dim check when both ends are statically known.
  if (
    A.dims[1].kind === "exact" &&
    x.dims[0].kind === "exact" &&
    A.dims[1].value !== x.dims[0].value
  ) {
    throw new Error(
      "'my_matvec' inner-dim mismatch: " +
        A.dims[0].value +
        "x" +
        A.dims[1].value +
        " * " +
        x.dims[0].value +
        "x" +
        x.dims[1].value
    );
  }
  // Result: M x 1, where M = A.dims[0] (carry exact when known).
  return [
    {
      kind: "Numeric",
      elem: "double",
      isComplex: false,
      dims: [A.dims[0], { kind: "exact", value: 1 }],
      sign: "unknown",
    },
  ];
};

exports.emit = function ({ argsC, prefix }) {
  return `${prefix}call(${argsC[0]}, ${argsC[1]})`;
};

exports.cBody = function ({ prefix }) {
  return `
#include "my_matvec_impl.h"

static mtoc2_tensor_t ${prefix}call(mtoc2_tensor_t A, mtoc2_tensor_t x) {
  long m = A.dims[0];
  long n = A.dims[1];
  mtoc2_tensor_t y = mtoc2_tensor_alloc_nd(2, (long[]){m, 1L});
  my_matvec_impl(m, n, A.real, x.real, y.real);
  return y;
}
`;
};

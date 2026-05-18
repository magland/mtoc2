// `my_doubler(x)` — multiplies a real-double scalar by 2.0. Plain
// JavaScript, no mtoc2 dependency. mtoc2 evaluates this file as a
// CommonJS-style module, reads `name` / `transfer` / `emit` /
// `cBody` (and optional `cHeaders`), and routes calls through them
// like any other workspace function.

exports.name = "my_doubler";

exports.transfer = function (argTypes, nargout) {
  if (argTypes.length !== 1) {
    throw new Error("'my_doubler' expects 1 arg, got " + argTypes.length);
  }
  if (nargout !== 1) {
    throw new Error("'my_doubler' is single-output (nargout=" + nargout + ")");
  }
  const a = argTypes[0];
  if (a.kind !== "Numeric" || a.isComplex || a.elem !== "double") {
    throw new Error("'my_doubler' arg must be a real-double numeric");
  }
  // Scalar (1x1) real double, no exact-fold.
  return [
    {
      kind: "Numeric",
      elem: "double",
      isComplex: false,
      dims: [
        { kind: "exact", value: 1 },
        { kind: "exact", value: 1 },
      ],
      sign: "unknown",
    },
  ];
};

exports.emit = function ({ argsC, prefix }) {
  return `${prefix}impl(${argsC[0]})`;
};

exports.cBody = function ({ prefix }) {
  return `
static double ${prefix}impl(double x) {
  return 2.0 * x;
}
`;
};

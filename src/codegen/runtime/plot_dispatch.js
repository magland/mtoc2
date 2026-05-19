// JS sibling of `plot_dispatch.h`. Emits the same RS-prefixed JSON
// wire format the C side does, so a viewer / launcher tee'ing
// stdout can parse plot records uniformly regardless of backend.
//
// Wire shape per call:
//   \x1e mtoc2:plot \t {"call":"<name>","args":[<arg>, ...]} \n
//
// Arg encoding (per source-level arg):
//   number → bare numeric (non-finite → null, matching the C side
//            and JSON.stringify's natural behavior)
//   string → {"kind":"text","data":"<text>"}
//   char   → same as string (MATLAB plot semantics don't distinguish)
//   tensor → {"kind":"tensor","dims":[…],"data":[…]} (column-major
//            flatten; non-finite as null)

function isTensor(v) {
  return typeof v === "object" && v !== null && v.mtoc2Tag === "tensor";
}
function isChar(v) {
  return typeof v === "object" && v !== null && v.mtoc2Tag === "char";
}

function encodeArg(v) {
  if (typeof v === "number") {
    return Number.isFinite(v) ? v : null;
  }
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") return { kind: "text", data: v };
  if (isChar(v)) return { kind: "text", data: v.value };
  if (isTensor(v)) {
    const data = new Array(v.data.length);
    for (let i = 0; i < v.data.length; i++) {
      const x = v.data[i];
      data[i] = Number.isFinite(x) ? x : null;
    }
    return { kind: "tensor", dims: v.shape.slice(), data };
  }
  // Unknown shape — pass through. Type-level rejection on the
  // lowering side keeps complex/struct/class/handle out of here.
  return String(v);
}

export function mtoc2_plot_dispatch(name, ...args) {
  const record = { call: name, args: args.map(encodeArg) };
  $write("\x1emtoc2:plot\t" + JSON.stringify(record) + "\n");
}

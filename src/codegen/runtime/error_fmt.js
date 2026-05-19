// JS sibling of `error_fmt.h`. Format the message + arguments and
// throw a runtime error. Mirrors numbl's `error(...)` behavior
// (stderr + halt).

import { mtoc2_sprintf_format } from "./format_engine.js";

export function mtoc2_error_fmt(fmt, ...args) {
  const msg = mtoc2_sprintf_format(fmt, args);
  // Numbl writes to stderr; in the JS host we route through the same
  // `$write` channel by emitting a "stderr" sentinel prefix the host
  // can split on. For now, throw — the CLI's runner formats the
  // exception to stderr, matching the user-visible result.
  throw new Error(msg);
}

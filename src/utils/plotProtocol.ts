/** Byte prefix that `mtoc2_plot_dispatch` writes ahead of every JSON
 *  plot record. ASCII RS (0x1e) is essentially never produced by
 *  normal MATLAB output, so we can split on it without escaping
 *  user-level `disp`/`fprintf` bytes. Kept in lockstep with the
 *  emitted C runtime helper in `src/codegen/runtime/plot_dispatch.h`. */
export const PLOT_PREFIX = "\x1emtoc2:plot\t";

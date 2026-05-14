/* mtoc2 runtime helper: sum(t) — reduce a real tensor to a scalar.
 *
 * Walks every element via a single linear loop over the flat buffer.
 * Numbl semantics for the "reduce to scalar" case: input is a scalar
 * (degenerate, returns t.real[0]), a vector (1×N or N×1), or any
 * higher-dim shape with at most one non-singleton axis. The lowerer
 * routes statically-known matrix inputs to a different (deferred)
 * path; here we trust the caller's shape gate.
 *
 * Real-only. Complex sum and matrix-to-row reductions come later.
 */

static double mtoc2_sum(mtoc2_tensor_t t) {
  long n = 1;
  for (int i = 0; i < t.ndim; i++) n *= t.dims[i];
  double s = 0.0;
  for (long i = 0; i < n; i++) s += t.real[i];
  return s;
}

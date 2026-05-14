/* mtoc2 runtime helper: tic / toc wall-clock timing.
 *
 * State is a single static double holding the most recent tic time
 * (seconds since the CLOCK_MONOTONIC epoch). MATLAB and numbl share
 * this "one global timer" semantics — `tic` resets it, `toc` reads
 * the delta. No handle form (`t0 = tic; toc(t0)`) in v1.
 *
 * Wall-clock time uses POSIX clock_gettime(CLOCK_MONOTONIC), which
 * gives nanosecond resolution on Linux and macOS, never goes
 * backwards, and isn't affected by NTP adjustments. Windows is not
 * a target; if it ever becomes one, swap in QueryPerformanceCounter
 * here behind an #ifdef.
 *
 * Output format for the bare-`toc` print form mirrors numbl's
 * `"Elapsed time is %.6f seconds.\n"` exactly so the cross-runner's
 * masking regex (see scripts/run_test_scripts.ts) treats both sides
 * as equivalent.
 */

#include <stdio.h>
#include <time.h>

static double mtoc2_tic_seconds = 0.0;

static double mtoc2_now_seconds(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

static double mtoc2_tic(void) {
  mtoc2_tic_seconds = mtoc2_now_seconds();
  return mtoc2_tic_seconds;
}

static double mtoc2_toc(void) {
  return mtoc2_now_seconds() - mtoc2_tic_seconds;
}

static void mtoc2_toc_print(void) {
  double elapsed = mtoc2_toc();
  printf("Elapsed time is %.6f seconds.\n", elapsed);
}

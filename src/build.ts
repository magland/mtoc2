/**
 * Shared C-build options for mtoc2's `run` / `eval` paths.
 *
 * Mirrors mtoc's `src/build.ts` so a binary built by `mtoc2 run` uses
 * the same compile flags a `mtoc run` binary would for the same
 * options — the goal is that perf comparisons between the two
 * translators measure translator output, not toolchain noise.
 * mtoc2 implements a strict subset of mtoc's options (no
 * `enableTempInlining` — mtoc2 has no inlining pass).
 *
 * `-O3 -march=native` is unconditional. Both `run` and `eval` are
 * meant to represent "what users would ship," not debug builds. Pass
 * `--check-leaks` for an AddressSanitizer build (~2x slower).
 */
export interface BuildOptions {
  /** Build with `-fsanitize=address -g`. AddressSanitizer +
   *  LeakSanitizer flag any unfreed buffer at exit. ~2x slowdown.
   *  Default false; the cross-runner enables this for every script. */
  checkLeaks?: boolean;
  /** Build with `-ffast-math`. Lets the C compiler reassociate
   *  floating-point ops so hot loops vectorize more aggressively.
   *  NOT IEEE-754 strict; numerics may drift in the last few ulps.
   *  Default false to keep run output bit-stable with the
   *  cross-runner oracle. */
  fastMath?: boolean;
  /** Max threads to use for parallelizable loops.
   *  - `1` (or omitted): pure serial. No `-fopenmp` on the link, and
   *    runtime macros' `_Pragma("omp parallel for …")` lines stay
   *    inert because `_OPENMP` is undefined.
   *  - `"auto"`: OpenMP picks the thread count at runtime (typically
   *    `OMP_NUM_THREADS` env var, falling back to # cores).
   *  - a number `>= 2`: emitted main() calls `omp_set_num_threads(N)`
   *    once at startup; OpenMP caps each parallel region at N threads.
   *  The pragmas use a runtime `if(n > 1024)` clause so small loops
   *  stay serial regardless of this setting. */
  threads?: number | "auto";
}

/** Build the argv array for the C compiler. `-O3 -march=native` is
 *  always on; `-ffast-math` and `-fopenmp` are gated on the
 *  corresponding `BuildOptions`. */
export function buildCcArgs(
  cFile: string,
  exeFile: string,
  opts: BuildOptions = {}
): string[] {
  const args = [cFile, "-o", exeFile, "-lm", "-O3", "-march=native"];
  if (opts.checkLeaks) args.push("-fsanitize=address", "-g");
  if (opts.fastMath) args.push("-ffast-math");
  if (isParallelThreadsOption(opts.threads)) args.push("-fopenmp");
  return args;
}

/** True when `threads` requests parallel codegen — i.e. anything other
 *  than `undefined` / `1`. Centralized so the CLI, build, and runtime
 *  helpers all agree on the "is parallel" predicate. */
export function isParallelThreadsOption(
  threads: number | "auto" | undefined
): boolean {
  return threads !== undefined && threads !== 1;
}

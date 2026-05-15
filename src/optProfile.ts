/**
 * Optimization profiles — bundled defaults for the build-time toggles:
 *   - `fastMath` (`-ffast-math` on the cc line)
 *   - `threads` (OpenMP parallel-for emission + `-fopenmp` link)
 *
 * Mirrors mtoc's `src/optProfile.ts`, minus the `enableTempInlining`
 * field (mtoc2 has no inlining pass yet). Profile name semantics
 * (`none`, `safe`, `default`, `aggressive`) match mtoc's so a
 * `--opt aggressive` script behaves consistently between the two.
 *
 * Two-step resolution: pick a profile, then apply explicit per-flag
 * overrides on top. That keeps positive flags (`--fast-math`) and
 * negative flags (`--no-fast-math`) composable with `--opt aggressive`
 * / `--opt none`. Individual overrides always win over the profile.
 */

export type OptProfile = "none" | "safe" | "default" | "aggressive";

export const OPT_PROFILES: ReadonlyArray<OptProfile> = [
  "none",
  "safe",
  "default",
  "aggressive",
];

export const DEFAULT_OPT_PROFILE: OptProfile = "default";

export interface OptSettings {
  fastMath: boolean;
  threads: number | "auto";
}

const PROFILES: Readonly<Record<OptProfile, OptSettings>> = {
  none: { fastMath: false, threads: 1 },
  safe: { fastMath: false, threads: "auto" },
  default: { fastMath: false, threads: "auto" },
  aggressive: { fastMath: true, threads: "auto" },
};

export function profileSettings(profile: OptProfile): OptSettings {
  return PROFILES[profile];
}

/** Resolve the final settings from a profile + per-flag overrides.
 *  Undefined overrides leave the profile's choice untouched. */
export function resolveOptSettings(
  profile: OptProfile = DEFAULT_OPT_PROFILE,
  overrides: Partial<OptSettings> = {}
): OptSettings {
  const base = PROFILES[profile];
  return {
    fastMath: overrides.fastMath ?? base.fastMath,
    threads: overrides.threads ?? base.threads,
  };
}

/** True when `s` is one of the four profile names. Used by the CLI's
 *  `--opt` validator. */
export function isOptProfile(s: unknown): s is OptProfile {
  return (
    typeof s === "string" && (OPT_PROFILES as ReadonlyArray<string>).includes(s)
  );
}

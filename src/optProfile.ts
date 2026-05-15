/**
 * Optimization profiles — currently a single bundled toggle:
 *   - `fastMath` (`-ffast-math` on the cc line)
 *
 * Shared by the web IDE ([components/IDEWorkspace.tsx](./components/IDEWorkspace.tsx))
 * so a profile name resolves to the same setting everywhere.
 *
 * Two-step resolution: pick a profile, then apply any explicit per-flag
 * overrides on top. Individual overrides always win over the profile.
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
}

/** The bundled settings for each profile name.
 *
 *  `default` and `safe` are intentionally identical — the split exists
 *  so a future "default" tweak can move without churning callers that
 *  pin to "safe" specifically. `none` reproduces the no-flags baseline.
 *  `aggressive` opts into `-ffast-math` — numerics may drift in the
 *  last few ulps. */
const PROFILES: Readonly<Record<OptProfile, OptSettings>> = {
  none: { fastMath: false },
  safe: { fastMath: false },
  default: { fastMath: false },
  aggressive: { fastMath: true },
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
  };
}

/** True when `s` is one of the four profile names. */
export function isOptProfile(s: unknown): s is OptProfile {
  return (
    typeof s === "string" && (OPT_PROFILES as ReadonlyArray<string>).includes(s)
  );
}

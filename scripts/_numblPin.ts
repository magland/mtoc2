/**
 * NUMBL_VERSION pin check.
 *
 * The cross-runners use numbl (at `../numbl`) as the byte-for-byte
 * oracle. A divergence between the SHA the corpus was validated
 * against and the SHA actually on disk would silently invalidate
 * the entire test signal — green tests against the wrong numbl
 * tell us nothing.
 *
 * `NUMBL_VERSION` in the repo root records the validated SHA. This
 * helper compares it to `git -C ../numbl rev-parse HEAD` and exits
 * the runner non-zero on mismatch. Override with
 * `MTOC_TEST_SKIP_NUMBL_PIN=1` for the rare case where a dev wants
 * to bisect against an older / newer numbl without bumping the pin.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface NumblPinResult {
  pinned: string;
  actual: string;
  match: boolean;
}

/** Read the pinned SHA from `<repoRoot>/NUMBL_VERSION`. Trailing
 *  whitespace / newlines are stripped. Returns `null` if the file
 *  is missing — the runner treats that as "no pin recorded" and
 *  prints a warning rather than failing, so a brand-new repo can
 *  still run tests before deciding to pin. */
function readPinned(repoRoot: string): string | null {
  const p = resolve(repoRoot, "NUMBL_VERSION");
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8").trim();
}

/** Ask git for `../numbl`'s current HEAD SHA. Returns `null` if the
 *  directory isn't a git repo (e.g. someone copied numbl source in
 *  by hand) — the runner treats that as inconclusive and warns. */
function readActual(numblDir: string): string | null {
  try {
    const out = execFileSync("git", ["-C", numblDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim();
  } catch {
    return null;
  }
}

/** Enforce that `../numbl`'s HEAD matches `NUMBL_VERSION`. Exits the
 *  process non-zero on mismatch unless `MTOC_TEST_SKIP_NUMBL_PIN=1`
 *  is set. Inconclusive states (no pin file, numbl not a git repo)
 *  warn to stderr but do not abort — the surrounding test run still
 *  proceeds, since the user may already be in an exploration mode
 *  where the pin can't apply. */
export function enforceNumblPin(repoRoot: string, numblDir: string): void {
  if (process.env.MTOC_TEST_SKIP_NUMBL_PIN === "1") return;

  const pinned = readPinned(repoRoot);
  const actual = readActual(numblDir);

  if (pinned === null) {
    console.error(
      `NUMBL_VERSION not found at ${resolve(repoRoot, "NUMBL_VERSION")} — ` +
        `cross-runner is proceeding without a pin check.`
    );
    return;
  }
  if (actual === null) {
    console.error(
      `${numblDir} is not a git checkout — cannot verify NUMBL_VERSION pin. ` +
        `Set MTOC_TEST_SKIP_NUMBL_PIN=1 to silence this warning.`
    );
    return;
  }

  if (pinned !== actual) {
    console.error(
      `NUMBL_VERSION pin mismatch:\n` +
        `  recorded: ${pinned}\n` +
        `  actual:   ${actual}\n` +
        `\n` +
        `The cross-runner uses numbl as the byte-for-byte oracle, so a\n` +
        `SHA drift silently invalidates the test signal. Either:\n` +
        `  - move ../numbl back to ${pinned}, or\n` +
        `  - validate against the new SHA and update NUMBL_VERSION, or\n` +
        `  - set MTOC_TEST_SKIP_NUMBL_PIN=1 to bypass (e.g. for bisects).`
    );
    process.exit(3);
  }
}

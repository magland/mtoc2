#!/usr/bin/env tsx
/**
 * Builtin parity report — what's in numbl that mtoc2 doesn't have yet.
 *
 * Numbl is the dialect anchor; mtoc2 grows toward feature parity. This
 * script imports numbl's `getAllIBuiltinNames` + `SPECIAL_BUILTIN_NAMES`
 * and mtoc2's `allBuiltinNames`, then prints:
 *
 *   - Total counts per side.
 *   - The set of numbl builtin names with NO mtoc2 counterpart, grouped
 *     by numbl's topic file (math/arithmetic/strings/…) so you can see
 *     which families are missing at a glance.
 *   - Any mtoc2-only names — i.e. names mtoc2 registers as callable
 *     builtins that numbl doesn't expose via the same path. Often
 *     these are names numbl dispatches through some OTHER channel
 *     (operators like `mtimes`/`plus`/`eq` go through `runtimeOperators`,
 *     constants like `pi` may live in a separate table). Inspect each
 *     entry before treating it as "extra" — most are intentional
 *     mtoc2 design choices.
 *
 * Run:   npx tsx scripts/builtin_parity.ts
 *
 * The script doesn't gate anything — it's a standing reference for
 * "what to wire next" rather than a check. Pure read-only.
 */

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const numblBuiltinsDir = resolve(
  repoRoot,
  "..",
  "numbl",
  "src",
  "numbl-core",
  "interpreter",
  "builtins"
);
const numblSpecialNamesPath = resolve(
  repoRoot,
  "..",
  "numbl",
  "src",
  "numbl-core",
  "runtime",
  "specialBuiltinNames.ts"
);
const numblPlotNamesPath = resolve(
  repoRoot,
  "..",
  "numbl",
  "src",
  "numbl-core",
  "runtime",
  "plotBuiltinDispatch.ts"
);

/** Static-scan each numbl builtins/*.ts file for builtin registrations.
 *  We don't import numbl's TS modules at runtime (too much side-effect
 *  surface — registry mutations, sparse helpers, etc.). Numbl uses two
 *  registration shapes:
 *
 *  - Object-literal: `{ name: "foo", ... }` — `defineBuiltin`,
 *    `registerBinary`, and similar take a config object.
 *  - Positional: `registerUnary("sin", ...)` — the helpers in
 *    `math.ts` / similar wrap `defineBuiltin` and take the name as
 *    the first positional arg.
 *
 *  Both shapes show up; the second one was previously missed (so
 *  `cos`, `sin`, `pi`, `gca` looked mtoc2-only when they're really in
 *  numbl too). Match `name: "<id>"` OR a function-call pattern whose
 *  identifier starts with `register` / `define` and whose first
 *  argument is a string literal. */
function scanNumblTopicFiles(): Map<string, Set<string>> {
  const byTopic = new Map<string, Set<string>>();
  // Reject common false-positives. The wrapper helpers themselves
  // (`defineBuiltin`, `registerUnary`, `registerBinary`, ...) call
  // `defineBuiltin({ name, ... })` internally — capturing their
  // *parameter* `name` would shadow the real names. Same for
  // `registerExtraBuiltinNames` (which forwards a list).
  const skipFirstArg = new Set(["registerExtraBuiltinNames"]);
  for (const entry of readdirSync(numblBuiltinsDir).sort()) {
    if (!entry.endsWith(".ts")) continue;
    if (entry === "index.ts" || entry === "types.ts") continue;
    const src = readFileSync(join(numblBuiltinsDir, entry), "utf8");
    const topic = entry.replace(/\.ts$/, "");
    const set = new Set<string>();
    for (const m of src.matchAll(/\bname:\s*["']([^"']+)["']/g)) {
      set.add(m[1]);
    }
    // Positional registration: `<register|define>Xxx("<id>", ...)`.
    // The regex is intentionally narrow — it requires the call to
    // BEGIN a statement (preceded by `\n` and whitespace) so we don't
    // pick up `Object.values(register("...")...)` style nesting.
    for (const m of src.matchAll(
      /^\s*((?:register|define)\w*)\(\s*["']([^"']+)["']/gm
    )) {
      if (skipFirstArg.has(m[1])) continue;
      set.add(m[2]);
    }
    if (set.size > 0) byTopic.set(topic, set);
  }
  return byTopic;
}

/** Pull SPECIAL_BUILTIN_NAMES values out of the source file by regex.
 *  Same static-scan rationale as `scanNumblTopicFiles`: we don't want
 *  to instantiate numbl's runtime. */
function scanSpecialBuiltinNames(): Set<string> {
  const src = readFileSync(numblSpecialNamesPath, "utf8");
  const out = new Set<string>();
  for (const m of src.matchAll(/["']([A-Za-z_][\w.]*)["']/g)) {
    out.add(m[1]);
  }
  return out;
}

/** PLOT_DISPATCH_NAMES + PLOT_STUB_NAMES from numbl's plot dispatch
 *  module. These are the names numbl wires through `runtimeOperators`
 *  rather than the builtin registry, so they don't show up in
 *  `getAllIBuiltinNames`. mtoc2 imports the same array directly, so
 *  the two stay in lockstep; this just adds them to the parity
 *  baseline so plot names don't false-positive as mtoc2-only. */
function scanPlotNames(): Set<string> {
  const src = readFileSync(numblPlotNamesPath, "utf8");
  const out = new Set<string>();
  // Extract any string literal inside a `PLOT_*_NAMES` array. The two
  // exports are flat string arrays so a single regex catches both.
  for (const block of src.matchAll(
    /PLOT_(?:DISPATCH|STUB)_NAMES:\s*ReadonlyArray<string>\s*=\s*\[([\s\S]*?)\]/g
  )) {
    for (const m of block[1].matchAll(/["']([A-Za-z_][\w]*)["']/g)) {
      out.add(m[1]);
    }
  }
  return out;
}

async function mtoc2Names(): Promise<Set<string>> {
  // mtoc2's registry has side-effecting imports — fine to load: it
  // doesn't reach into ../numbl unless we ask it to.
  const { allBuiltinNames } = await import("../src/builtins/index.js");
  return new Set(allBuiltinNames());
}

function reportSection(title: string, items: ReadonlyArray<string>): void {
  if (items.length === 0) return;
  console.log(`\n${title} (${items.length}):`);
  for (const n of items) console.log(`  ${n}`);
}

async function main(): Promise<void> {
  if (!statSync(numblBuiltinsDir, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(
      `numbl builtins directory not found at ${numblBuiltinsDir}.\n` +
        `Cross-runner sibling layout expected: ../numbl checked out next ` +
        `to mtoc2.`
    );
    process.exit(2);
  }

  const numblByTopic = scanNumblTopicFiles();
  const numblAll = new Set<string>();
  for (const set of numblByTopic.values()) {
    for (const n of set) numblAll.add(n);
  }
  const numblSpecial = scanSpecialBuiltinNames();
  for (const n of numblSpecial) numblAll.add(n);
  const numblPlot = scanPlotNames();
  for (const n of numblPlot) numblAll.add(n);

  const mtoc2 = await mtoc2Names();

  console.log(`numbl total builtin names: ${numblAll.size}`);
  console.log(`mtoc2 total builtin names: ${mtoc2.size}`);
  const overlap = [...numblAll].filter(n => mtoc2.has(n));
  console.log(`overlap:                  ${overlap.length}`);

  // Per-topic gap.
  console.log(`\n── numbl builtins not in mtoc2 (by topic) ──`);
  const topicGapTotals: Array<{ topic: string; gap: string[] }> = [];
  for (const [topic, set] of numblByTopic) {
    const gap = [...set].filter(n => !mtoc2.has(n)).sort();
    if (gap.length === 0) continue;
    topicGapTotals.push({ topic, gap });
  }
  // Sort topics by gap size descending so the biggest holes show first.
  topicGapTotals.sort((a, b) => b.gap.length - a.gap.length);
  for (const { topic, gap } of topicGapTotals) {
    reportSection(`${topic}`, gap);
  }

  // Special-builtin gap.
  const specialGap = [...numblSpecial].filter(n => !mtoc2.has(n)).sort();
  reportSection(`special (plotting / I/O / introspection)`, specialGap);

  // mtoc2-only — names mtoc2 ships as builtins but numbl doesn't
  // expose under the same path. Usually these are operators
  // (`mtimes`/`plus`/`eq`) or constants (`pi`) that numbl wires
  // through `runtimeOperators` or other channels — call sites work,
  // it's just the parity-source split.
  const mtoc2Only = [...mtoc2].filter(n => !numblAll.has(n)).sort();
  reportSection(
    `mtoc2-only (often operators/constants numbl handles elsewhere)`,
    mtoc2Only
  );

  // Summary footer.
  const totalGap = topicGapTotals.reduce((s, t) => s + t.gap.length, 0);
  console.log(
    `\nGap: ${totalGap + specialGap.length} builtin(s) in numbl not yet in mtoc2`
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

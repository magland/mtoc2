#!/usr/bin/env tsx
/**
 * Cross-runner: every `.m` script in `test_scripts/` is run through
 * mtoc2 twice — once via the native path (`run`) and once via the
 * C-to-JS path (`run --js`). Stdouts must match byte-for-byte.
 *
 *   npx tsx scripts/run_test_scripts_js.ts                 # all
 *   npx tsx scripts/run_test_scripts_js.ts foo.m bar.m     # specific
 *   MTOC_TEST_CONCURRENCY=4 npx tsx scripts/run_test_scripts_js.ts
 *   MTOC_TEST_TIMEOUT_MS=60000 npx tsx scripts/run_test_scripts_js.ts
 *
 * This is NOT part of the mandatory test discipline — it's a separate
 * sweep for when you're working on the c2js backend specifically (see
 * `src/cjs/` and `src/cli.ts`'s `runJsSource`). The native-vs-numbl
 * cross-runner (`scripts/run_test_scripts.ts`) is the gate for
 * general changes; this script piggy-backs on the same per-script
 * mask/drop directives so a script that masks an elapsed-time line
 * for the numbl cross-runner has the same line masked here too.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { cpus } from "node:os";
import { PLOT_PREFIX } from "../src/utils/plotProtocol.js";

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const cliPath = join(repoRoot, "src", "cli.ts");
const scriptsDir = join(repoRoot, "test_scripts");

function discoverScripts(): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(scriptsDir)) {
    const p = join(scriptsDir, entry);
    const st = statSync(p);
    if (st.isFile() && entry.endsWith(".m")) {
      found.push(p);
    } else if (st.isDirectory()) {
      const main = join(p, "main.m");
      try {
        if (statSync(main).isFile()) found.push(main);
      } catch {
        // Subdir without main.m — silently skip.
      }
    }
  }
  return found.sort();
}

const TIMEOUT_MS = (() => {
  const fromEnv = process.env.MTOC_TEST_TIMEOUT_MS;
  if (fromEnv) {
    const n = Number.parseInt(fromEnv, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 30_000;
})();

const MAX_DIFF_LINES = 30;

/** Sidecar protocols mtoc2 emits that should be dropped on both sides
 *  before the byte-for-byte compare. Currently just plot dispatch
 *  records — they're identical between native and --js, but stripping
 *  matches the numbl cross-runner's behavior. */
const GLOBAL_DROPS: ReadonlyArray<RegExp> = [
  new RegExp(`^${PLOT_PREFIX}.*\\n?`, "gm"),
];

interface Captured {
  stdout: string;
}

async function captureMtoc2Native(scriptPath: string): Promise<Captured> {
  const args = ["tsx", cliPath, "run", scriptPath];
  const r = await execFileAsync("npx", args, {
    maxBuffer: 16 * 1024 * 1024,
    timeout: TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  return { stdout: r.stdout };
}

async function captureMtoc2Js(scriptPath: string): Promise<Captured> {
  const args = ["tsx", cliPath, "run", "--js", scriptPath];
  const r = await execFileAsync("npx", args, {
    maxBuffer: 16 * 1024 * 1024,
    timeout: TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  return { stdout: r.stdout };
}

function diff(expected: string, actual: string): string {
  const al = expected.split("\n");
  const bl = actual.split("\n");
  const max = Math.max(al.length, bl.length);
  const lines: string[] = [];
  let totalMismatch = 0;
  for (let i = 0; i < max; i++) {
    const av = al[i] ?? "";
    const bv = bl[i] ?? "";
    if (av === bv) continue;
    totalMismatch++;
    if (lines.length < MAX_DIFF_LINES) {
      lines.push(
        `  line ${i + 1}: native=${JSON.stringify(av)} js=${JSON.stringify(bv)}`
      );
    }
  }
  if (totalMismatch > MAX_DIFF_LINES) {
    lines.push(
      `  … (${totalMismatch - MAX_DIFF_LINES} more differing line${totalMismatch - MAX_DIFF_LINES === 1 ? "" : "s"} suppressed; ${totalMismatch} total)`
    );
  }
  return lines.join("\n");
}

interface Result {
  name: string;
  status: "PASS" | "FAIL";
  detail: string | null;
  maskNotes: string[];
}

function parseMasks(scriptPath: string): {
  masks: RegExp[];
  drops: RegExp[];
} {
  let src: string;
  try {
    src = readFileSync(scriptPath, "utf8");
  } catch {
    return { masks: [], drops: [] };
  }
  const masks: RegExp[] = [];
  const drops: RegExp[] = [];
  const lines = src.split("\n").slice(0, 20);
  for (const line of lines) {
    const maskMatch = line.match(/^\s*%\s*mtoc2-test-mask:\s*(.*)$/);
    if (maskMatch) {
      const pattern = maskMatch[1].trim();
      if (pattern !== "") masks.push(new RegExp(pattern, "gm"));
      continue;
    }
    const dropMatch = line.match(/^\s*%\s*mtoc2-test-drop:\s*(.*)$/);
    if (dropMatch) {
      const pattern = dropMatch[1].trim();
      if (pattern !== "") drops.push(new RegExp(pattern + "\\n?", "gm"));
      continue;
    }
  }
  return { masks, drops };
}

function applyMasks(
  stdout: string,
  masks: ReadonlyArray<RegExp>,
  drops: ReadonlyArray<RegExp>
): { text: string; notes: string[] } {
  let text = stdout;
  const notes: string[] = [];
  for (const re of GLOBAL_DROPS) {
    text = text.replace(re, "");
  }
  if (masks.length === 0 && drops.length === 0) {
    return { text, notes };
  }
  for (const re of masks) {
    let count = 0;
    text = text.replace(re, () => {
      count++;
      return "[MASKED]";
    });
    if (count > 0) {
      notes.push(
        `  -> masked ${count} match${count === 1 ? "" : "es"} via ${re}`
      );
    }
  }
  for (const re of drops) {
    let count = 0;
    text = text.replace(re, () => {
      count++;
      return "";
    });
    if (count > 0) {
      notes.push(
        `  -> dropped ${count} line${count === 1 ? "" : "s"} via ${re}`
      );
    }
  }
  return { text, notes };
}

async function runOne(scriptPath: string): Promise<Result> {
  const name = scriptPath.startsWith(repoRoot)
    ? scriptPath.slice(repoRoot.length + 1)
    : scriptPath;

  const { masks, drops } = parseMasks(scriptPath);

  let nativeCap: Captured;
  try {
    nativeCap = await captureMtoc2Native(scriptPath);
  } catch (e) {
    const err = e as Error & { stderr?: string };
    const tail = (err.stderr ?? "").trim();
    const head = err.message.split("\n")[0];
    const detail = tail
      ? `native errored: ${head}\n${tail}`
      : `native errored: ${head}`;
    return { name, status: "FAIL", detail, maskNotes: [] };
  }

  let jsCap: Captured;
  try {
    jsCap = await captureMtoc2Js(scriptPath);
  } catch (e) {
    const err = e as Error & { stderr?: string };
    const tail = (err.stderr ?? "").trim();
    const head = err.message.split("\n")[0];
    const detail = tail
      ? `--js errored: ${head}\n${tail}`
      : `--js errored: ${head}`;
    return { name, status: "FAIL", detail, maskNotes: [] };
  }

  const nativeM = applyMasks(nativeCap.stdout, masks, drops);
  const jsM = applyMasks(jsCap.stdout, masks, drops);
  const maskNotes: string[] = [];
  for (const n of nativeM.notes) maskNotes.push(`  native${n}`);
  for (const n of jsM.notes) maskNotes.push(`  js    ${n}`);

  if (jsM.text !== nativeM.text) {
    return {
      name,
      status: "FAIL",
      detail: diff(nativeM.text, jsM.text),
      maskNotes,
    };
  }
  return { name, status: "PASS", detail: null, maskNotes };
}

async function runPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
  onResult: (item: T, result: R, index: number) => void
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runWorker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      const r = await worker(items[i]);
      results[i] = r;
      onResult(items[i], r, i);
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    runWorker()
  );
  await Promise.all(workers);
  return results;
}

function parseConcurrency(): number {
  const fromEnv = process.env.MTOC_TEST_CONCURRENCY;
  if (fromEnv) {
    const n = Number.parseInt(fromEnv, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return Math.max(1, cpus().length);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const scripts =
    argv.length > 0 ? argv.map(a => resolve(a)) : discoverScripts();

  const concurrency = parseConcurrency();

  let pass = 0;
  let fail = 0;
  const failedNames: string[] = [];

  await runPool(scripts, concurrency, runOne, (_, r) => {
    if (r.status === "PASS") {
      pass++;
      console.log(`PASS ${r.name}`);
    } else {
      fail++;
      failedNames.push(r.name);
      console.log(`FAIL ${r.name}`);
      if (r.detail) console.log(r.detail);
    }
    for (const n of r.maskNotes) console.log(n);
  });

  console.log(
    `\n${pass} passed, ${fail} failed (${scripts.length} total, concurrency=${concurrency})`
  );
  if (failedNames.length > 0) {
    console.log(`failed: ${failedNames.join(" ")}`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main();

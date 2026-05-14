#!/usr/bin/env tsx
/**
 * Cross-runner: every .m script in `test_scripts/` is run through both
 * numbl (the language reference) and mtoc2's own CLI. Stdouts must
 * match byte-for-byte.
 *
 *   npx tsx scripts/run_test_scripts.ts                   # all scripts
 *   npx tsx scripts/run_test_scripts.ts foo.m bar.m       # specific files
 *   MTOC_TEST_CONCURRENCY=4 npx tsx scripts/run_test_scripts.ts
 *   MTOC_TEST_TIMEOUT_MS=60000 npx tsx scripts/run_test_scripts.ts
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { cpus } from "node:os";

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const cliPath = join(repoRoot, "src", "cli.ts");
const numblCliPath = resolve(repoRoot, "..", "numbl", "src", "cli.ts");
const scriptsDir = join(repoRoot, "test_scripts");

/** Discovery rule:
 *  - `test_scripts/*.m` — each file is an entry (flat layout for
 *    single-file tests).
 *  - `test_scripts/<subdir>/main.m` — each subdir is a multifile
 *    test group with `main.m` as the entry. Sibling `.m` files are
 *    workspace files (picked up automatically by the CLI's
 *    `scanSiblings`); they are NOT entries on their own.
 *  This rule keeps flat tests working while letting multifile
 *  groups isolate their workspace from each other and from the
 *  flat tests. */
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

async function captureStdout(cmd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, {
    maxBuffer: 16 * 1024 * 1024,
    timeout: TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  return stdout;
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
        `  line ${i + 1}: numbl=${JSON.stringify(av)} mtoc=${JSON.stringify(bv)}`
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
}

async function runOne(scriptPath: string): Promise<Result> {
  const name = scriptPath.startsWith(repoRoot)
    ? scriptPath.slice(repoRoot.length + 1)
    : scriptPath;

  let expected: string;
  try {
    expected = await captureStdout("npx", [
      "tsx",
      numblCliPath,
      "run",
      scriptPath,
    ]);
  } catch (e) {
    const msg = (e as Error).message.split("\n")[0];
    return { name, status: "FAIL", detail: `numbl errored: ${msg}` };
  }

  let actual: string;
  try {
    actual = await captureStdout("npx", ["tsx", cliPath, "run", scriptPath]);
  } catch (e) {
    const err = e as Error & { stderr?: string };
    const tail = (err.stderr ?? "").trim();
    const head = err.message.split("\n")[0];
    const detail = tail
      ? `mtoc2 errored: ${head}\n${tail}`
      : `mtoc2 errored: ${head}`;
    return { name, status: "FAIL", detail };
  }

  if (actual === expected) return { name, status: "PASS", detail: null };
  return { name, status: "FAIL", detail: diff(expected, actual) };
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
  if (!existsSync(numblCliPath)) {
    console.error(
      `Cross-runner needs numbl checked out as a sibling directory:\n` +
        `  expected: ${numblCliPath}`
    );
    process.exit(2);
  }

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

/**
 * Browser-side JS-mode pipeline: translate locally, c2js locally, run
 * in a Web Worker. The all-local sibling of the WASM path:
 *
 *   1. The browser translates numbl → C with `translateProject`.
 *   2. `translateCToJs` (the c2js translator vendored under `src/cjs/`)
 *      converts the C to a self-contained JS string.
 *   3. A dedicated Web Worker `eval`s that JS with a tiny `process`
 *      shim that re-routes `stdout.write` / `stderr.write` back as
 *      `RunEvent`s — the same vocabulary the WASM worker uses, so the
 *      console + figures pipeline downstream doesn't branch on mode.
 *
 * Compared to the WASM path: no `wasm.numbl.org` round-trip, no
 * Emscripten glue, no IndexedDB cache (the c2js step is fast enough
 * that caching the JS source would just add complexity). The trade-
 * off is performance: the JS runs interpreted-by-V8 against a
 * `{re, im}`-typed complex shim and array-of-numbers tensor
 * representation, so heavy numerical loops are several × slower than
 * the WASM path. For exploratory editing and tests under a few
 * million ops it's plenty fast and gives instant turnaround.
 */
import {
  translateProject,
  type SourceFile,
  type TranslateError,
} from "../translate";
import { translateCToJs } from "../cjs";
import JsRunnerWorker from "./jsRunner.worker.ts?worker";
import type { JsRunMessage, JsRunRequest } from "./jsRunner.worker";
import type { RunEvent, RunResult } from "./wasmExecution";

/** Translate + c2js the project to a JS source string. Errors arrive
 *  as `BuildJsResult.kind === "translate"`; mirrors `buildWasm`'s
 *  result-shape so callers can switch on `kind` uniformly. */
export type BuildJsResult =
  | { ok: true; jsSource: string }
  | { ok: false; kind: "translate"; error: TranslateError };

export function buildJs(
  files: SourceFile[],
  activeName: string
): BuildJsResult {
  const result = translateProject(files, activeName);
  if (result.error)
    return { ok: false, kind: "translate", error: result.error };
  const jsSource = translateCToJs(result.c ?? "");
  return { ok: true, jsSource };
}

export interface RunJsCallbacks {
  onEvent: (event: RunEvent) => void;
}

/** Spawn the JS worker, ship the source, fan events back through
 *  `callbacks.onEvent`. Same Stop semantics as `runWasm` — an aborted
 *  signal calls `worker.terminate()`, which kills whatever loop the
 *  user's program is spinning on. */
export async function runJs(
  jsSource: string,
  callbacks: RunJsCallbacks,
  abortSignal?: AbortSignal
): Promise<RunResult> {
  if (abortSignal?.aborted) {
    return { success: false, aborted: true };
  }

  return new Promise<RunResult>(resolve => {
    const worker = new JsRunnerWorker();
    let settled = false;
    let aborted = false;

    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      abortSignal?.removeEventListener("abort", abortHandler);
      worker.terminate();
      resolve(result);
    };

    const abortHandler = () => {
      aborted = true;
      callbacks.onEvent({ type: "done", phase: "run", exitCode: 130 });
      finish({ success: false, aborted: true });
    };
    abortSignal?.addEventListener("abort", abortHandler, { once: true });

    worker.onmessage = (event: MessageEvent<JsRunMessage>) => {
      if (aborted) return;
      const msg = event.data;
      if (msg.type === "stdout" || msg.type === "stderr") {
        callbacks.onEvent({ type: msg.type, text: msg.text });
        return;
      }
      if (msg.type === "plot_record") {
        callbacks.onEvent({ type: "plot_record", record: msg.record });
        return;
      }
      if (msg.type === "error") {
        callbacks.onEvent({ type: "stderr", text: `${msg.message}\n` });
        callbacks.onEvent({ type: "done", phase: "run", exitCode: 1 });
        finish({ success: false, transportError: msg.message });
        return;
      }
      callbacks.onEvent({ type: "done", phase: "run", exitCode: msg.exitCode });
      finish({ success: msg.exitCode === 0, exitCode: msg.exitCode });
    };

    worker.onerror = event => {
      if (aborted) return;
      const message = event.message || "worker error";
      callbacks.onEvent({ type: "stderr", text: `${message}\n` });
      callbacks.onEvent({ type: "done", phase: "run", exitCode: 1 });
      finish({ success: false, transportError: message });
    };

    const req: JsRunRequest = { type: "run", jsSource };
    worker.postMessage(req);
  });
}

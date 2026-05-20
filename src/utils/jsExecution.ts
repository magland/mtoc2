/**
 * Browser-side JS-AOT pipeline: lower locally, emit JS locally, run
 * in a Web Worker. Parallel to the WASM path:
 *
 *   1. The browser parses every source file and registers a workspace.
 *   2. `Lowerer.lowerProgram` produces typed IR.
 *   3. `emitJsProgram` walks the IR through each builtin's `emitJs`
 *      hook and inlines activated runtime snippets.
 *   4. A dedicated Web Worker `eval`s the resulting `function run($h)`
 *      module and invokes it with a `write` callback that streams
 *      stdout back as `RunEvent`s — the same vocabulary the WASM
 *      worker uses, so the console + figures pipeline downstream
 *      doesn't branch on mode.
 *
 * Compared to the WASM path: no `wasm.numbl.org` round-trip, no
 * Emscripten glue, no IndexedDB cache. The trade-off is performance:
 * the JS runs interpreted-by-V8 against an array-of-numbers tensor
 * representation, so heavy numerical loops are several × slower than
 * WASM. For exploratory editing it's plenty fast and gives instant
 * turnaround.
 */
import { type SourceFile, type TranslateError } from "../translate";
import { Workspace, parseFiles } from "../workspace/workspace";
import { Lowerer } from "../lowering/lower";
import { emitJsProgram } from "../codegen/emitJs";
import {
  UnsupportedConstruct,
  TypeError as LoweringTypeError,
} from "../lowering/errors";
import JsRunnerWorker from "./jsRunner.worker.ts?worker";
import type { JsRunMessage, JsRunRequest } from "./jsRunner.worker";
import type { RunEvent, RunResult } from "./wasmExecution";

/** Lower + emit JS for the project. Errors arrive as `BuildJsResult.kind
 *  === "translate"`; mirrors `buildWasm`'s result-shape so callers can
 *  switch on `kind` uniformly. */
export type BuildJsResult =
  | { ok: true; jsSource: string }
  | { ok: false; kind: "translate"; error: TranslateError };

export function buildJs(
  files: SourceFile[],
  activeName: string
): BuildJsResult {
  try {
    const parsed = parseFiles(files);
    const ws = new Workspace(activeName, []);
    for (const f of parsed) ws.addFile(f);
    ws.finalize();
    const mainAst = ws.files.get(activeName)?.ast;
    if (!mainAst) {
      return {
        ok: false,
        kind: "translate",
        error: {
          kind: "UnsupportedConstruct",
          message: `main file '${activeName}' has no parsed AST`,
        },
      };
    }
    const prog = new Lowerer(ws).lowerProgram(mainAst);
    const result = emitJsProgram(prog, { workspace: ws });
    return { ok: true, jsSource: result.source };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const kind: TranslateError["kind"] =
      e instanceof UnsupportedConstruct
        ? "UnsupportedConstruct"
        : e instanceof LoweringTypeError
          ? "TypeError"
          : "UnsupportedConstruct";
    return { ok: false, kind: "translate", error: { kind, message } };
  }
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

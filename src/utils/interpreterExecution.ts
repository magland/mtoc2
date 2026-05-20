/**
 * Browser-side INTERPRET-mode pipeline: no codegen, no compile. The
 * tree-walking `Interpreter` runs the AST directly in a Web Worker.
 *
 * Mirrors `jsExecution.ts`'s shape so `useWasmExecution` can dispatch
 * on `mode` without branching on the underlying transport.
 */
import type { SourceFile } from "../translate";
import InterpreterRunnerWorker from "./interpreterRunner.worker.ts?worker";
import type {
  InterpreterRunMessage,
  InterpreterRunRequest,
} from "./interpreterRunner.worker";
import type { RunEvent, RunResult } from "./wasmExecution";

export interface RunInterpreterCallbacks {
  onEvent: (event: RunEvent) => void;
}

export async function runInterpreter(
  files: SourceFile[],
  mainName: string,
  callbacks: RunInterpreterCallbacks,
  abortSignal?: AbortSignal
): Promise<RunResult> {
  if (abortSignal?.aborted) {
    return { success: false, aborted: true };
  }

  return new Promise<RunResult>(resolve => {
    const worker = new InterpreterRunnerWorker();
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

    worker.onmessage = (event: MessageEvent<InterpreterRunMessage>) => {
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

    const req: InterpreterRunRequest = { type: "run", files, mainName };
    worker.postMessage(req);
  });
}

/**
 * Web Worker that executes the user's program via the tree-walking
 * `Interpreter` — no codegen, no compile step, no remote service.
 * Browser counterpart of `src/cli.ts`'s `runInterpreter` path.
 *
 * Why a worker: the interpreter has no cooperative yield, so a
 * user's long-running loop would freeze the UI. `worker.terminate()`
 * is the only reliable Stop. The event vocabulary
 * (`stdout`/`stderr`/`plot_record`/`done`/`error`) mirrors the JS
 * and WASM workers so the downstream console + figures pipeline
 * needs no special-case.
 */
/// <reference lib="webworker" />

import { PLOT_PREFIX } from "./plotProtocol";
import type { PlotRecord, WasmRunMessage } from "./wasmRunner.worker";
import { Workspace, parseFiles } from "../workspace/workspace";
import { Interpreter } from "../interpreter/interpreter";
import type { SourceFile } from "../translate";

export interface InterpreterRunRequest {
  type: "run";
  files: SourceFile[];
  mainName: string;
}

export type InterpreterRunMessage = WasmRunMessage;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: InterpreterRunMessage): void {
  ctx.postMessage(msg);
}

class StreamBuffer {
  private buf = "";
  constructor(private channel: "stdout" | "stderr") {}
  write(text: string): void {
    this.buf += text;
    let nl = this.buf.indexOf("\n");
    while (nl >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      this.emit(line, /*hasNewline*/ true);
      nl = this.buf.indexOf("\n");
    }
  }
  flush(): void {
    if (this.buf.length > 0) {
      this.emit(this.buf, /*hasNewline*/ false);
      this.buf = "";
    }
  }
  private emit(line: string, hasNewline: boolean): void {
    if (this.channel === "stdout" && line.startsWith(PLOT_PREFIX)) {
      const body = line.slice(PLOT_PREFIX.length);
      try {
        const parsed = JSON.parse(body) as PlotRecord;
        if (
          parsed &&
          typeof parsed.call === "string" &&
          Array.isArray(parsed.args)
        ) {
          post({ type: "plot_record", record: parsed });
          return;
        }
      } catch {
        post({ type: "stderr", text: `[bad plot record]: ${body}\n` });
        return;
      }
    }
    post({ type: this.channel, text: hasNewline ? `${line}\n` : line });
  }
}

function runOnce(req: InterpreterRunRequest): void {
  const stdout = new StreamBuffer("stdout");
  const stderr = new StreamBuffer("stderr");
  let exitCode = 0;

  try {
    const parsed = parseFiles(req.files);
    const ws = new Workspace(req.mainName, []);
    for (const f of parsed) ws.addFile(f);
    ws.finalize();

    const mainAst = ws.files.get(req.mainName)?.ast;
    if (!mainAst) {
      stderr.write(
        `interpreter: main file '${req.mainName}' has no parsed AST\n`
      );
      exitCode = 1;
    } else {
      const runtimeCtx = {
        helpers: { write: (s: string) => stdout.write(String(s)) },
      };
      new Interpreter(runtimeCtx, {
        workspace: ws,
        currentFile: req.mainName,
      }).runProgram(mainAst.body);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    exitCode = 1;
  }

  stdout.flush();
  stderr.flush();
  post({ type: "done", exitCode });
}

ctx.addEventListener(
  "message",
  (event: MessageEvent<InterpreterRunRequest>) => {
    const data = event.data;
    if (data && data.type === "run") {
      runOnce(data);
    }
  }
);

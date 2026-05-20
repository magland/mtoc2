/**
 * Web Worker that executes the JS produced by `src/codegen/emitJs.ts`.
 * The browser counterpart of `src/cli.ts`'s `runJsAot`:
 *
 *   1. The main thread lowers + emits JS and ships the source string here.
 *   2. We `(0, eval)(source)` in the worker's global scope — `emitJsProgram`
 *      ends its module with `return run;`, so evaluating the source as a
 *      function (`new Function(source)()`) returns the entry-point.
 *   3. We invoke `run({ write })` where `write(s)` posts `stdout` lines
 *      back to the main thread (with plot-record interception on lines
 *      that start with `PLOT_PREFIX`).
 *
 * Why a worker (vs running on the main thread): cancellation. JS has
 * no cooperative yield, so a user's long-running loop would freeze the
 * UI. `worker.terminate()` is bulletproof — the main thread keeps
 * responding and the Stop button is instant.
 */
/// <reference lib="webworker" />

import { PLOT_PREFIX } from "./plotProtocol";
import type { PlotRecord, WasmRunMessage } from "./wasmRunner.worker";

/** Request to the JS worker. The main thread lowers + emits JS and
 *  ships the resulting source as a string. */
export interface JsRunRequest {
  type: "run";
  jsSource: string;
}

/** Re-export so callers can speak one event vocabulary regardless of
 *  whether they're driving the JS or the WASM worker. The shape is
 *  identical — `done.exitCode`, `stdout.text`, etc. */
export type JsRunMessage = WasmRunMessage;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: JsRunMessage): void {
  ctx.postMessage(msg);
}

/** Buffered line-splitter for the `write` callback the emitted JS uses
 *  for every output. We accumulate bytes until a `\n` arrives and post
 *  one message per complete line. The plot-dispatch sentinel only
 *  appears at the start of a complete line (the runtime ends each
 *  record with `\n`), so detection is sound. A trailing un-terminated
 *  fragment is flushed at run end. */
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

function runOnce(req: JsRunRequest): void {
  const stdout = new StreamBuffer("stdout");
  const stderr = new StreamBuffer("stderr");
  let exitCode = 0;

  // emitJsProgram emits a module that ends with `return run;`, so
  // wrapping the whole source in `new Function(...)` and invoking
  // returns the `run` entry point. The emitted `run` binds
  // `globalThis.$write` itself from the ctx we pass in.
  try {
    const run = new Function(req.jsSource)() as (ctx: {
      write: (s: string) => void;
    }) => void;
    run({ write: s => stdout.write(String(s)) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    exitCode = 1;
  }
  stdout.flush();
  stderr.flush();
  post({ type: "done", exitCode });
}

ctx.addEventListener("message", (event: MessageEvent<JsRunRequest>) => {
  const data = event.data;
  if (data && data.type === "run") {
    runOnce(data);
  }
});

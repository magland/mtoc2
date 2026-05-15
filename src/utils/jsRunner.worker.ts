/**
 * Web Worker that executes the JS produced by the c2js backend (see
 * `src/cjs/`). The browser counterpart of `src/cli.ts`'s `runJsSource`:
 * instead of spawning a child `node`, we install a tiny `process` shim
 * on `globalThis` and `eval` the JS source in the worker's global
 * scope. The shim's `stdout.write` / `stderr.write` post messages back
 * to the main thread using the SAME `RunEvent` shape the wasm worker
 * uses (`PlotRecord`, `stdout`, `stderr`, `done`, `error`), so the
 * existing console + figures pipeline downstream needs no special-case.
 *
 * Why a worker (vs running on the main thread): cancellation. JS has
 * no cooperative yield, so a user's long-running loop would freeze the
 * UI. `worker.terminate()` is bulletproof — the main thread keeps
 * responding and the Stop button is instant.
 */
/// <reference lib="webworker" />

import { PLOT_PREFIX } from "./plotProtocol";
import type { PlotRecord, WasmRunMessage } from "./wasmRunner.worker";

/** Request to the JS worker. The c2js translator runs on the main
 *  thread (it's small and fast) and ships the resulting JS source
 *  here as a string. */
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

/** Buffered line-splitter for `process.stdout.write` / `stderr.write`.
 *  c2js's emitted runtime calls `write` once per `printf` (which may
 *  produce zero, one, or many newlines), so we accumulate bytes until
 *  a `\n` arrives and post one message per complete line. The plot-
 *  dispatch sentinel only appears at the start of a complete line
 *  (the C runtime ends the record with `\n`), so detection is sound.
 *  A trailing un-terminated fragment is flushed at run end. */
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
  /** Drain a non-newline-terminated tail at exit. The wasm worker
   *  posts every Emscripten `print` with a trailing newline appended,
   *  so this only matters for the JS path where mtoc2's `fprintf`
   *  conveniently always ends its output in `\n` — but a future
   *  builtin (e.g. a write-without-newline disp) could change that. */
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

/** Sentinel thrown by the `process.exit` shim. Caught around the eval
 *  so a script that calls `process.exit(0)` doesn't surface as an
 *  uncaught worker error. */
class ExitSentinel {
  constructor(public code: number) {}
}

function runOnce(req: JsRunRequest): void {
  const stdout = new StreamBuffer("stdout");
  const stderr = new StreamBuffer("stderr");
  let exitCode = 0;

  // Minimal Node-process shim. The c2js runtime in `src/cjs/runtime.js`
  // only touches `stdout.write`, `stderr.write`, `exit`, and
  // `hrtime`; everything else stays undefined. If a future c2js change
  // grows the surface, surface the new dependency here.
  const processShim = {
    stdout: { write: (s: string) => stdout.write(String(s)) },
    stderr: { write: (s: string) => stderr.write(String(s)) },
    exit: (code: number) => {
      exitCode = code | 0;
      throw new ExitSentinel(exitCode);
    },
    hrtime: () => {
      // `process.hrtime()` returns `[sec, nsec]`. `performance.now()`
      // is a sub-millisecond wall-clock that monotonically advances
      // within a worker, which is all `tic`/`toc` care about.
      const ms = performance.now();
      const sec = Math.floor(ms / 1000);
      const nsec = Math.floor((ms - sec * 1000) * 1e6);
      return [sec, nsec];
    },
  };

  // Install the shim on the worker's global scope BEFORE eval'ing the
  // source. The c2js runtime's `__rt_printf` etc. read `process` by
  // name without any prior declaration, relying on Node's auto-global.
  (globalThis as unknown as { process: typeof processShim }).process =
    processShim;

  try {
    // Indirect `eval` runs in global scope, so `function foo()`
    // declarations land on `globalThis`. The script's trailing
    // `const __rt_rc = main()` lives in a const so it doesn't pollute
    // globals after the run.
    (0, eval)(req.jsSource);
  } catch (error) {
    if (error instanceof ExitSentinel) {
      // process.exit() called — normal early termination. Fall through
      // to the done message below.
    } else {
      const message = error instanceof Error ? error.message : String(error);
      stderr.write(`${message}\n`);
      exitCode = 1;
    }
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

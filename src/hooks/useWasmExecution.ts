import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildWasm,
  getWasmServiceUrl,
  runWasm,
  type PlotRecord,
  type RunEvent,
  type WasmOptLevel,
} from "../utils/wasmExecution";
import { buildJs, runJs } from "../utils/jsExecution";
import { evictExpiredWasm } from "../db/wasmCache";
import type { SourceFile } from "../translate";

/** Which backend the run goes through. `"js"` translates locally
 *  (numbl → C → JS) and runs the JS in a Web Worker; needs no remote
 *  service and gives instant turnaround. `"wasm"` POSTs the C to the
 *  public emcc service, caches the wasm in IndexedDB, and runs that
 *  in a worker; slower first run but full native numeric throughput. */
export type ExecutionMode = "js" | "wasm";

export type RunStatus =
  | "idle"
  /** The translated C is in flight to the public compile service and we're
   *  waiting on the wasm bytes back. Separate from "running" so the UI can
   *  tell the user that the current latency is the network round trip, not
   *  anything the program itself is doing. */
  | "compiling"
  | "running"
  | "success"
  | "error"
  | "aborted"
  | "compile_error";

export interface ConsoleLine {
  /** Distinguishes channels in the UI; mirrors the worker / wasm-service
   *  event types we emit, plus a synthetic "info" for client-generated
   *  banners. */
  channel: "stdout" | "stderr" | "compile_error" | "translate_error" | "info";
  text: string;
}

export interface RunOptions {
  /** Backend to use. Defaults to "wasm" for back-compat with existing
   *  call sites; new callers should pass `mode` explicitly. */
  mode?: ExecutionMode;
  fastMath?: boolean;
  simd?: boolean;
  optLevel?: WasmOptLevel;
  /** Run the IR-level `--inline-temps` pass before emitting C. Affects
   *  both JS and WASM modes (it's a pre-codegen transform). */
  enableTempInlining?: boolean;
}

/** Format a translate-side error for the console: `<kind> (<file>): <msg>\n`,
 *  with the file segment omitted if no fileName is attached. Shared by the
 *  event-channel and the build-failure paths. */
function formatTranslateError(e: {
  kind: string;
  fileName?: string;
  message: string;
}): string {
  const where = e.fileName ? ` (${e.fileName})` : "";
  return `${e.kind}${where}: ${e.message}\n`;
}

interface UseWasmExecutionResult {
  status: RunStatus;
  /** Console output as a list of typed lines. Cleared at run start. */
  lines: ConsoleLine[];
  /** Plot-dispatch records emitted by the wasm during the current run,
   *  in execution order. Cleared at run start. The FiguresPanel feeds
   *  this list into numbl's `dispatchPlotBuiltin` (see
   *  `utils/plotAdapter.ts`) to render figures. */
  plotRecords: PlotRecord[];
  /** Translate + compile + run the project via the WASM pipeline. */
  run: (
    files: SourceFile[],
    activeName: string,
    opts?: RunOptions
  ) => Promise<void>;
  /** Abort the currently-running execution. */
  stop: () => void;
}

export function useWasmExecution(): UseWasmExecutionResult {
  const [status, setStatus] = useState<RunStatus>("idle");
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [plotRecords, setPlotRecords] = useState<PlotRecord[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const append = useCallback((line: ConsoleLine) => {
    setLines(prev => [...prev, line]);
  }, []);

  const appendPlot = useCallback((record: PlotRecord) => {
    setPlotRecords(prev => [...prev, record]);
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleEvent = useCallback(
    (event: RunEvent) => {
      if (event.type === "stdout" || event.type === "stderr") {
        append({ channel: event.type, text: event.text });
      } else if (event.type === "plot_record") {
        appendPlot(event.record);
      } else if (event.type === "compile_error") {
        append({ channel: "compile_error", text: event.text });
      } else if (event.type === "translate_error") {
        append({
          channel: "translate_error",
          text: formatTranslateError(event),
        });
      }
      // "done" is consumed by the caller via the resolved RunResult.
    },
    [append, appendPlot]
  );

  const run = useCallback(
    async (files: SourceFile[], activeName: string, opts: RunOptions = {}) => {
      if (status === "running" || status === "compiling") return;

      setLines([]);
      setPlotRecords([]);
      setStatus("running");

      const abort = new AbortController();
      abortRef.current = abort;

      const finish = (next: RunStatus) => {
        abortRef.current = null;
        setStatus(next);
      };

      // JS mode: translate + c2js locally, then run in a worker. No
      // remote service, no compile pill — c2js is fast enough that
      // the user sees the run immediately.
      if (opts.mode === "js") {
        const built = buildJs(files, activeName, {
          enableTempInlining: opts.enableTempInlining,
        });
        if (!built.ok) {
          append({
            channel: "translate_error",
            text: formatTranslateError(built.error),
          });
          finish("error");
          return;
        }
        const result = await runJs(
          built.jsSource,
          { onEvent: handleEvent },
          abort.signal
        );
        if (result.aborted) {
          append({ channel: "info", text: "\n[stopped]\n" });
          finish("aborted");
          return;
        }
        if (result.transportError) {
          append({
            channel: "info",
            text: `\n[js worker error: ${result.transportError}]\n`,
          });
          finish("error");
          return;
        }
        finish(result.success ? "success" : "error");
        return;
      }

      const wasmUrl = getWasmServiceUrl();
      const build = await buildWasm(
        files,
        activeName,
        {
          fastMath: opts.fastMath ?? false,
          simd: opts.simd ?? false,
          optLevel: opts.optLevel ?? "O3",
          enableTempInlining: opts.enableTempInlining,
        },
        wasmUrl,
        abort.signal,
        {
          // Flip to "compiling" only when the build actually goes to the
          // network. On a cache hit this never fires and we stay on
          // "running" — the worker will be spawned almost instantly so
          // the user never sees the intermediate state.
          onCompileStart: () => {
            setStatus("compiling");
            append({ channel: "info", text: "[compiling WASM…]\n" });
          },
        }
      );
      if (!build.ok) {
        if (build.kind === "aborted") {
          append({ channel: "info", text: "\n[stopped]\n" });
          finish("aborted");
          return;
        }
        if (build.kind === "transport") {
          append({
            channel: "info",
            text: `\n[wasm service error: ${build.message}]\n`,
          });
          finish("error");
          return;
        }
        if (build.kind === "translate") {
          append({
            channel: "translate_error",
            text: formatTranslateError(build.error),
          });
          finish("error");
          return;
        }
        // compile error
        append({ channel: "compile_error", text: build.stderr });
        finish("compile_error");
        return;
      }

      // Compile leg done (or skipped on cache hit). Back to the "running"
      // pill while the worker drives the wasm — important for the
      // cache-miss path where status is currently "compiling".
      setStatus("running");
      const result = await runWasm(
        build.artifact,
        { onEvent: handleEvent },
        abort.signal
      );
      if (result.aborted) {
        append({ channel: "info", text: "\n[stopped]\n" });
        finish("aborted");
        return;
      }
      if (result.transportError) {
        append({
          channel: "info",
          text: `\n[wasm error: ${result.transportError}]\n`,
        });
        finish("error");
        return;
      }
      finish(result.success ? "success" : "error");
    },
    [append, handleEvent, status]
  );

  // On mount, sweep expired entries out of the wasm cache so a multi-MB
  // stale cache from previous sessions doesn't sit forever. get/put are
  // fast either way, but a large cache slightly slows opening the IDB.
  useEffect(() => {
    void evictExpiredWasm();
  }, []);

  return { status, lines, plotRecords, run, stop };
}

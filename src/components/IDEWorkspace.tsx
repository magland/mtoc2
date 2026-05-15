import { useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Button,
  FormControl,
  FormControlLabel,
  IconButton,
  MenuItem,
  Select,
  Switch,
  Tab,
  Tabs,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import Editor, { type OnMount, useMonaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import StopIcon from "@mui/icons-material/Stop";
import SettingsIcon from "@mui/icons-material/Settings";
import { Splitter } from "../../../numbl/src/components/Splitter";
import { FileBrowser } from "../../../numbl/src/components/FileBrowser";
import { CSourcePanel } from "./CSourcePanel";
import { JsSourcePanel } from "./JsSourcePanel";
import { ConsolePanel } from "./ConsolePanel";
import { FiguresPanel } from "./FiguresPanel";
import { translateCToJs } from "../cjs";
import { translateProject } from "../translate";
import { ExecutionSettingsDialog } from "./ExecutionSettingsDialog";
import { useTranslation } from "../hooks/useTranslation";
import {
  useWasmExecution,
  type ExecutionMode,
} from "../hooks/useWasmExecution";
import {
  fileText,
  type UseProjectFilesResult,
  type WorkspaceFile,
} from "../hooks/useProjectFiles";
import {
  numblLanguageConfig,
  createNumblTokensProvider,
} from "../monaco/numblLanguage";
import type { SourceFile } from "../translate";
import type { WasmOptLevel } from "../utils/wasmExecution";
import { DEFAULT_OPT_PROFILE, profileSettings } from "../optProfile";
import { textEncoder } from "../utils/textCodec";

const WASM_OPT_LEVELS: ReadonlyArray<WasmOptLevel> = ["O0", "O2", "O3"];

interface IDEWorkspaceProps {
  /** Returned by useProjectFiles or useShareProjectFiles. */
  filesApi: UseProjectFilesResult;
  /** Header content (back button, project name, share button). */
  header?: React.ReactNode;
}

const WASM_OPT_LEVEL_KEY = "mtoc_wasm_opt_level";
const WASM_SIMD_KEY = "mtoc_wasm_simd";
const EXEC_MODE_KEY = "mtoc_exec_mode";
const SIDEBAR_WIDTH_KEY = "mtoc_sidebar_width";
const EDITOR_WIDTH_KEY = "mtoc_editor_width";
const OUTPUT_HEIGHT_KEY = "mtoc_output_height";

function readWasmOptLevel(): WasmOptLevel {
  const v = localStorage.getItem(WASM_OPT_LEVEL_KEY);
  if (v === "O0" || v === "O2" || v === "O3") return v;
  // Default to -O3: emcc compile time is acceptable (a few seconds even
  // for tensor-heavy programs) and the runtime win matters for users
  // exploring numbl in the IDE. O2 stays a one-click choice.
  return "O3";
}

function readWasmSimd(): boolean {
  return localStorage.getItem(WASM_SIMD_KEY) === "true";
}

function readExecutionMode(): ExecutionMode {
  // Default to "js" because the WASM path needs the public compile
  // service. A first-time user with nothing configured should be able
  // to hit Run and see output immediately. Power users who want the
  // throughput of native wasm can toggle to "wasm" — the choice
  // sticks across reloads via this key.
  const v = localStorage.getItem(EXEC_MODE_KEY);
  return v === "wasm" ? "wasm" : "js";
}

function readNumber(key: string, fallback: number): number {
  const v = localStorage.getItem(key);
  if (v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function activeName(
  files: WorkspaceFile[],
  activeFileId: string
): string | null {
  return files.find(f => f.id === activeFileId)?.name ?? null;
}

type OutputTab = "output" | "internals";
type InternalsSubTab = "c" | "js";

export function IDEWorkspace({ filesApi, header }: IDEWorkspaceProps) {
  const {
    files,
    activeFileId,
    loading,
    setActiveFileId,
    updateFileContent,
    addFile,
    addFolder,
    deleteFile,
    deleteFolder,
    renameFile,
    renameFolder,
    moveFile,
    duplicateFile,
    uploadFiles,
    loadFileContent,
    contentCache,
  } = filesApi;

  const monaco = useMonaco();
  const [editorModel, setEditorModel] = useState<editor.ITextModel | null>(
    null
  );
  const [contents, setContents] = useState<Map<string, string>>(new Map());
  const loadedRef = useRef(new Set<string>());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [includeRuntime, setIncludeRuntime] = useState(false);
  const [fastMath, setFastMath] = useState(false);
  // Default trio matches mtoc's `default` profile. `enableTempInlining`
  // is the IR-level temp-substitution pass; affects both JS and WASM
  // since it shapes the C source itself before codegen. On by default
  // so the IDE matches `mtoc2 run`'s default behavior.
  const [enableTempInlining, setEnableTempInlining] = useState(
    profileSettings(DEFAULT_OPT_PROFILE).enableTempInlining
  );
  const [wasmOptLevel, setWasmOptLevel] = useState<WasmOptLevel>(() =>
    readWasmOptLevel()
  );
  const [wasmSimd, setWasmSimd] = useState<boolean>(() => readWasmSimd());
  const [execMode, setExecMode] = useState<ExecutionMode>(() =>
    readExecutionMode()
  );
  const [outputTab, setOutputTab] = useState<OutputTab>("output");
  const [internalsSubTab, setInternalsSubTab] = useState<InternalsSubTab>("c");
  const [triggerRenameId, setTriggerRenameId] = useState<string | undefined>();

  // Layout sizing — persisted across reloads so the user's chosen
  // proportions survive page navigation.
  const initialSidebarWidth = useMemo(
    () => readNumber(SIDEBAR_WIDTH_KEY, window.innerWidth >= 1200 ? 220 : 180),
    []
  );
  const initialEditorWidth = useMemo(
    () =>
      readNumber(
        EDITOR_WIDTH_KEY,
        Math.max(360, (window.innerWidth - initialSidebarWidth) / 2)
      ),
    [initialSidebarWidth]
  );
  const initialOutputHeight = useMemo(
    () => readNumber(OUTPUT_HEIGHT_KEY, Math.round(window.innerHeight * 0.55)),
    []
  );

  const handleSidebarSizeChange = (size: number) => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(size)));
  };
  const handleEditorSizeChange = (size: number) => {
    localStorage.setItem(EDITOR_WIDTH_KEY, String(Math.round(size)));
  };
  const handleOutputSizeChange = (size: number) => {
    localStorage.setItem(OUTPUT_HEIGHT_KEY, String(Math.round(size)));
  };

  const handleWasmOptLevelChange = (next: WasmOptLevel) => {
    setWasmOptLevel(next);
    localStorage.setItem(WASM_OPT_LEVEL_KEY, next);
  };
  const handleWasmSimdChange = (next: boolean) => {
    setWasmSimd(next);
    localStorage.setItem(WASM_SIMD_KEY, String(next));
  };
  const handleExecModeChange = (next: ExecutionMode) => {
    setExecMode(next);
    localStorage.setItem(EXEC_MODE_KEY, next);
  };
  const exec = useWasmExecution();

  // Register the numbl Monaco language exactly once per Monaco instance.
  useEffect(() => {
    if (!monaco) return;
    const langs = monaco.languages.getLanguages();
    if (!langs.some(l => l.id === "numbl")) {
      monaco.languages.register({ id: "numbl" });
      monaco.languages.setLanguageConfiguration("numbl", numblLanguageConfig);
      monaco.languages.setMonarchTokensProvider(
        "numbl",
        createNumblTokensProvider()
      );
    }
  }, [monaco]);

  // Pull file content into our text-decoded mirror once per file.
  // Mark a file as loaded *after* setContents succeeds — adding it before the
  // await could leave the file permanently locked out of the decoded mirror
  // if the effect is cancelled mid-load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const f of files) {
        if (loadedRef.current.has(f.id)) continue;
        const data = await loadFileContent(f.id);
        if (cancelled) return;
        loadedRef.current.add(f.id);
        setContents(prev => {
          // If the user has already typed into this file before the load
          // resolved, prev already has the live content — don't clobber it.
          if (prev.has(f.id)) return prev;
          const next = new Map(prev);
          next.set(f.id, fileText(data));
          return next;
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [files, loadFileContent]);

  // Auto-clear triggerRenameId after a short delay so a stale id doesn't
  // re-fire the rename when an unrelated state change re-renders FileBrowser.
  useEffect(() => {
    if (triggerRenameId === undefined) return;
    const t = setTimeout(() => setTriggerRenameId(undefined), 100);
    return () => clearTimeout(t);
  }, [triggerRenameId]);

  const sourceFiles: SourceFile[] = useMemo(() => {
    return files
      .filter(f => contents.has(f.id))
      .map(f => ({ name: f.name, source: contents.get(f.id) ?? "" }));
  }, [files, contents]);

  const active = activeName(files, activeFileId);
  const activeContent = activeFileId ? (contents.get(activeFileId) ?? "") : "";
  const otherFiles = useMemo(
    () => sourceFiles.filter(f => f.name !== active),
    [sourceFiles, active]
  );

  const { c, error } = useTranslation(
    sourceFiles,
    active ?? "",
    editorModel,
    includeRuntime,
    enableTempInlining
  );

  // Derive the JS that the JS-mode worker would actually run. We
  // re-translate with `includeRuntime: true` here regardless of the
  // user's "runtime helpers" toggle (which only governs the displayed
  // C): c2js needs the runtime typedefs (`mtoc2_tensor_t`, etc.) to
  // parse the source, otherwise it bails with "expected type (got id
  // …)". This matches the C the JS-mode worker feeds to c2js, so the
  // panel reflects the running code. Computed regardless of execMode
  // so flipping to JS doesn't add a render delay; the cost is one
  // extra translateProject pass.
  const { js, jsError } = useMemo<{
    js: string;
    jsError: string | null;
  }>(() => {
    if (!c || error) return { js: "", jsError: null };
    const result = translateProject(sourceFiles, active ?? "", {
      includeRuntime: true,
      enableTempInlining,
    });
    if (result.error || !result.c) return { js: "", jsError: null };
    try {
      return { js: translateCToJs(result.c), jsError: null };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { js: "", jsError: `c2js: ${message}` };
    }
  }, [c, error, sourceFiles, active, enableTempInlining]);

  // When JS mode is gone (mode flipped to wasm), keep the user on a
  // sub-tab they can actually see — prefer C over JS when only one is
  // shown.
  useEffect(() => {
    if (execMode !== "js" && internalsSubTab === "js") {
      setInternalsSubTab("c");
    }
  }, [execMode, internalsSubTab]);

  const handleEditorMount: OnMount = editorInstance => {
    setEditorModel(editorInstance.getModel());
  };

  const handleChange = (value: string | undefined) => {
    const v = value ?? "";
    setContents(prev => {
      const next = new Map(prev);
      next.set(activeFileId, v);
      return next;
    });
    contentCache.current.set(activeFileId, textEncoder.encode(v));
    updateFileContent(v);
  };

  // "compiling" (wasm-service network round trip) is also a busy state —
  // the user shouldn't be able to fire a second run, and the Run button
  // should already show Stop so they can cancel mid-fetch.
  const isRunning = exec.status === "running" || exec.status === "compiling";
  const canRun = !!c && !error && !isRunning;
  const runDisabledReason = !c
    ? "Nothing to run yet."
    : error
      ? "Fix translation errors before running."
      : null;

  const handleRun = () => {
    if (!active) return;
    exec.run(sourceFiles, active, {
      mode: execMode,
      fastMath,
      simd: wasmSimd,
      optLevel: wasmOptLevel,
      enableTempInlining,
    });
  };

  const fileBrowserContent = (
    <FileBrowser
      files={files}
      activeFileId={activeFileId}
      onSelectFile={setActiveFileId}
      onAddFile={async folderPath => {
        const id = await addFile(folderPath);
        if (id) setTriggerRenameId(id);
      }}
      onAddFolder={async parentPath => {
        const folderPath = await addFolder(parentPath);
        if (folderPath) setTriggerRenameId(`folder:${folderPath}`);
      }}
      onDeleteFile={deleteFile}
      onDeleteFolder={deleteFolder}
      onRenameFile={renameFile}
      onRenameFolder={renameFolder}
      onMoveFile={moveFile}
      onDuplicateFile={async fileId => {
        const id = await duplicateFile(fileId);
        if (id) setTriggerRenameId(id);
      }}
      onUploadFiles={uploadFiles}
      fileCount={files.length}
      triggerRenameId={triggerRenameId}
    />
  );

  const editorPanel = (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <EditorToolbar
        isRunning={isRunning}
        canRun={canRun}
        runDisabledReason={runDisabledReason}
        onRun={handleRun}
        onStop={exec.stop}
        onOpenSettings={() => setSettingsOpen(true)}
        mode={execMode}
        onModeChange={handleExecModeChange}
        fastMath={fastMath}
        onFastMathChange={setFastMath}
        enableTempInlining={enableTempInlining}
        onEnableTempInliningChange={setEnableTempInlining}
        wasmOptLevel={wasmOptLevel}
        onWasmOptLevelChange={handleWasmOptLevelChange}
        wasmSimd={wasmSimd}
        onWasmSimdChange={handleWasmSimdChange}
        activeFileName={active}
      />
      <Box sx={{ flex: 1, minHeight: 0 }}>
        {!loading && active && contents.has(activeFileId) ? (
          <Editor
            key={activeFileId}
            height="100%"
            language="numbl"
            path={active}
            defaultValue={activeContent}
            onChange={handleChange}
            onMount={handleEditorMount}
            options={{
              minimap: { enabled: false },
              fontSize: 14,
              lineNumbers: "on",
              automaticLayout: true,
              scrollBeyondLastLine: false,
            }}
          />
        ) : (
          <Box sx={{ p: 2, color: "text.secondary" }}>
            {loading || (active && !contents.has(activeFileId))
              ? "Loading…"
              : "No file selected"}
          </Box>
        )}
      </Box>
    </Box>
  );

  const outputPanel = (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Tabs
        value={outputTab}
        onChange={(_, v: OutputTab) => setOutputTab(v)}
        sx={{
          borderBottom: 1,
          borderColor: "divider",
          minHeight: 34,
          "& .MuiTab-root": {
            textTransform: "none",
            fontWeight: 500,
            fontSize: "0.8rem",
            minHeight: 34,
            py: 0,
          },
        }}
      >
        <Tab value="output" label="Output" />
        <Tab value="internals" label="Internals" />
      </Tabs>
      <Box sx={{ flex: 1, minHeight: 0, position: "relative" }}>
        {/* Both tabs mounted unconditionally so the C source keeps
            updating while Output is foregrounded — the user can flip
            to Internals and see fresh translation immediately. */}
        <Box
          sx={{
            position: "absolute",
            inset: 0,
            display: outputTab === "output" ? "flex" : "none",
            flexDirection: "column",
          }}
        >
          <ConsolePanel lines={exec.lines} status={exec.status} />
        </Box>
        <Box
          sx={{
            position: "absolute",
            inset: 0,
            display: outputTab === "internals" ? "flex" : "none",
            flexDirection: "column",
          }}
        >
          {execMode === "js" && (
            <Box
              sx={{
                px: 1,
                py: 0.5,
                borderBottom: 1,
                borderColor: "divider",
                display: "flex",
                alignItems: "center",
                gap: 0.5,
                bgcolor: "background.default",
              }}
            >
              <ToggleButtonGroup
                size="small"
                exclusive
                value={internalsSubTab}
                onChange={(_, v) => {
                  if (v === "c" || v === "js") setInternalsSubTab(v);
                }}
                sx={{
                  "& .MuiToggleButton-root": {
                    px: 1.25,
                    py: 0.25,
                    fontSize: 11,
                    textTransform: "none",
                  },
                }}
              >
                <ToggleButton value="c">C</ToggleButton>
                <ToggleButton value="js">JS</ToggleButton>
              </ToggleButtonGroup>
            </Box>
          )}
          <Box sx={{ flex: 1, minHeight: 0, position: "relative" }}>
            <Box
              sx={{
                position: "absolute",
                inset: 0,
                display:
                  execMode !== "js" || internalsSubTab === "c"
                    ? "flex"
                    : "none",
                flexDirection: "column",
              }}
            >
              <CSourcePanel
                c={c}
                error={error}
                otherFiles={otherFiles}
                activeName={active ?? ""}
                includeRuntime={includeRuntime}
                onIncludeRuntimeChange={setIncludeRuntime}
              />
            </Box>
            {execMode === "js" && (
              <Box
                sx={{
                  position: "absolute",
                  inset: 0,
                  display: internalsSubTab === "js" ? "flex" : "none",
                  flexDirection: "column",
                }}
              >
                <JsSourcePanel js={js} error={jsError} />
              </Box>
            )}
          </Box>
        </Box>
      </Box>
    </Box>
  );

  const figuresOnlyPanel = <FiguresPanel plotRecords={exec.plotRecords} />;

  return (
    <Box
      sx={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        bgcolor: "background.default",
      }}
    >
      {header && (
        <Box
          sx={{
            flex: "0 0 auto",
            borderBottom: 1,
            borderColor: "divider",
            bgcolor: "background.paper",
          }}
        >
          {header}
        </Box>
      )}
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <Splitter
          direction="vertical"
          initialSize={initialSidebarWidth}
          minSize={150}
          maxSize={400}
          onSizeChange={handleSidebarSizeChange}
        >
          {fileBrowserContent}
          <Splitter
            direction="vertical"
            initialSize={initialEditorWidth}
            minSize={300}
            onSizeChange={handleEditorSizeChange}
          >
            {editorPanel}
            <Splitter
              direction="horizontal"
              initialSize={initialOutputHeight}
              minSize={150}
              onSizeChange={handleOutputSizeChange}
            >
              {outputPanel}
              {figuresOnlyPanel}
            </Splitter>
          </Splitter>
        </Splitter>
      </Box>
      <ExecutionSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </Box>
  );
}

interface EditorToolbarProps {
  isRunning: boolean;
  canRun: boolean;
  runDisabledReason: string | null;
  onRun: () => void;
  onStop: () => void;
  onOpenSettings: () => void;
  mode: ExecutionMode;
  onModeChange: (next: ExecutionMode) => void;
  /** `-ffast-math`. WASM-only. */
  fastMath: boolean;
  onFastMathChange: (value: boolean) => void;
  /** IR-level temp-substitution pass (`--inline-temps`). Affects both
   *  JS and WASM since it shapes the C source itself. */
  enableTempInlining: boolean;
  onEnableTempInliningChange: (value: boolean) => void;
  /** `-O{0,2,3}` for emcc. WASM-only. */
  wasmOptLevel: WasmOptLevel;
  onWasmOptLevelChange: (value: WasmOptLevel) => void;
  /** `-msimd128` for emcc. WASM-only. */
  wasmSimd: boolean;
  onWasmSimdChange: (value: boolean) => void;
  activeFileName: string | null;
}

function EditorToolbar({
  isRunning,
  canRun,
  runDisabledReason,
  onRun,
  onStop,
  onOpenSettings,
  mode,
  onModeChange,
  fastMath,
  onFastMathChange,
  enableTempInlining,
  onEnableTempInliningChange,
  wasmOptLevel,
  onWasmOptLevelChange,
  wasmSimd,
  onWasmSimdChange,
  activeFileName,
}: EditorToolbarProps) {
  // The build-flag toggles only affect the WASM emcc invocation, so they
  // grey out in JS mode (and while a run is in flight — toggling mid-run
  // wouldn't take effect until the next compile anyway).
  const buildFlagsDisabled = mode !== "wasm" || isRunning;
  const runButton = (
    <span>
      <Button
        size="small"
        variant="contained"
        color={isRunning ? "error" : "success"}
        startIcon={isRunning ? <StopIcon /> : <PlayArrowIcon />}
        onClick={isRunning ? onStop : onRun}
        disabled={!isRunning && !canRun}
        sx={{
          py: 0.25,
          px: 2,
          minWidth: 90,
          fontSize: "0.8rem",
          fontWeight: 600,
          textTransform: "none",
          boxShadow: "none",
          "&:hover": { boxShadow: "none" },
        }}
      >
        {isRunning ? "Stop" : "Run"}
      </Button>
    </span>
  );
  return (
    <Box
      sx={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 1,
        px: 1.5,
        py: 0.5,
        borderBottom: 1,
        borderColor: "divider",
        bgcolor: "background.default",
      }}
    >
      {runDisabledReason && !isRunning ? (
        <Tooltip title={runDisabledReason}>{runButton}</Tooltip>
      ) : (
        runButton
      )}
      <Tooltip
        title={
          mode === "js"
            ? "JS mode: translate to JavaScript locally and run in a Web Worker. No remote service needed."
            : "WASM mode: POST translated C to the compile service, cache the wasm, run in a Web Worker. Native numeric throughput."
        }
      >
        <ToggleButtonGroup
          size="small"
          exclusive
          value={mode}
          onChange={(_, next) => {
            if (next === "js" || next === "wasm") onModeChange(next);
          }}
          disabled={isRunning}
          sx={{
            ml: 0.5,
            "& .MuiToggleButton-root": { px: 1.25, py: 0.25, fontSize: 11 },
          }}
        >
          <ToggleButton value="js">JS</ToggleButton>
          <ToggleButton value="wasm">WASM</ToggleButton>
        </ToggleButtonGroup>
      </Tooltip>
      <Tooltip
        title={
          buildFlagsDisabled
            ? "WASM-only build flag (switch to WASM mode to enable)."
            : "emcc -O level for the WASM build."
        }
      >
        <FormControl size="small" sx={{ m: 0 }}>
          <Select
            value={wasmOptLevel}
            onChange={e => onWasmOptLevelChange(e.target.value as WasmOptLevel)}
            variant="standard"
            disableUnderline
            renderValue={v => `-${v}`}
            disabled={buildFlagsDisabled}
            sx={{
              fontSize: 12,
              color: "text.secondary",
              "& .MuiSelect-select": { py: 0, pr: "18px !important" },
            }}
          >
            {WASM_OPT_LEVELS.map(p => (
              <MenuItem key={p} value={p} dense>
                <Typography variant="caption">-{p}</Typography>
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Tooltip>
      <Tooltip
        title={
          isRunning
            ? "Temp-inlining only takes effect on the next translation; toggle when idle."
            : "IR-level --inline-temps pass: substitute single-use tensor temps into their consumers so chained elementwise ops fuse into one inline loop. Applies to both JS and WASM."
        }
      >
        <FormControlLabel
          sx={{ m: 0 }}
          control={
            <Switch
              size="small"
              checked={enableTempInlining}
              onChange={e => onEnableTempInliningChange(e.target.checked)}
              disabled={isRunning}
            />
          }
          label={
            <Typography variant="caption" color="text.secondary">
              inline temps
            </Typography>
          }
        />
      </Tooltip>
      <Tooltip
        title={
          buildFlagsDisabled
            ? "WASM-only build flag (switch to WASM mode to enable)."
            : "Compile with -ffast-math."
        }
      >
        <FormControlLabel
          sx={{ m: 0 }}
          control={
            <Switch
              size="small"
              checked={fastMath}
              onChange={e => onFastMathChange(e.target.checked)}
              disabled={buildFlagsDisabled}
            />
          }
          label={
            <Typography variant="caption" color="text.secondary">
              fast math
            </Typography>
          }
        />
      </Tooltip>
      <Tooltip
        title={
          buildFlagsDisabled
            ? "WASM-only build flag (switch to WASM mode to enable)."
            : "Compile WASM with -msimd128 for vectorized loops."
        }
      >
        <FormControlLabel
          sx={{ m: 0 }}
          control={
            <Switch
              size="small"
              checked={wasmSimd}
              onChange={e => onWasmSimdChange(e.target.checked)}
              disabled={buildFlagsDisabled}
            />
          }
          label={
            <Typography variant="caption" color="text.secondary">
              simd
            </Typography>
          }
        />
      </Tooltip>
      <Tooltip title="Execution settings">
        <IconButton
          size="small"
          onClick={onOpenSettings}
          sx={{ color: "text.secondary" }}
        >
          <SettingsIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      {activeFileName && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ ml: "auto", fontFamily: "monospace", fontWeight: "bold" }}
        >
          {activeFileName}
        </Typography>
      )}
    </Box>
  );
}

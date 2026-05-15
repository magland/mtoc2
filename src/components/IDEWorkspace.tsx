import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Button, IconButton, Tooltip, Typography } from "@mui/material";
import Editor, { type OnMount, useMonaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import StopIcon from "@mui/icons-material/Stop";
import SettingsIcon from "@mui/icons-material/Settings";
import { Splitter } from "./Splitter";
import { FileBrowser } from "./FileBrowser";
import { CSourcePanel } from "./CSourcePanel";
import { OutputPanel } from "./OutputPanel";
import { ExecutionSettingsDialog } from "./ExecutionSettingsDialog";
import { useTranslation } from "../hooks/useTranslation";
import { useWasmExecution } from "../hooks/useWasmExecution";
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
import {
  DEFAULT_OPT_PROFILE,
  profileSettings,
  type OptProfile,
} from "../optProfile";
import type { WasmOptLevel } from "../utils/wasmExecution";

interface IDEWorkspaceProps {
  /** Returned by useProjectFiles or useShareProjectFiles. */
  filesApi: UseProjectFilesResult;
  /** Header content (back button, project name, share button). */
  header?: React.ReactNode;
}

const textEncoder = new TextEncoder();

const WASM_OPT_LEVEL_KEY = "mtoc_wasm_opt_level";
const WASM_SIMD_KEY = "mtoc_wasm_simd";

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

function activeName(
  files: WorkspaceFile[],
  activeFileId: string
): string | null {
  return files.find(f => f.id === activeFileId)?.name ?? null;
}

export function IDEWorkspace({ filesApi, header }: IDEWorkspaceProps) {
  const {
    files,
    activeFileId,
    loading,
    setActiveFileId,
    updateFileContent,
    addFile,
    deleteFile,
    renameFile,
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
  // Initial settings = whatever `default` profile resolves to. The
  // profile dropdown lets the user jump between presets; the fast-math
  // toggle overrides on top.
  const initialOpt = profileSettings(DEFAULT_OPT_PROFILE);
  const [profile, setProfile] = useState<OptProfile>(DEFAULT_OPT_PROFILE);
  const [fastMath, setFastMath] = useState(initialOpt.fastMath);
  const [wasmOptLevel, setWasmOptLevel] = useState<WasmOptLevel>(() =>
    readWasmOptLevel()
  );
  const [wasmSimd, setWasmSimd] = useState<boolean>(() => readWasmSimd());
  const handleWasmOptLevelChange = (next: WasmOptLevel) => {
    setWasmOptLevel(next);
    localStorage.setItem(WASM_OPT_LEVEL_KEY, next);
  };
  const handleWasmSimdChange = (next: boolean) => {
    setWasmSimd(next);
    localStorage.setItem(WASM_SIMD_KEY, String(next));
  };
  /** Selecting a profile resets the fast-math toggle to the profile's
   *  default; the dropdown itself stays on the selected profile name
   *  even after the user nudges the switch. That's a useful display —
   *  "I was in `aggressive`, then turned fast-math off." */
  const handleProfileChange = (p: OptProfile) => {
    setProfile(p);
    setFastMath(profileSettings(p).fastMath);
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
    includeRuntime
  );

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
      fastMath,
      simd: wasmSimd,
      optLevel: wasmOptLevel,
    });
  };

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
      <Toolbar
        isRunning={isRunning}
        canRun={canRun}
        runDisabledReason={runDisabledReason}
        onRun={handleRun}
        onStop={exec.stop}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <Splitter direction="vertical" initialSize={220} minSize={140}>
          <FileBrowser
            files={files}
            activeFileId={activeFileId}
            onSelect={setActiveFileId}
            onAdd={() => {
              addFile();
            }}
            onDelete={deleteFile}
            onRename={renameFile}
          />
          <Splitter direction="vertical" initialSize={600} minSize={200}>
            <Splitter direction="horizontal" initialSize={420} minSize={120}>
              <Box sx={{ height: "100%", minHeight: 0 }}>
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
              <OutputPanel
                lines={exec.lines}
                status={exec.status}
                plotRecords={exec.plotRecords}
              />
            </Splitter>
            <CSourcePanel
              c={c}
              error={error}
              otherFiles={otherFiles}
              activeName={active ?? ""}
              includeRuntime={includeRuntime}
              onIncludeRuntimeChange={setIncludeRuntime}
              profile={profile}
              onProfileChange={handleProfileChange}
              fastMath={fastMath}
              onFastMathChange={setFastMath}
              wasmOptLevel={wasmOptLevel}
              onWasmOptLevelChange={handleWasmOptLevelChange}
              wasmSimd={wasmSimd}
              onWasmSimdChange={handleWasmSimdChange}
              isRunning={isRunning}
            />
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

interface ToolbarProps {
  isRunning: boolean;
  canRun: boolean;
  runDisabledReason: string | null;
  onRun: () => void;
  onStop: () => void;
  onOpenSettings: () => void;
}

function Toolbar({
  isRunning,
  canRun,
  runDisabledReason,
  onRun,
  onStop,
  onOpenSettings,
}: ToolbarProps) {
  const runButton = (
    <span>
      <Button
        size="small"
        variant="contained"
        color={isRunning ? "error" : "success"}
        startIcon={isRunning ? <StopIcon /> : <PlayArrowIcon />}
        onClick={isRunning ? onStop : onRun}
        disabled={!isRunning && !canRun}
        sx={{ minWidth: 90 }}
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
        px: 1,
        py: 0.5,
        borderBottom: 1,
        borderColor: "divider",
        bgcolor: "background.paper",
      }}
    >
      {runDisabledReason && !isRunning ? (
        <Tooltip title={runDisabledReason}>{runButton}</Tooltip>
      ) : (
        runButton
      )}
      <Typography variant="caption" sx={{ color: "text.secondary", ml: 0.5 }}>
        WASM
      </Typography>
      <Tooltip title="Execution settings">
        <IconButton
          size="small"
          onClick={onOpenSettings}
          sx={{ color: "text.secondary" }}
        >
          <SettingsIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Box>
  );
}

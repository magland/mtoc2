import { useEffect, useRef, useState } from "react";
import { useMonaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import {
  translateForInternals,
  type InternalsTarget,
  type SourceFile,
  type TranslateError,
} from "../translate.js";
import { offsetToLineCol } from "../parser/sourceLoc.js";

interface UseTranslationResult {
  source: string;
  language: "c" | "javascript" | "plaintext";
  label: string;
  supportsRuntimeToggle: boolean;
  error: TranslateError | null;
}

const MARKER_OWNER = "mtoc";
const DEBOUNCE_MS = 300;

export function useTranslation(
  files: SourceFile[],
  activeName: string,
  editorModel: editor.ITextModel | null,
  target: InternalsTarget,
  includeRuntime: boolean = false,
  enableTempInlining: boolean = true
): UseTranslationResult {
  const [source, setSource] = useState<string>("");
  const [language, setLanguage] = useState<"c" | "javascript" | "plaintext">(
    "c"
  );
  const [label, setLabel] = useState<string>("GENERATED C");
  const [supportsRuntimeToggle, setSupportsRuntimeToggle] = useState(true);
  const [error, setError] = useState<TranslateError | null>(null);
  const monaco = useMonaco();
  const lastModelRef = useRef<editor.ITextModel | null>(null);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      const result = translateForInternals(files, activeName, target, {
        includeRuntime,
        enableTempInlining,
      });
      setLanguage(result.language);
      setLabel(result.label);
      setSupportsRuntimeToggle(result.supportsRuntimeToggle);
      if (result.error) {
        setError(result.error);
        // Keep the previously-good source so the user can still see
        // what the last successful translation produced.
      } else {
        setError(null);
        setSource(result.source ?? "");
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [files, activeName, target, includeRuntime, enableTempInlining]);

  // Drive Monaco markers off of (error, editorModel, monaco).
  useEffect(() => {
    if (!monaco) return;
    // Clear stale markers when the active model changes.
    if (lastModelRef.current && lastModelRef.current !== editorModel) {
      try {
        monaco.editor.setModelMarkers(lastModelRef.current, MARKER_OWNER, []);
      } catch {
        /* model may have been disposed; nothing to clear */
      }
    }
    lastModelRef.current = editorModel;

    if (!editorModel) return;

    if (
      !error ||
      error.startOffset === undefined ||
      error.endOffset === undefined ||
      (error.fileName !== undefined && error.fileName !== activeName)
    ) {
      monaco.editor.setModelMarkers(editorModel, MARKER_OWNER, []);
      return;
    }

    const sourceText = editorModel.getValue();
    const start = offsetToLineCol(sourceText, error.startOffset);
    const end = offsetToLineCol(
      sourceText,
      Math.max(error.endOffset, error.startOffset + 1)
    );
    monaco.editor.setModelMarkers(editorModel, MARKER_OWNER, [
      {
        severity: monaco.MarkerSeverity.Error,
        message: `${error.kind}: ${error.message}`,
        startLineNumber: start.line,
        startColumn: start.column,
        endLineNumber: end.line,
        endColumn: end.column,
      },
    ]);
  }, [monaco, editorModel, error, activeName]);

  return { source, language, label, supportsRuntimeToggle, error };
}

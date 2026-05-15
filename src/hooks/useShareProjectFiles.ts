import {
  useState,
  useCallback,
  useMemo,
  useReducer,
  useEffect,
  useRef,
} from "react";
import type { UseProjectFilesResult } from "./useProjectFiles";
import {
  filesReducer,
  generateUniqueName,
  type WorkspaceFile,
} from "./fileListReducer";
import {
  encodeShareData,
  decodeShareData,
  shareDataToWorkspaceFiles,
} from "../utils/shareUrl";

const textEncoder = new TextEncoder();

export function useShareProjectFiles(): UseProjectFilesResult & {
  urlSizeTooLarge: boolean;
} {
  const [files, dispatch] = useReducer(filesReducer, []);
  const [activeFileId, setActiveFileId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [urlSizeTooLarge, setUrlSizeTooLarge] = useState(false);
  const contentMapRef = useRef(new Map<string, Uint8Array>());
  const updateUrlTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try {
      const hash = window.location.hash.slice(1);
      if (hash) {
        const data = decodeShareData(hash);
        const {
          files: wsFiles,
          contentMap,
          activeFileId: aId,
        } = shareDataToWorkspaceFiles(data);
        contentMapRef.current = contentMap;
        dispatch({ type: "SET_FILES", files: wsFiles });
        setActiveFileId(aId);
      } else {
        const id = crypto.randomUUID();
        const data = textEncoder.encode("% Write your numbl script here\n");
        contentMapRef.current.set(id, data);
        dispatch({ type: "SET_FILES", files: [{ id, name: "main.m" }] });
        setActiveFileId(id);
      }
    } catch (e) {
      console.error("Failed to decode share URL:", e);
      const id = crypto.randomUUID();
      const data = textEncoder.encode("% Failed to load shared project\n");
      contentMapRef.current.set(id, data);
      dispatch({ type: "SET_FILES", files: [{ id, name: "main.m" }] });
      setActiveFileId(id);
    } finally {
      setLoading(false);
    }
  }, []);

  const debouncedUpdateUrl = useCallback(
    (currentFiles: WorkspaceFile[], currentActiveId: string) => {
      if (updateUrlTimerRef.current !== null) {
        clearTimeout(updateUrlTimerRef.current);
      }
      updateUrlTimerRef.current = setTimeout(() => {
        try {
          const encoded = encodeShareData(
            currentFiles,
            contentMapRef.current,
            currentActiveId
          );
          const newUrl = `${window.location.pathname}#${encoded}`;
          setUrlSizeTooLarge(newUrl.length > 64000);
          window.history.replaceState(null, "", newUrl);
        } catch (e) {
          console.error("Failed to update share URL:", e);
        }
      }, 500);
    },
    []
  );

  useEffect(() => {
    if (!loading && files.length > 0) {
      debouncedUpdateUrl(files, activeFileId);
    }
  }, [files, activeFileId, loading, debouncedUpdateUrl]);

  const updateFileContent = useCallback(
    (content: string) => {
      contentMapRef.current.set(activeFileId, textEncoder.encode(content));
      debouncedUpdateUrl(files, activeFileId);
    },
    [activeFileId, files, debouncedUpdateUrl]
  );

  const emptyData = useMemo(() => new Uint8Array(0), []);

  const addFile = useCallback(async (): Promise<string> => {
    const name = generateUniqueName(files);
    const id = crypto.randomUUID();
    contentMapRef.current.set(id, emptyData);
    dispatch({ type: "ADD_FILE", file: { id, name } });
    setActiveFileId(id);
    return id;
  }, [files, emptyData]);

  const handleDeleteFile = useCallback(
    async (fileId: string) => {
      contentMapRef.current.delete(fileId);
      if (activeFileId === fileId) {
        const remaining = files.filter(f => f.id !== fileId);
        setActiveFileId(remaining.length > 0 ? remaining[0].id : "");
      }
      dispatch({ type: "DELETE_FILE", fileId });
    },
    [files, activeFileId]
  );

  const handleRenameFile = useCallback(
    async (fileId: string, newName: string) => {
      if (files.some(f => f.id !== fileId && f.name === newName)) {
        alert("A file with this name already exists");
        return;
      }
      dispatch({ type: "RENAME_FILE", fileId, newName });
    },
    [files]
  );

  const loadFileContent = useCallback(async (fileId: string) => {
    return contentMapRef.current.get(fileId) ?? new Uint8Array(0);
  }, []);

  return {
    files,
    activeFileId,
    loading,
    setActiveFileId,
    updateFileContent,
    addFile,
    deleteFile: handleDeleteFile,
    renameFile: handleRenameFile,
    loadFileContent,
    contentCache: contentMapRef,
    urlSizeTooLarge,
  };
}

import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useReducer,
  useRef,
} from "react";
import {
  getProjectFiles,
  saveFileData,
  createFile,
  deleteFile,
  renameFile as renameFileInDb,
  getFileContent,
  getAllFileContents,
} from "../db/operations";
import {
  filesReducer,
  generateDuplicateName,
  generateUniqueFolderName,
  generateUniqueName,
  type WorkspaceFile,
} from "./fileListReducer";
import { textEncoder, textDecoder } from "../utils/textCodec";

export type { WorkspaceFile };

const SAVE_DEBOUNCE_MS = 500;

export function fileText(data: Uint8Array): string {
  return textDecoder.decode(data);
}

/** Heuristic: any embedded NUL byte → treat as binary. Matches numbl's
 *  test in `isBinaryData`. */
export function isBinaryData(data: Uint8Array): boolean {
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0) return true;
  }
  return false;
}

export interface UseProjectFilesResult {
  files: WorkspaceFile[];
  activeFileId: string;
  loading: boolean;
  setActiveFileId: (id: string) => void;
  updateFileContent: (content: string) => void;
  addFile: (folderPath?: string) => Promise<string>;
  addFolder: (parentPath?: string) => Promise<string>;
  deleteFile: (fileId: string) => void;
  deleteFolder: (folderPath: string) => void;
  renameFile: (fileId: string, newName: string) => void;
  renameFolder: (oldPath: string, newName: string) => void;
  moveFile: (fileId: string, targetFolder: string | null) => void;
  duplicateFile: (fileId: string) => Promise<string>;
  uploadFiles: (
    entries: { path: string; content: string }[],
    targetFolder?: string
  ) => Promise<void>;
  loadFileContent: (fileId: string) => Promise<Uint8Array>;
  loadAllContents: () => Promise<Map<string, Uint8Array>>;
  contentCache: React.RefObject<Map<string, Uint8Array>>;
}

interface PendingSave {
  data: Uint8Array;
  timeoutId: ReturnType<typeof setTimeout>;
}

function getStoredActiveFileId(projectName: string): string {
  try {
    return localStorage.getItem(`mtoc_active_file_${projectName}`) || "";
  } catch {
    return "";
  }
}

function storeActiveFileId(projectName: string, fileId: string): void {
  try {
    localStorage.setItem(`mtoc_active_file_${projectName}`, fileId);
  } catch {
    /* ignore */
  }
}

export function useProjectFiles(projectName: string): UseProjectFilesResult {
  const [files, dispatch] = useReducer(filesReducer, []);
  const [activeFileId, setActiveFileIdRaw] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const contentCacheRef = useRef(new Map<string, Uint8Array>());
  const pendingSavesRef = useRef(new Map<string, PendingSave>());

  const setActiveFileId = useCallback(
    (id: string) => {
      setActiveFileIdRaw(id);
      storeActiveFileId(projectName, id);
    },
    [projectName]
  );

  // Fire one file's pending save synchronously (still async at the IDB layer,
  // but no longer waiting on the debounce timer).
  const flushSave = useCallback((fileId: string) => {
    const pending = pendingSavesRef.current.get(fileId);
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    pendingSavesRef.current.delete(fileId);
    saveFileData(fileId, pending.data).catch(e =>
      console.error("Failed to save file:", e)
    );
  }, []);

  const flushAllSaves = useCallback(() => {
    for (const fileId of Array.from(pendingSavesRef.current.keys())) {
      flushSave(fileId);
    }
  }, [flushSave]);

  // Flush pending writes when the page is hidden/unloaded so a reload within
  // the debounce window doesn't see empty files.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushAllSaves();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flushAllSaves);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flushAllSaves);
      flushAllSaves();
    };
  }, [flushAllSaves]);

  // Per-file debounced save — a write to file B never clobbers file A's
  // pending write, and switching active file is safe.
  const scheduleSave = useCallback((fileId: string, data: Uint8Array) => {
    const existing = pendingSavesRef.current.get(fileId);
    if (existing) clearTimeout(existing.timeoutId);
    const timeoutId = setTimeout(() => {
      pendingSavesRef.current.delete(fileId);
      saveFileData(fileId, data).catch(e =>
        console.error("Failed to save file:", e)
      );
    }, SAVE_DEBOUNCE_MS);
    pendingSavesRef.current.set(fileId, { data, timeoutId });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const projectFiles = await getProjectFiles(projectName);
        if (cancelled) return;
        const workspaceFiles: WorkspaceFile[] = projectFiles.map(pf => ({
          id: pf.id,
          name: pf.path,
        }));
        dispatch({ type: "SET_FILES", files: workspaceFiles });
        setActiveFileIdRaw(prev => {
          if (!prev && workspaceFiles.length > 0) {
            const stored = getStoredActiveFileId(projectName);
            if (stored && workspaceFiles.some(f => f.id === stored))
              return stored;
            return workspaceFiles[0].id;
          }
          return prev;
        });
      } catch (e) {
        console.error("Failed to load files:", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectName]);

  const loadFileContent = useCallback(
    async (fileId: string): Promise<Uint8Array> => {
      const cached = contentCacheRef.current.get(fileId);
      if (cached !== undefined) return cached;
      const data = await getFileContent(fileId);
      // Don't clobber a cache entry that was written by the user (via
      // updateFileContent) while the IDB read was in flight.
      const afterFetch = contentCacheRef.current.get(fileId);
      if (afterFetch !== undefined) return afterFetch;
      contentCacheRef.current.set(fileId, data);
      return data;
    },
    []
  );

  const loadAllContents = useCallback(async (): Promise<
    Map<string, Uint8Array>
  > => {
    const map = await getAllFileContents(projectName);
    for (const [id, data] of map) {
      contentCacheRef.current.set(id, data);
    }
    return map;
  }, [projectName]);

  const updateFileContent = useCallback(
    (content: string) => {
      const data = textEncoder.encode(content);
      contentCacheRef.current.set(activeFileId, data);
      scheduleSave(activeFileId, data);
    },
    [activeFileId, scheduleSave]
  );

  const emptyData = useMemo(() => new Uint8Array(0), []);

  const addFile = useCallback(
    async (folderPath?: string): Promise<string> => {
      const baseName = generateUniqueName(files, folderPath);
      const name = folderPath ? `${folderPath}/${baseName}` : baseName;
      try {
        const file = await createFile(projectName, name, emptyData);
        dispatch({ type: "ADD_FILE", file: { id: file.id, name } });
        contentCacheRef.current.set(file.id, emptyData);
        setActiveFileId(file.id);
        return file.id;
      } catch (e) {
        console.error("Failed to create file:", e);
        return "";
      }
    },
    [files, projectName, setActiveFileId, emptyData]
  );

  const addFolder = useCallback(
    async (parentPath?: string): Promise<string> => {
      const folderName = generateUniqueFolderName(files, parentPath);
      const fullPath = parentPath ? `${parentPath}/${folderName}` : folderName;
      const fileName = generateUniqueName(files, fullPath);
      const name = `${fullPath}/${fileName}`;
      try {
        const file = await createFile(projectName, name, emptyData);
        dispatch({ type: "ADD_FILE", file: { id: file.id, name } });
        contentCacheRef.current.set(file.id, emptyData);
        setActiveFileId(file.id);
        return fullPath;
      } catch (e) {
        console.error("Failed to create folder:", e);
        return "";
      }
    },
    [files, projectName, setActiveFileId, emptyData]
  );

  const handleDeleteFile = useCallback(
    async (fileId: string) => {
      try {
        const pending = pendingSavesRef.current.get(fileId);
        if (pending) {
          clearTimeout(pending.timeoutId);
          pendingSavesRef.current.delete(fileId);
        }
        await deleteFile(fileId);
        contentCacheRef.current.delete(fileId);
        if (activeFileId === fileId) {
          const remaining = files.filter(f => f.id !== fileId);
          setActiveFileId(remaining.length > 0 ? remaining[0].id : "");
        }
        dispatch({ type: "DELETE_FILE", fileId });
      } catch (e) {
        console.error("Failed to delete file:", e);
      }
    },
    [files, activeFileId, setActiveFileId]
  );

  const handleDeleteFolder = useCallback(
    async (folderPath: string) => {
      const toDelete = files.filter(f => f.name.startsWith(folderPath + "/"));
      if (toDelete.length === 0) return;
      if (toDelete.length === files.length) {
        alert("Cannot delete all files");
        return;
      }
      try {
        await Promise.all(toDelete.map(f => deleteFile(f.id)));
        for (const f of toDelete) {
          contentCacheRef.current.delete(f.id);
          const pending = pendingSavesRef.current.get(f.id);
          if (pending) {
            clearTimeout(pending.timeoutId);
            pendingSavesRef.current.delete(f.id);
          }
        }
        const remaining = files.filter(
          f => !f.name.startsWith(folderPath + "/")
        );
        if (toDelete.some(f => f.id === activeFileId) && remaining.length > 0) {
          setActiveFileId(remaining[0].id);
        }
        for (const f of toDelete) {
          dispatch({ type: "DELETE_FILE", fileId: f.id });
        }
      } catch (e) {
        console.error("Failed to delete folder:", e);
      }
    },
    [files, activeFileId, setActiveFileId]
  );

  const handleRenameFile = useCallback(
    async (fileId: string, newName: string) => {
      if (files.some(f => f.id !== fileId && f.name === newName)) {
        alert("A file with this name already exists");
        return;
      }
      try {
        await renameFileInDb(fileId, newName);
        dispatch({ type: "RENAME_FILE", fileId, newName });
      } catch (e) {
        console.error("Failed to rename file:", e);
      }
    },
    [files]
  );

  const handleRenameFolder = useCallback(
    async (oldPath: string, newName: string) => {
      const parts = oldPath.split("/");
      parts[parts.length - 1] = newName;
      const newPath = parts.join("/");
      const toUpdate = files.filter(f => f.name.startsWith(oldPath + "/"));
      try {
        await Promise.all(
          toUpdate.map(f => {
            const newFilePath = newPath + f.name.slice(oldPath.length);
            return renameFileInDb(f.id, newFilePath);
          })
        );
        dispatch({ type: "RENAME_FOLDER", oldPath, newPath });
      } catch (e) {
        console.error("Failed to rename folder:", e);
      }
    },
    [files]
  );

  const handleMoveFile = useCallback(
    async (fileId: string, targetFolder: string | null) => {
      const file = files.find(f => f.id === fileId);
      if (!file) return;
      const parts = file.name.split("/");
      const baseName = parts[parts.length - 1];
      const newName = targetFolder ? `${targetFolder}/${baseName}` : baseName;
      if (newName === file.name) return;
      if (files.some(f => f.id !== fileId && f.name === newName)) {
        alert("A file with this name already exists in the target location");
        return;
      }
      try {
        await renameFileInDb(fileId, newName);
        dispatch({ type: "RENAME_FILE", fileId, newName });
      } catch (e) {
        console.error("Failed to move file:", e);
      }
    },
    [files]
  );

  const handleDuplicateFile = useCallback(
    async (fileId: string): Promise<string> => {
      const source = files.find(f => f.id === fileId);
      if (!source) return "";
      const newName = generateDuplicateName(files, source.name);
      const sourceData =
        contentCacheRef.current.get(fileId) ?? (await getFileContent(fileId));
      const dataCopy = new Uint8Array(sourceData);
      try {
        const file = await createFile(projectName, newName, dataCopy);
        dispatch({ type: "ADD_FILE", file: { id: file.id, name: newName } });
        contentCacheRef.current.set(file.id, dataCopy);
        setActiveFileId(file.id);
        return file.id;
      } catch (e) {
        console.error("Failed to duplicate file:", e);
        return "";
      }
    },
    [files, projectName, setActiveFileId]
  );

  const handleUploadFiles = useCallback(
    async (
      entries: { path: string; content: string }[],
      targetFolder?: string
    ) => {
      if (entries.length === 0) return;
      const toUpload = entries.map(e => ({
        ...e,
        fullPath: targetFolder ? `${targetFolder}/${e.path}` : e.path,
      }));
      const existingByPath = new Map(files.map(f => [f.name, f]));
      const duplicates = toUpload.filter(e => existingByPath.has(e.fullPath));
      const newEntries = toUpload.filter(e => !existingByPath.has(e.fullPath));
      if (duplicates.length > 0) {
        const names = duplicates.map(d => d.fullPath).join("\n");
        const ok = window.confirm(
          `The following ${duplicates.length} file(s) already exist and will be overwritten:\n\n${names}\n\n` +
            (newEntries.length > 0
              ? `${newEntries.length} new file(s) will also be added.\n\n`
              : "") +
            "Click OK to proceed, or Cancel to abort the upload."
        );
        if (!ok) return;
      }
      try {
        let firstNewId = "";
        for (const entry of duplicates) {
          const existing = existingByPath.get(entry.fullPath)!;
          const data = textEncoder.encode(entry.content);
          await saveFileData(existing.id, data);
          contentCacheRef.current.set(existing.id, data);
          if (!firstNewId) firstNewId = existing.id;
        }
        for (const entry of newEntries) {
          const data = textEncoder.encode(entry.content);
          const file = await createFile(projectName, entry.fullPath, data);
          dispatch({
            type: "ADD_FILE",
            file: { id: file.id, name: entry.fullPath },
          });
          contentCacheRef.current.set(file.id, data);
          if (!firstNewId) firstNewId = file.id;
        }
        if (firstNewId) setActiveFileId(firstNewId);
      } catch (e) {
        console.error("Failed to upload files:", e);
      }
    },
    [files, projectName, setActiveFileId]
  );

  return {
    files,
    activeFileId,
    loading,
    setActiveFileId,
    updateFileContent,
    addFile,
    addFolder,
    deleteFile: handleDeleteFile,
    deleteFolder: handleDeleteFolder,
    renameFile: handleRenameFile,
    renameFolder: handleRenameFolder,
    moveFile: handleMoveFile,
    duplicateFile: handleDuplicateFile,
    uploadFiles: handleUploadFiles,
    loadFileContent,
    loadAllContents,
    contentCache: contentCacheRef,
  };
}

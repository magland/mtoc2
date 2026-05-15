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
  generateDuplicateName,
  generateUniqueFolderName,
  generateUniqueName,
  type WorkspaceFile,
} from "./fileListReducer";
import {
  encodeShareData,
  decodeShareData,
  shareDataToWorkspaceFiles,
} from "../utils/shareUrl";
import { textEncoder } from "../utils/textCodec";

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

  const addFile = useCallback(
    async (folderPath?: string): Promise<string> => {
      const baseName = generateUniqueName(files, folderPath);
      const name = folderPath ? `${folderPath}/${baseName}` : baseName;
      const id = crypto.randomUUID();
      contentMapRef.current.set(id, emptyData);
      dispatch({ type: "ADD_FILE", file: { id, name } });
      setActiveFileId(id);
      return id;
    },
    [files, emptyData]
  );

  const addFolder = useCallback(
    async (parentPath?: string): Promise<string> => {
      const folderName = generateUniqueFolderName(files, parentPath);
      const fullPath = parentPath ? `${parentPath}/${folderName}` : folderName;
      const fileName = generateUniqueName(files, fullPath);
      const name = `${fullPath}/${fileName}`;
      const id = crypto.randomUUID();
      contentMapRef.current.set(id, emptyData);
      dispatch({ type: "ADD_FILE", file: { id, name } });
      setActiveFileId(id);
      return fullPath;
    },
    [files, emptyData]
  );

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

  const handleDeleteFolder = useCallback(
    async (folderPath: string) => {
      const toDelete = files.filter(f => f.name.startsWith(folderPath + "/"));
      if (toDelete.length === 0) return;
      if (toDelete.length === files.length) {
        alert("Cannot delete all files");
        return;
      }
      for (const f of toDelete) {
        contentMapRef.current.delete(f.id);
      }
      const remaining = files.filter(f => !f.name.startsWith(folderPath + "/"));
      if (toDelete.some(f => f.id === activeFileId) && remaining.length > 0) {
        setActiveFileId(remaining[0].id);
      }
      for (const f of toDelete) {
        dispatch({ type: "DELETE_FILE", fileId: f.id });
      }
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

  const handleRenameFolder = useCallback(
    async (oldPath: string, newName: string) => {
      const parts = oldPath.split("/");
      parts[parts.length - 1] = newName;
      const newPath = parts.join("/");
      dispatch({ type: "RENAME_FOLDER", oldPath, newPath });
    },
    []
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
      dispatch({ type: "RENAME_FILE", fileId, newName });
    },
    [files]
  );

  const handleDuplicateFile = useCallback(
    async (fileId: string): Promise<string> => {
      const source = files.find(f => f.id === fileId);
      if (!source) return "";
      const newName = generateDuplicateName(files, source.name);
      const sourceData = contentMapRef.current.get(fileId) ?? new Uint8Array(0);
      const dataCopy = new Uint8Array(sourceData);
      const id = crypto.randomUUID();
      contentMapRef.current.set(id, dataCopy);
      dispatch({ type: "ADD_FILE", file: { id, name: newName } });
      setActiveFileId(id);
      return id;
    },
    [files]
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
      let firstNewId = "";
      for (const entry of duplicates) {
        const existing = existingByPath.get(entry.fullPath)!;
        const data = textEncoder.encode(entry.content);
        contentMapRef.current.set(existing.id, data);
        if (!firstNewId) firstNewId = existing.id;
      }
      for (const entry of newEntries) {
        const data = textEncoder.encode(entry.content);
        const id = crypto.randomUUID();
        contentMapRef.current.set(id, data);
        dispatch({ type: "ADD_FILE", file: { id, name: entry.fullPath } });
        if (!firstNewId) firstNewId = id;
      }
      if (firstNewId) setActiveFileId(firstNewId);
    },
    [files]
  );

  const loadFileContent = useCallback(async (fileId: string) => {
    return contentMapRef.current.get(fileId) ?? new Uint8Array(0);
  }, []);

  const loadAllContents = useCallback(async () => {
    return new Map(contentMapRef.current);
  }, []);

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
    contentCache: contentMapRef,
    urlSizeTooLarge,
  };
}

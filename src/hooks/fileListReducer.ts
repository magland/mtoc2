/** Shared file-list state primitives used by both `useProjectFiles`
 *  (IndexedDB-backed) and `useShareProjectFiles` (URL-hash-backed).
 *  The two hooks have different persistence layers but identical
 *  in-memory file-list state, so the reducer and the new-file naming
 *  helper live here. */

/** Metadata-only file reference (no content loaded). The `name` may
 *  contain `/` separators to encode folder paths (e.g. `src/utils/x.m`).
 *  Folders are implicit — they exist iff some file's name has them as
 *  a prefix. */
export interface WorkspaceFile {
  id: string;
  name: string;
}

export type FilesAction =
  | { type: "SET_FILES"; files: WorkspaceFile[] }
  | { type: "ADD_FILE"; file: WorkspaceFile }
  | { type: "DELETE_FILE"; fileId: string }
  | { type: "RENAME_FILE"; fileId: string; newName: string }
  | { type: "RENAME_FOLDER"; oldPath: string; newPath: string };

export function filesReducer(
  state: WorkspaceFile[],
  action: FilesAction
): WorkspaceFile[] {
  switch (action.type) {
    case "SET_FILES":
      return action.files;
    case "ADD_FILE":
      return [...state, action.file];
    case "DELETE_FILE":
      return state.filter(f => f.id !== action.fileId);
    case "RENAME_FILE":
      return state.map(f =>
        f.id === action.fileId ? { ...f, name: action.newName } : f
      );
    case "RENAME_FOLDER":
      return state.map(f =>
        f.name.startsWith(action.oldPath + "/")
          ? { ...f, name: action.newPath + f.name.slice(action.oldPath.length) }
          : f
      );
    default:
      return state;
  }
}

/** Pick the next `untitled<N>.m` name not already taken in `folderPath`. */
export function generateUniqueName(
  files: WorkspaceFile[],
  folderPath?: string
): string {
  const existing = new Set(files.map(f => f.name));
  for (let i = 1; ; i++) {
    const baseName = `untitled${i === 1 ? "" : i}.m`;
    const fullName = folderPath ? `${folderPath}/${baseName}` : baseName;
    if (!existing.has(fullName)) return baseName;
  }
}

/** `foo.m` → `foo_copy.m`; if taken, `foo_copy2.m`, etc. */
export function generateDuplicateName(
  files: WorkspaceFile[],
  sourcePath: string
): string {
  const slash = sourcePath.lastIndexOf("/");
  const folder = slash >= 0 ? sourcePath.slice(0, slash) : "";
  const base = slash >= 0 ? sourcePath.slice(slash + 1) : sourcePath;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  const existing = new Set(files.map(f => f.name));
  for (let i = 1; ; i++) {
    const suffix = i === 1 ? "_copy" : `_copy${i}`;
    const candidate = `${stem}${suffix}${ext}`;
    const fullName = folder ? `${folder}/${candidate}` : candidate;
    if (!existing.has(fullName)) return fullName;
  }
}

/** Pick the next `folder<N>` name not already used as a top-level segment
 *  inside `parentPath` (or at root if undefined). */
export function generateUniqueFolderName(
  files: WorkspaceFile[],
  parentPath?: string
): string {
  const existing = new Set<string>();
  for (const f of files) {
    if (parentPath) {
      if (f.name.startsWith(parentPath + "/")) {
        const rel = f.name.slice(parentPath.length + 1).split("/");
        if (rel.length > 1) existing.add(rel[0]);
      }
    } else {
      const parts = f.name.split("/");
      if (parts.length > 1) existing.add(parts[0]);
    }
  }
  for (let i = 1; ; i++) {
    const name = `folder${i === 1 ? "" : i}`;
    if (!existing.has(name)) return name;
  }
}

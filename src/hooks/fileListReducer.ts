/** Shared file-list state primitives used by both `useProjectFiles`
 *  (IndexedDB-backed) and `useShareProjectFiles` (URL-hash-backed).
 *  The two hooks have different persistence layers but identical
 *  in-memory file-list state, so the reducer and the new-file naming
 *  helper live here. */

/** Metadata-only file reference (no content loaded). */
export interface WorkspaceFile {
  id: string;
  name: string;
}

export type FilesAction =
  | { type: "SET_FILES"; files: WorkspaceFile[] }
  | { type: "ADD_FILE"; file: WorkspaceFile }
  | { type: "DELETE_FILE"; fileId: string }
  | { type: "RENAME_FILE"; fileId: string; newName: string };

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
    default:
      return state;
  }
}

/** Pick the next `untitled<N>.m` name not already taken by `files`. */
export function generateUniqueName(files: WorkspaceFile[]): string {
  const existing = new Set(files.map(f => f.name));
  for (let i = 1; ; i++) {
    const name = `untitled${i === 1 ? "" : i}.m`;
    if (!existing.has(name)) return name;
  }
}

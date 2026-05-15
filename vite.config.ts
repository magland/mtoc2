import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  optimizeDeps: { include: ["monaco-editor"] },
  // We import React components directly from `../numbl/src/...`. Without
  // dedupe, Vite resolves `react`/`react-dom` (and the JSX runtime) to
  // numbl's `node_modules/react`, giving us two React copies and the
  // classic "Invalid hook call" / "Cannot read properties of null
  // (reading 'useContext')" failure. MUI/emotion are equally context-
  // sensitive and need the same treatment so MUI's internal
  // useContext lands in the same provider tree the app rendered.
  resolve: {
    dedupe: [
      "monaco-editor",
      "react",
      "react-dom",
      "react/jsx-runtime",
      "@mui/material",
      "@mui/system",
      "@emotion/react",
      "@emotion/styled",
    ],
  },
  test: {
    // Skip checked-out git worktrees (which live under `.claude/worktrees/`
    // and carry their own `tests/` dirs). Without this, vitest's auto-
    // discovery doubles every test up by also running it from the worktree
    // copy.
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});

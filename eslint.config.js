import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";

export default defineConfig([
  globalIgnores([
    "dist",
    "node_modules",
    "coverage",
    "tmp",
    "test_scripts",
    "test_scripts_mtoc2_only",
    ".claude",
    "src/codegen/runtime/snippets.gen.ts",
    "src/builtins/runtime/snippets.gen.ts",
  ]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      eslintConfigPrettier,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
  },
  // Runtime JS snippets: paired with `.h` C helpers, inlined into
  // snippets.gen.ts at build time. The interpreter and js-aot import
  // them directly, so a typo-driven undefined reference is a real bug
  // that won't surface until runtime — without this block, eslint
  // would skip them entirely. Free-variable hooks (`$write` etc.)
  // resolve through `globalThis` at call time per the snippet contract;
  // declare them as readonly so `no-undef` lets them through.
  {
    files: ["src/builtins/runtime/**/*.js"],
    extends: [js.configs.recommended, eslintConfigPrettier],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.builtin,
        // Modern Node/browser globals used by individual snippets.
        performance: "readonly",
        // Free-variable hooks resolved through globalThis at call time.
        $write: "readonly",
        $disp: "readonly",
        $error: "readonly",
        $plot: "readonly",
        $tic: "readonly",
        $toc: "readonly",
      },
    },
    rules: {
      "no-unused-vars": "off",
    },
  },
  {
    files: [
      "src/components/**/*.{ts,tsx}",
      "src/hooks/**/*.{ts,tsx}",
      "src/pages/**/*.{ts,tsx}",
      "src/App.tsx",
      "src/main.tsx",
    ],
    extends: [reactHooks.configs.flat.recommended],
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
    },
  },
]);

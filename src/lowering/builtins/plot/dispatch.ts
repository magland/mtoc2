/**
 * Plot dispatch — every plotting builtin (`plot`, `surf`, `imagesc`,
 * `bar`, `figure`, `hold`, `xlabel`, …) shares a single lowering.
 * Numbl handles plotting by accumulating an in-memory instruction
 * stream that a separate viewer renders; mtoc2 mirrors that on the
 * wire by emitting one line of JSON per call, prefixed with the
 * `\x1emtoc2:plot\t` sentinel (see `plot_dispatch.h` for the wire
 * shape and `scripts/run_test_scripts.ts` for the cross-runner drop).
 *
 * Per-name C code is zero — every name reuses
 * `mtoc2_plot_dispatch` with the name string baked in as the
 * leading arg. Per-name TypeScript code is one entry in
 * `PLOT_BUILTIN_NAMES`.
 *
 * Type rules:
 *   - Variadic arity (0..64), matching numbl's `varargin` stubs.
 *   - Args must be scalar real numeric / text / real multi-element
 *     tensor — same set fprintf accepts (complex / struct / class /
 *     handle / Void / Unknown rejected at lowering).
 *   - Result is `Void` — these builtins are statement-only in v1.
 *     Numbl's value-returning variants (`h = gcf`, `lim = xlim`,
 *     etc.) are not supported here; assign forms surface a clean
 *     "cannot consume Void as a value" error. Users that need a
 *     return value should fall back to numbl for that program.
 *
 * MATLAB command syntax (`hold on`, `figure 1`) isn't supported —
 * mtoc2's parser routes those as bare identifiers, which has no
 * generic "treat next token as char arg" support. Use the
 * function-call form: `hold('on')`, `figure(1)`.
 */

import { VOID } from "../../types.js";
import type { Builtin } from "../registry.js";
import {
  emitFormatSlot,
  emitFormatSlotArray,
  validateFormatArgs,
} from "../io/_format_args.js";

/** Source-level names that route through `mtoc2_plot_dispatch`. Two
 *  buckets, both treated identically — split only for documentation.
 *
 *  Drawing primitives (numbl pushes a typed instruction): `plot`,
 *  `surf`, `imagesc`, `bar`, `errorbar`, `semilogx`, `semilogy`,
 *  `loglog`, `contour`, `quiver`, `stem`, `stairs`, `fill`,
 *  `scatter`, `mesh`, `histogram`, `polar`, `polarplot`, `area`,
 *  `pie`, `line`, `patch`, `plot3`, `scatter3`, `bar3`, `barh`,
 *  `stem3`, `quiver3`, `contour3`, `contourf`, `fill3`.
 *
 *  Decoration / state (numbl mostly stubs to no-op): `figure`,
 *  `hold`, `grid`, `close`, `title`, `xlabel`, `ylabel`, `zlabel`,
 *  `sgtitle`, `legend`, `colorbar`, `colormap`, `shading`,
 *  `subplot`, `tiledlayout`, `nexttile`, `axis`, `xlim`, `ylim`,
 *  `zlim`, `clf`, `cla`, `drawnow`, `pause`, `axes`, `view`,
 *  `set`, `gcf`, `gca`, `groot`, `newplot`, `shg`, `light`,
 *  `camlight`, `daspect`, `pbaspect`. */
const PLOT_BUILTIN_NAMES: ReadonlyArray<string> = [
  // Drawing primitives.
  "plot",
  "plot3",
  "scatter",
  "scatter3",
  "surf",
  "mesh",
  "imagesc",
  "image",
  "contour",
  "contourf",
  "contour3",
  "bar",
  "bar3",
  "barh",
  "errorbar",
  "quiver",
  "quiver3",
  "semilogx",
  "semilogy",
  "loglog",
  "stem",
  "stem3",
  "stairs",
  "fill",
  "fill3",
  "area",
  "histogram",
  "polar",
  "polarplot",
  "pie",
  "line",
  "patch",
  // Decoration / state.
  "figure",
  "hold",
  "grid",
  "close",
  "title",
  "xlabel",
  "ylabel",
  "zlabel",
  "sgtitle",
  "legend",
  "colorbar",
  "colormap",
  "shading",
  "subplot",
  "tiledlayout",
  "nexttile",
  "axis",
  "xlim",
  "ylim",
  "zlim",
  "clf",
  "cla",
  "drawnow",
  "pause",
  "axes",
  "view",
  "set",
  "gcf",
  "gca",
  "groot",
  "newplot",
  "shg",
  "light",
  "camlight",
  "daspect",
  "pbaspect",
];

/** JSON-escape a builtin name for inclusion as the first arg to
 *  `mtoc2_plot_dispatch`. Plot names are ASCII identifiers, but the
 *  escape stays defensive — a future plot name like `print` (where
 *  a backslash would be invalid C anyway) doesn't surprise us. */
function escapeCStringLiteral(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ch === "\\" || ch === '"') {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  return out;
}

function makePlotBuiltin(name: string): Builtin {
  const cName = escapeCStringLiteral(name);
  return {
    name,
    arity: { min: 0, max: 64 },
    transfer(argTypes, span) {
      validateFormatArgs(name, argTypes, 0, span);
      return VOID;
    },
    codegenC(argsC, argTypes) {
      const slots: string[] = [];
      for (let i = 0; i < argTypes.length; i++) {
        slots.push(emitFormatSlot(name, argsC[i], argTypes[i], i));
      }
      return `mtoc2_plot_dispatch("${cName}", ${slots.length}, ${emitFormatSlotArray(slots)})`;
    },
    runtimeDeps: ["mtoc2_plot_dispatch"],
  };
}

export const plotBuiltins: ReadonlyArray<Builtin> =
  PLOT_BUILTIN_NAMES.map(makePlotBuiltin);

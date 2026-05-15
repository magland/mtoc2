import { useEffect, useReducer, useRef, useState } from "react";
import { Box, Typography } from "@mui/material";
import {
  figuresReducer,
  initialFiguresState,
} from "../../../numbl/src/graphics/figuresReducer";
import { FigureView } from "../../../numbl/src/graphics/FigureView";
import type { PlotInstruction } from "../../../numbl/src/graphics/types";
import { applyPlotRecord, newPlotDispatchState } from "../utils/plotAdapter";
import type { PlotRecord } from "../utils/wasmExecution";

interface FiguresPanelProps {
  /** Plot-dispatch records streamed in execution order from the wasm
   *  run. The panel processes each new record into one or more numbl
   *  `PlotInstruction`s via `applyPlotRecord` and feeds them through
   *  numbl's `figuresReducer` — same data flow numbl's own plot
   *  viewer uses. */
  plotRecords: PlotRecord[];
}

/** Mounts numbl's `FigureView` directly so plot rendering stays a
 *  single-source-of-truth concern. We re-use:
 *
 *    - `figuresReducer` (state machine that owns figures + axes)
 *    - `FigureView` (Canvas renderer)
 *    - `dispatchPlotBuiltin` (name → PlotInstruction[] mapping; via
 *      `applyPlotRecord`)
 *
 *  Live updates: every time the parent's `plotRecords` array grows,
 *  the effect processes the tail (records since the last render) and
 *  dispatches the resulting instructions into the reducer. When the
 *  array shrinks (a fresh run cleared it), we reset both the reducer
 *  state and the auxiliary `PlotDispatchState` so a stale `hold on`
 *  or tiled layout from the previous run doesn't leak into the next.
 */
export function FiguresPanel({ plotRecords }: FiguresPanelProps) {
  const [figures, dispatch] = useReducer(figuresReducer, initialFiguresState);
  const [activeFigure, setActiveFigure] = useState(1);
  const processedCountRef = useRef(0);
  const dispatchStateRef = useRef(newPlotDispatchState());

  useEffect(() => {
    // Run reset: parent emptied `plotRecords` (always happens at the
    // start of a new run). Drop reducer state + dispatch state.
    if (plotRecords.length < processedCountRef.current) {
      processedCountRef.current = 0;
      dispatchStateRef.current = newPlotDispatchState();
      dispatch({ type: "close_all" });
      setActiveFigure(1);
    }
    // Process newly-arrived records (tail since the last invocation).
    for (let i = processedCountRef.current; i < plotRecords.length; i++) {
      const record = plotRecords[i];
      const buffer: PlotInstruction[] = [];
      applyPlotRecord(record, buffer, dispatchStateRef.current);
      for (const instr of buffer) {
        dispatch(instr);
        // Track figure-handle changes so the right tab stays active
        // as the user's script switches figures with `figure(2)`.
        if (instr.type === "set_figure_handle") {
          setActiveFigure(instr.handle);
        } else if (instr.type === "close_all") {
          setActiveFigure(1);
        }
      }
    }
    processedCountRef.current = plotRecords.length;
  }, [plotRecords]);

  const handles = Object.keys(figures.figs)
    .map(Number)
    .sort((a, b) => a - b);
  // If the active figure was closed, fall back to the highest existing
  // handle — same UX as numbl's plot-viewer.
  const effectiveActive =
    figures.figs[activeFigure] !== undefined
      ? activeFigure
      : handles.length > 0
        ? handles[handles.length - 1]
        : activeFigure;
  const currentFig = figures.figs[effectiveActive];

  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        bgcolor: "background.paper",
        borderTop: 1,
        borderColor: "divider",
      }}
    >
      <Box
        sx={{
          px: 1.5,
          py: 0.5,
          borderBottom: 1,
          borderColor: "divider",
          display: "flex",
          alignItems: "center",
          gap: 1,
          minHeight: 32,
        }}
      >
        <Typography
          variant="caption"
          sx={{ fontWeight: 600, color: "text.secondary" }}
        >
          FIGURES
        </Typography>
        {handles.length > 1 && (
          <Box sx={{ display: "flex", gap: 0.5, ml: 1 }}>
            {handles.map(h => (
              <Box
                key={h}
                onClick={() => setActiveFigure(h)}
                sx={{
                  px: 1,
                  py: 0.25,
                  border: 1,
                  borderColor: "divider",
                  borderRadius: 1,
                  fontSize: 12,
                  cursor: "pointer",
                  bgcolor:
                    h === effectiveActive ? "action.selected" : "transparent",
                  fontWeight: h === effectiveActive ? 600 : 400,
                  "&:hover": { bgcolor: "action.hover" },
                }}
              >
                Figure {h}
              </Box>
            ))}
          </Box>
        )}
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, position: "relative" }}>
        {currentFig ? (
          <Box sx={{ position: "absolute", inset: 0 }}>
            <FigureView figure={currentFig} />
          </Box>
        ) : (
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              color: "text.disabled",
              fontStyle: "italic",
              fontSize: 13,
            }}
          >
            {plotRecords.length === 0
              ? "(no figures — run a script with plot/surf/imagesc to render here)"
              : "(processing…)"}
          </Box>
        )}
      </Box>
    </Box>
  );
}

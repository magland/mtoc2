import { useEffect, useState } from "react";
import { Box, Tab, Tabs } from "@mui/material";
import type { ConsoleLine, RunStatus } from "../hooks/useWasmExecution";
import type { PlotRecord } from "../utils/wasmExecution";
import { ConsolePanel } from "./ConsolePanel";
import { FiguresPanel } from "./FiguresPanel";

interface OutputPanelProps {
  lines: ConsoleLine[];
  status: RunStatus;
  plotRecords: PlotRecord[];
}

type TabId = "console" | "figures";

/** Bottom-right panel of the IDE: tabbed switch between the text
 *  console and the figures viewer. The Figures tab auto-activates the
 *  first time a plot record arrives during a run — keeps the existing
 *  "console is primary" UX while making plots discoverable. */
export function OutputPanel({ lines, status, plotRecords }: OutputPanelProps) {
  const [tab, setTab] = useState<TabId>("console");
  // One-shot auto-switch to Figures on the first record of a run. The
  // `didAutoSwitch` flag rearms when a fresh run empties plotRecords,
  // so each script run gets its own auto-switch — but the user can
  // still flip back to Console manually mid-run without us yanking
  // them back.
  const [didAutoSwitch, setDidAutoSwitch] = useState(false);
  useEffect(() => {
    if (plotRecords.length === 0) {
      if (didAutoSwitch) setDidAutoSwitch(false);
    } else if (!didAutoSwitch) {
      setDidAutoSwitch(true);
      setTab("figures");
    }
  }, [plotRecords.length, didAutoSwitch]);

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
      <Tabs
        value={tab}
        onChange={(_, v: TabId) => setTab(v)}
        variant="standard"
        sx={{
          minHeight: 32,
          borderBottom: 1,
          borderColor: "divider",
          "& .MuiTab-root": {
            minHeight: 32,
            py: 0,
            px: 1.5,
            fontSize: 12,
            textTransform: "none",
            fontWeight: 600,
          },
        }}
      >
        <Tab value="console" label="Console" />
        <Tab
          value="figures"
          label={
            plotRecords.length > 0
              ? `Figures (${plotRecords.length})`
              : "Figures"
          }
        />
      </Tabs>
      <Box sx={{ flex: 1, minHeight: 0, display: "flex" }}>
        {/* Both panels mounted unconditionally so figures keep updating
            even while the Console tab is foregrounded — the user can
            switch back and see the figure already drawn. */}
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            display: tab === "console" ? "flex" : "none",
            flexDirection: "column",
          }}
        >
          <ConsolePanel lines={lines} status={status} />
        </Box>
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            display: tab === "figures" ? "flex" : "none",
            flexDirection: "column",
          }}
        >
          <FiguresPanel plotRecords={plotRecords} />
        </Box>
      </Box>
    </Box>
  );
}

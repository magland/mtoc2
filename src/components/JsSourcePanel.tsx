import { Box, Alert, Typography } from "@mui/material";
import Editor from "@monaco-editor/react";

interface JsSourcePanelProps {
  /** The JS source produced by `translateCToJs(c)`. Empty string while
   *  there's nothing to show (no C yet, or translation failed). */
  js: string;
  /** Set when the C → JS step itself threw. The C view shows the
   *  upstream numbl → C translate error; this surfaces failures that
   *  happened *after* a clean C translation. */
  error: string | null;
}

export function JsSourcePanel({ js, error }: JsSourcePanelProps) {
  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        bgcolor: "background.paper",
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
          justifyContent: "space-between",
        }}
      >
        <Typography
          variant="caption"
          sx={{ fontWeight: 600, color: "text.secondary" }}
        >
          GENERATED JS
        </Typography>
      </Box>
      {error && (
        <Alert
          severity="error"
          variant="outlined"
          sx={{
            borderRadius: 0,
            whiteSpace: "pre-wrap",
            fontFamily: "monospace",
            fontSize: 12,
            "& .MuiAlert-message": { py: 0.5 },
          }}
        >
          {error}
        </Alert>
      )}
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <Editor
          height="100%"
          language="javascript"
          value={js}
          options={{
            readOnly: true,
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: "on",
            wordWrap: "on",
            scrollBeyondLastLine: false,
          }}
        />
      </Box>
    </Box>
  );
}

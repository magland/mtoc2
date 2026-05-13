import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import {
  DEFAULT_WASM_SERVICE_URL,
  checkWasmServiceHealth,
  getWasmServiceUrl,
  setWasmServiceUrl,
} from "../utils/wasmExecution";

interface ExecutionSettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

type WasmProbe =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ok"; emcc: string | null }
  | { state: "fail"; message: string };

export function ExecutionSettingsDialog({
  open,
  onClose,
}: ExecutionSettingsDialogProps) {
  const [wasmUrl, setWasmUrl] = useState(getWasmServiceUrl());
  const [wasmProbe, setWasmProbe] = useState<WasmProbe>({ state: "idle" });

  useEffect(() => {
    if (open) {
      setWasmUrl(getWasmServiceUrl());
      setWasmProbe({ state: "idle" });
    }
  }, [open]);

  const handleWasmCheck = async () => {
    setWasmProbe({ state: "checking" });
    const health = await checkWasmServiceHealth(wasmUrl);
    if (health && health.ok) {
      setWasmProbe({ state: "ok", emcc: health.emcc });
    } else {
      setWasmProbe({
        state: "fail",
        message:
          "No response from WASM service. The default service is run by the project; you can also point at your own.",
      });
    }
  };

  const handleSave = () => {
    setWasmServiceUrl(wasmUrl);
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Execution settings</DialogTitle>
      <DialogContent>
        <Box>
          <Typography variant="subtitle2" gutterBottom>
            WASM compile service
          </Typography>
          <DialogContentText sx={{ mb: 2 }}>
            Programs are translated in your browser, sent to a public
            C-to-WebAssembly compile service, and the returned module is
            instantiated in-process. No local server needed. Point at your own
            deployment if you'd rather not use the default.
          </DialogContentText>

          <Stack spacing={2}>
            <TextField
              label="WASM compile service URL"
              value={wasmUrl}
              onChange={e => setWasmUrl(e.target.value)}
              placeholder={DEFAULT_WASM_SERVICE_URL}
              fullWidth
              size="small"
            />

            <Stack direction="row" spacing={1} alignItems="center">
              <Button
                variant="outlined"
                size="small"
                onClick={handleWasmCheck}
                disabled={wasmProbe.state === "checking"}
              >
                {wasmProbe.state === "checking"
                  ? "Checking…"
                  : "Check connection"}
              </Button>
            </Stack>

            {wasmProbe.state === "ok" && (
              <Typography variant="body2" color="success.main">
                Reachable.{" "}
                {wasmProbe.emcc ? (
                  <>
                    Compiler: <code>{wasmProbe.emcc}</code>
                  </>
                ) : (
                  "Compiler version unavailable."
                )}
              </Typography>
            )}
            {wasmProbe.state === "fail" && (
              <Typography variant="body2" color="warning.main">
                {wasmProbe.message}
              </Typography>
            )}
          </Stack>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={handleSave}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

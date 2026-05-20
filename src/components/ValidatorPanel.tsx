import FactCheckIcon from "@mui/icons-material/FactCheck";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useMemo, useState } from "react";

import { validateTopologyYaml } from "../validation";
import type { HardwareSchema } from "../types";

interface ValidatorPanelProps {
  generatedYaml: string;
  hardwareSchema: HardwareSchema;
}

export function ValidatorPanel({ generatedYaml, hardwareSchema }: ValidatorPanelProps) {
  const [yamlText, setYamlText] = useState(generatedYaml);
  const report = useMemo(() => validateTopologyYaml(yamlText, hardwareSchema), [yamlText, hardwareSchema]);

  const counts = {
    yaml: report.issues.filter((issue) => issue.source === "yaml").length,
    schema: report.issues.filter((issue) => issue.source === "schema").length,
    hardware: report.issues.filter((issue) => issue.source === "hardware").length
  };

  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, height: "100%" }}>
      <Stack spacing={1.5} sx={{ height: "100%" }}>
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1 }}>
          <Box>
            <Typography variant="h6">Validate YAML</Typography>
            <Typography variant="body2" color="text.secondary">
              Paste a topology and check schema plus hardware compatibility.
            </Typography>
          </Box>
          <Button size="small" startIcon={<FactCheckIcon />} onClick={() => setYamlText(generatedYaml)}>
            Use generated
          </Button>
        </Box>

        <Alert severity={report.valid ? "success" : "error"}>
          {report.valid ? "Pasted topology validates." : `${report.issues.length} validation issue${report.issues.length === 1 ? "" : "s"}.`}
        </Alert>

        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Chip size="small" color={counts.yaml ? "error" : "default"} label={`${counts.yaml} YAML`} />
          <Chip size="small" color={counts.schema ? "error" : "default"} label={`${counts.schema} schema`} />
          <Chip size="small" color={counts.hardware ? "error" : "default"} label={`${counts.hardware} hardware`} />
        </Stack>

        <TextField
          value={yamlText}
          onChange={(event) => setYamlText(event.target.value)}
          multiline
          fullWidth
          minRows={11}
          maxRows={16}
          placeholder="Paste clab.yml"
          slotProps={{
            input: {
              sx: {
                alignItems: "flex-start",
                fontFamily: "var(--mono-font)",
                fontSize: 13,
                lineHeight: 1.45
              }
            }
          }}
        />

        <Box sx={{ flex: 1, minHeight: 120, overflow: "auto", pr: 0.5 }}>
          {report.issues.length ? (
            <Stack spacing={1}>
              {report.issues.slice(0, 18).map((issue, index) => (
                <Alert key={index} severity={issue.source === "yaml" ? "warning" : "error"} variant="outlined">
                  <Typography variant="caption" sx={{ textTransform: "uppercase", fontWeight: 700 }}>
                    {issue.source}
                  </Typography>
                  <Typography variant="body2">
                    {issue.path ? `${issue.path}: ` : ""}
                    {issue.message}
                  </Typography>
                </Alert>
              ))}
            </Stack>
          ) : (
            <Typography variant="body2" color="text.secondary">
              No issues found.
            </Typography>
          )}
        </Box>
      </Stack>
    </Paper>
  );
}

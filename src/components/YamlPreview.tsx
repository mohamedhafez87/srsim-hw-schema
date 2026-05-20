import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useState } from "react";

import type { ValidationReport } from "../types";

interface YamlPreviewProps {
  yaml: string;
  report: ValidationReport;
}

export function YamlPreview({ yaml, report }: YamlPreviewProps) {
  const [copyLabel, setCopyLabel] = useState("Copy");

  const copyYaml = async () => {
    try {
      await navigator.clipboard.writeText(yaml);
      setCopyLabel("Copied");
      window.setTimeout(() => setCopyLabel("Copy"), 1200);
    } catch {
      setCopyLabel("Unavailable");
      window.setTimeout(() => setCopyLabel("Copy"), 1600);
    }
  };

  const schemaIssues = report.issues.filter((issue) => issue.source === "schema").length;
  const hardwareIssues = report.issues.filter((issue) => issue.source === "hardware").length;

  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, height: "100%" }}>
      <Stack spacing={1.5} sx={{ height: "100%" }}>
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1 }}>
          <Box>
            <Typography variant="h6">Generated clab.yml</Typography>
            <Typography variant="body2" color="text.secondary">
              Updated from the selected components.
            </Typography>
          </Box>
          <Button size="small" startIcon={<ContentCopyIcon />} onClick={copyYaml}>
            {copyLabel}
          </Button>
        </Box>

        <Alert
          severity={report.valid ? "success" : "error"}
          icon={report.valid ? <CheckCircleOutlineIcon fontSize="inherit" /> : <ErrorOutlineIcon fontSize="inherit" />}
        >
          {report.valid ? "Generated topology validates." : "Generated topology has validation issues."}
        </Alert>

        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Chip size="small" color={schemaIssues ? "error" : "default"} label={`${schemaIssues} schema`} />
          <Chip size="small" color={hardwareIssues ? "error" : "default"} label={`${hardwareIssues} hardware`} />
        </Stack>

        {report.issues.length ? (
          <Box sx={{ maxHeight: 150, overflow: "auto" }}>
            <Stack spacing={0.75}>
              {report.issues.slice(0, 6).map((issue, index) => (
                <Typography key={index} variant="body2" color="error.main">
                  {issue.path ? `${issue.path}: ` : ""}
                  {issue.message}
                </Typography>
              ))}
            </Stack>
          </Box>
        ) : null}

        <TextField
          value={yaml}
          multiline
          fullWidth
          minRows={18}
          maxRows={28}
          slotProps={{
            input: {
              readOnly: true,
              sx: {
                alignItems: "flex-start",
                fontFamily: "var(--mono-font)",
                fontSize: 13,
                lineHeight: 1.45
              }
            }
          }}
        />
      </Stack>
    </Paper>
  );
}

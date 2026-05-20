import "@fontsource/roboto/300.css";
import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "@fontsource/roboto/700.css";

import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import CssBaseline from "@mui/material/CssBaseline";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import { useMemo, useState } from "react";

import hardwareSchemaData from "./data/srsim-supported-hardware.json";
import { ComponentEditor } from "./components/ComponentEditor";
import { MatrixTable } from "./components/MatrixTable";
import { ValidatorPanel } from "./components/ValidatorPanel";
import { YamlPreview } from "./components/YamlPreview";
import {
  buildMatrix,
  componentFromMatrixRow,
  defaultComponentsForEntry,
  defaultImpliesFields,
  defaultSfmForEntry,
  firstValue,
  getEntry,
  upsertComponentBySlot
} from "./matrix";
import { buildTopologyYaml } from "./topologyYaml";
import type { HardwareSchema, MatrixRow, SrsimConfig } from "./types";
import { validateTopologyYaml } from "./validation";

import "./styles.css";

const theme = createTheme({
  palette: {
    mode: "light",
    primary: {
      main: "#0b63ce"
    },
    secondary: {
      main: "#0f766e"
    },
    background: {
      default: "#f6f8fb",
      paper: "#ffffff"
    }
  },
  shape: {
    borderRadius: 8
  },
  typography: {
    h1: { letterSpacing: 0 },
    h2: { letterSpacing: 0 },
    h3: { letterSpacing: 0 },
    h4: { letterSpacing: 0 },
    h5: { letterSpacing: 0 },
    h6: { letterSpacing: 0 }
  },
  components: {
    MuiButton: {
      defaultProps: {
        disableElevation: true
      },
      styleOverrides: {
        root: {
          textTransform: "none"
        }
      }
    },
    MuiChip: {
      styleOverrides: {
        root: {
          maxWidth: "100%"
        },
        label: {
          overflow: "hidden",
          textOverflow: "ellipsis"
        }
      }
    }
  }
});

const hardwareSchema = hardwareSchemaData as HardwareSchema;

function schemaDate(value: string | undefined): string {
  if (!value) return "unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 10);
}

function initialConfig(matrix: ReturnType<typeof buildMatrix>): SrsimConfig {
  const preferred = matrix.find((entry) => entry.chassis === "sr-7s") ?? matrix[0];
  const components = defaultComponentsForEntry(preferred);
  return {
    labName: "srsim-lab",
    nodeName: "sros1",
    chassis: preferred?.chassis ?? "",
    sfm: defaultSfmForEntry(preferred),
    components
  };
}

export function App() {
  const matrix = useMemo(() => buildMatrix(hardwareSchema), []);
  const [config, setConfig] = useState<SrsimConfig>(() => initialConfig(matrix));
  const selectedEntry = getEntry(matrix, config.chassis);
  const yamlOptions = useMemo(
    () => ({
      shouldWriteSfm: (component: SrsimConfig["components"][number]) =>
        !defaultImpliesFields(selectedEntry, component, config.sfm, ["sfm"]),
      shouldWriteDirectMda: (component: SrsimConfig["components"][number], mda: { slot?: string | number; type?: string }) =>
        !defaultImpliesFields(selectedEntry, { ...component, mda: [mda] }, config.sfm, ["mda"]),
      shouldWriteXiom: (component: SrsimConfig["components"][number], xiom: { slot?: string | number; type?: string }) =>
        !defaultImpliesFields(selectedEntry, { ...component, xiom: [xiom] }, config.sfm, ["xiom", "mda"]),
      shouldWriteXiomMda: (
        component: SrsimConfig["components"][number],
        xiom: { slot?: string | number; type?: string },
        mda: { slot?: string | number; type?: string }
      ) => !defaultImpliesFields(selectedEntry, { ...component, xiom: [{ ...xiom, mda: [mda] }] }, config.sfm, ["mda"])
    }),
    [config.sfm, selectedEntry]
  );
  const yaml = useMemo(() => buildTopologyYaml(config, yamlOptions), [config, yamlOptions]);
  const generatedReport = useMemo(() => validateTopologyYaml(yaml, hardwareSchema), [yaml]);

  const addMatrixRow = (row: MatrixRow) => {
    const component = componentFromMatrixRow(row, config.components);
    if (!component) return;
    setConfig({
      ...config,
      sfm: firstValue(row, "sfm") || config.sfm,
      components: upsertComponentBySlot(config.components, component)
    });
  };

  const totalCards = selectedEntry
    ? new Set(selectedEntry.rows.flatMap((row) => row.values.card ?? [])).size
    : 0;
  const totalMdas = selectedEntry
    ? new Set(selectedEntry.rows.flatMap((row) => row.values.mda ?? [])).size
    : 0;

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box className="app">
        <Box component="header" className="app-header">
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="h5" component="h1">
              SR-SIM Hardware Configurator
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Configure Containerlab SR-SIM components and validate topology YAML.
            </Typography>
          </Box>
          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" justifyContent="flex-end">
            <Chip size="small" label={`${matrix.length} chassis`} />
            <Chip size="small" label={`${totalCards} cards`} />
            <Chip size="small" label={`${totalMdas} MDAs`} />
            <Chip size="small" variant="outlined" label={`generated ${schemaDate(hardwareSchema.generated_at)}`} />
          </Stack>
        </Box>

        <Box component="main" className="workbench">
          <ComponentEditor matrix={matrix} config={config} onChange={setConfig} />
          <YamlPreview yaml={yaml} report={generatedReport} />
          <ValidatorPanel generatedYaml={yaml} hardwareSchema={hardwareSchema} />
        </Box>

        <Box className="matrix-band">
          <MatrixTable entry={selectedEntry} onAddRow={addMatrixRow} />
        </Box>
      </Box>
    </ThemeProvider>
  );
}

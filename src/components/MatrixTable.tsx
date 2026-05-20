import AddIcon from "@mui/icons-material/Add";
import SearchIcon from "@mui/icons-material/Search";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import Paper from "@mui/material/Paper";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useMemo, useState } from "react";

import { componentFromMatrixRow, matrixSearchRows } from "../matrix";
import type { MatrixEntry, MatrixRow } from "../types";

interface MatrixTableProps {
  entry: MatrixEntry | undefined;
  onAddRow?: (row: MatrixRow) => void;
}

function ValueChips({ values }: { values: string[] | undefined }) {
  if (!values?.length) {
    return <Typography variant="body2" color="text.disabled">-</Typography>;
  }
  return (
    <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
      {values.map((value) => (
        <Chip key={value} size="small" variant="outlined" label={value} />
      ))}
    </Box>
  );
}

export function MatrixTable({ entry, onAddRow }: MatrixTableProps) {
  const [query, setQuery] = useState("");
  const rows = useMemo(() => matrixSearchRows(entry, query), [entry, query]);

  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 2, mb: 1.5 }}>
        <Box>
          <Typography variant="h6">Matrix rows</Typography>
          <Typography variant="body2" color="text.secondary">
            {entry ? `${entry.chassis}: ${rows.length} visible rows` : "No chassis selected"}
          </Typography>
        </Box>
        <TextField
          size="small"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search rows"
          sx={{ minWidth: { xs: 160, sm: 260 } }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              )
            }
          }}
        />
      </Box>

      <TableContainer sx={{ maxHeight: 420 }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              <TableCell>Source</TableCell>
              <TableCell>Model</TableCell>
              <TableCell>Slot</TableCell>
              <TableCell>Card</TableCell>
              <TableCell>SFM</TableCell>
              <TableCell>XIOM</TableCell>
              <TableCell>MDA</TableCell>
              <TableCell>Memory</TableCell>
              <TableCell align="right">Hardware</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row, index) => {
              const addable = Boolean(componentFromMatrixRow(row));
              return (
                <TableRow key={`${row.model}-${row.source}-${index}`} hover>
                  <TableCell>
                    <Chip
                      size="small"
                      color={row.source === "default_layout" ? "primary" : "default"}
                      variant={row.source === "default_layout" ? "filled" : "outlined"}
                      label={row.source === "default_layout" ? "default" : "supported"}
                    />
                  </TableCell>
                  <TableCell>{row.model}</TableCell>
                  <TableCell><ValueChips values={row.values.slot} /></TableCell>
                  <TableCell><ValueChips values={row.values.card} /></TableCell>
                  <TableCell><ValueChips values={row.values.sfm} /></TableCell>
                  <TableCell><ValueChips values={row.values.xiom} /></TableCell>
                  <TableCell><ValueChips values={row.values.mda} /></TableCell>
                  <TableCell><ValueChips values={row.values.memory} /></TableCell>
                  <TableCell align="right">
                    <Tooltip title="Add row to hardware">
                      <span>
                        <IconButton
                          size="small"
                          color="primary"
                          disabled={!onAddRow || !addable}
                          onClick={() => onAddRow?.(row)}
                        >
                          <AddIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}

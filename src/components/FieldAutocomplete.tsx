import Autocomplete from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import TextField from "@mui/material/TextField";
import type { ReactNode } from "react";

interface FieldAutocompleteProps {
  label: string;
  value: string;
  options: string[];
  optionLabels?: Record<string, string>;
  optionAdornment?: (option: string) => ReactNode;
  defaultOptions?: string[];
  onChange: (value: string) => void;
  disabled?: boolean;
  helperText?: string;
  allowFreeText?: boolean;
}

export function FieldAutocomplete({
  label,
  value,
  options,
  optionLabels = {},
  optionAdornment,
  defaultOptions = [],
  onChange,
  disabled,
  helperText,
  allowFreeText = true
}: FieldAutocompleteProps) {
  const defaultSet = new Set(defaultOptions);
  const optionLabel = (option: string) => {
    const label = optionLabels[option] ?? option;
    return defaultSet.has(option) ? `Default (${label})` : label;
  };

  return (
    <Autocomplete
      freeSolo={allowFreeText}
      autoSelect
      disabled={disabled}
      options={options}
      value={value || null}
      inputValue={allowFreeText ? value : undefined}
      getOptionLabel={(option) => typeof option === "string" ? optionLabel(option) : ""}
      onChange={(_, next) => onChange(typeof next === "string" ? next : "")}
      onInputChange={allowFreeText ? (_, next) => onChange(next) : undefined}
      renderOption={optionAdornment ? (props, option) => (
        <Box
          {...props}
          component="li"
          sx={{ alignItems: "center", display: "flex", width: "100%" }}
        >
          <Box component="span" sx={{ alignItems: "center", display: "flex", gap: 1, minWidth: 0, width: "100%" }}>
            <Box component="span" sx={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
              {optionLabel(option)}
            </Box>
            <Box component="span" sx={{ display: "inline-flex", flex: "0 0 auto", ml: "auto" }}>
              {optionAdornment(option)}
            </Box>
          </Box>
        </Box>
      ) : undefined}
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          size="small"
          helperText={helperText}
          InputProps={{
            ...params.InputProps,
            endAdornment: (
              <>
                {value && optionAdornment ? optionAdornment(value) : null}
                {params.InputProps.endAdornment}
              </>
            )
          }}
        />
      )}
    />
  );
}

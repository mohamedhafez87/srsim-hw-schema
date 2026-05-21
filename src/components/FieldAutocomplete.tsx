import Autocomplete from "@mui/material/Autocomplete";
import TextField from "@mui/material/TextField";

interface FieldAutocompleteProps {
  label: string;
  value: string;
  options: string[];
  optionLabels?: Record<string, string>;
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
      renderInput={(params) => (
        <TextField {...params} label={label} size="small" helperText={helperText} />
      )}
    />
  );
}

import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import FormControl from "@mui/material/FormControl";
import FormHelperText from "@mui/material/FormHelperText";
import IconButton from "@mui/material/IconButton";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import type { SelectChangeEvent } from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useMemo } from "react";

import {
  componentCardSlotOptions,
  componentCpmSlotOptions,
  componentTypeOptions,
  cpmOptions,
  defaultComponentsForEntry,
  defaultImpliesFields,
  defaultSfmForEntry,
  getEntry,
  isCpmSlot,
  mdaOptions,
  nextCpmSlot,
  nextNumericSlot,
  schemaNumericSlotOptions,
  sfmOptions,
  xiomOptions
} from "../matrix";
import { slotRules } from "../schemaSlots";
import type { MatrixEntry, SrsimComponent, SrsimConfig, SrsimMda, SrsimXiom } from "../types";

import { FieldAutocomplete } from "./FieldAutocomplete";

interface ComponentEditorProps {
  matrix: MatrixEntry[];
  config: SrsimConfig;
  onChange: (config: SrsimConfig) => void;
}

interface IndexedComponent {
  component: SrsimComponent;
  index: number;
}

type SlotOption = string | number;

function withoutEmptyNested(component: SrsimComponent): SrsimComponent {
  return {
    ...component,
    mda: component.mda?.length ? component.mda : undefined,
    xiom: component.xiom?.length ? component.xiom : undefined
  };
}

export function ComponentEditor({ matrix, config, onChange }: ComponentEditorProps) {
  const selectedEntry = getEntry(matrix, config.chassis);
  const chassisOptions = useMemo(() => matrix.map((entry) => entry.chassis), [matrix]);
  const sharedSfmOptions = sfmOptions(selectedEntry, []);
  const defaultSfm = defaultSfmForEntry(selectedEntry);

  const indexed = config.components.map((component, index) => ({ component, index }));
  const cpms = indexed.filter(({ component }) => isCpmSlot(component.slot));
  const cards = indexed.filter(({ component }) => !isCpmSlot(component.slot));
  const cpmSlotOptions = componentCpmSlotOptions(selectedEntry, slotRules.componentStringSlots);
  const cardSlotOptions = componentCardSlotOptions(
    selectedEntry,
    cards.map(({ component }) => component),
    slotRules.componentIntegerMinimum
  );
  const usedCpmSlots = new Set(cpms.map(({ component }) => String(component.slot ?? "").toUpperCase()));
  const usedCardSlots = new Set(cards.map(({ component }) => String(component.slot ?? "")));
  const availableCpmSlots = cpmSlotOptions.filter((slot) => !usedCpmSlots.has(String(slot).toUpperCase()));
  const availableCardSlots = cardSlotOptions.filter((slot) => !usedCardSlots.has(String(slot)));

  const updateConfig = (updates: Partial<SrsimConfig>) => onChange({ ...config, ...updates });

  const setChassis = (chassis: string) => {
    const entry = getEntry(matrix, chassis);
    const components = defaultComponentsForEntry(entry);
    updateConfig({
      chassis,
      components,
      sfm: defaultSfmForEntry(entry)
    });
  };

  const setComponents = (components: SrsimComponent[]) => {
    const cleanComponents = components.map(withoutEmptyNested);
    const compatibleSfms = sfmOptions(selectedEntry, cleanComponents);
    updateConfig({
      components: cleanComponents,
      sfm: compatibleSfms.length && !compatibleSfms.includes(config.sfm)
        ? (compatibleSfms.includes(defaultSfm) ? defaultSfm : compatibleSfms[0])
        : config.sfm
    });
  };

  const componentWithCompatibleSfm = (component: SrsimComponent, sfm: string): SrsimComponent => {
    if (isCpmSlot(component.slot)) {
      const options = cpmOptions(selectedEntry, sfm);
      return {
        slot: component.slot,
        type: component.type && options.includes(component.type) ? component.type : (options[0] ?? "")
      };
    }

    const typeOptions = componentTypeOptions(selectedEntry, { slot: component.slot }, sfm);
    const type = component.type && typeOptions.includes(component.type) ? component.type : (typeOptions[0] ?? "");
    const next: SrsimComponent = { slot: component.slot, type };

    if (component.type === type) {
      const directMdaOptions = mdaOptions(selectedEntry, { ...component, type }, sfm);
      const directMdas = (component.mda ?? []).filter((mda) => mda.type && directMdaOptions.includes(mda.type));
      if (directMdas.length) next.mda = directMdas;

      const validXioms = (component.xiom ?? []).filter((xiom) => {
        const options = xiomOptions(selectedEntry, { ...component, type }, sfm);
        return xiom.type && options.includes(xiom.type);
      });
      if (validXioms.length) next.xiom = validXioms;
      return next;
    }

    const firstMda = mdaOptions(selectedEntry, next, sfm)[0];
    if (firstMda) next.mda = [{ slot: 1, type: firstMda }];
    return next;
  };

  const applySfm = (sfm: string) => {
    const nextSfm = sfm || defaultSfm || sharedSfmOptions[0] || "";
    updateConfig({
      sfm: nextSfm,
      components: config.components.map((component) => componentWithCompatibleSfm(component, nextSfm))
    });
  };

  const updateComponent = (index: number, updates: Partial<SrsimComponent>) => {
    const next = [...config.components];
    next[index] = withoutEmptyNested({ ...next[index], ...updates });
    setComponents(next);
  };

  const removeComponent = (index: number) => {
    setComponents(config.components.filter((_, idx) => idx !== index));
  };

  const addCpm = () => {
    const slot = availableCpmSlots[0] ?? nextCpmSlot(config.components);
    if (!slot) return;
    setComponents([...config.components, { slot, type: cpmOptions(selectedEntry, config.sfm)[0] ?? "" }]);
  };

  const addCard = () => {
    const slot = availableCardSlots[0] ?? nextNumericSlot(cards.map(({ component }) => component));
    const type = componentTypeOptions(selectedEntry, { slot }, config.sfm)[0] ?? "";
    setComponents([...config.components, { slot, type }]);
  };

  const resetDefaults = () => {
    const components = defaultComponentsForEntry(selectedEntry);
    updateConfig({
      components,
      sfm: defaultSfm
    });
  };

  const addMda = (componentIndex: number) => {
    const component = config.components[componentIndex];
    const mdas = component.mda ?? [];
    updateComponent(componentIndex, {
      mda: [...mdas, { slot: nextNumericSlot(mdas), type: mdaOptions(selectedEntry, component, config.sfm)[0] ?? "" }]
    });
  };

  const updateMda = (componentIndex: number, mdaIndex: number, updates: Partial<SrsimMda>) => {
    const component = config.components[componentIndex];
    const mdas = [...(component.mda ?? [])];
    mdas[mdaIndex] = { ...mdas[mdaIndex], ...updates };
    updateComponent(componentIndex, { mda: mdas });
  };

  const removeMda = (componentIndex: number, mdaIndex: number) => {
    const component = config.components[componentIndex];
    updateComponent(componentIndex, { mda: (component.mda ?? []).filter((_, idx) => idx !== mdaIndex) });
  };

  const addXiom = (componentIndex: number) => {
    const component = config.components[componentIndex];
    const xioms = component.xiom ?? [];
    updateComponent(componentIndex, {
      xiom: [
        ...xioms,
        {
          slot: nextNumericSlot(xioms),
          type: xiomOptions(selectedEntry, component, config.sfm)[0] ?? "",
          mda: []
        }
      ]
    });
  };

  const updateXiom = (componentIndex: number, xiomIndex: number, updates: Partial<SrsimXiom>) => {
    const component = config.components[componentIndex];
    const xioms = [...(component.xiom ?? [])];
    xioms[xiomIndex] = { ...xioms[xiomIndex], ...updates };
    updateComponent(componentIndex, { xiom: xioms });
  };

  const removeXiom = (componentIndex: number, xiomIndex: number) => {
    const component = config.components[componentIndex];
    updateComponent(componentIndex, { xiom: (component.xiom ?? []).filter((_, idx) => idx !== xiomIndex) });
  };

  const addXiomMda = (componentIndex: number, xiomIndex: number) => {
    const component = config.components[componentIndex];
    const xioms = [...(component.xiom ?? [])];
    const xiom = xioms[xiomIndex];
    const mdas = xiom.mda ?? [];
    xioms[xiomIndex] = {
      ...xiom,
      mda: [...mdas, { slot: nextNumericSlot(mdas), type: mdaOptions(selectedEntry, component, config.sfm)[0] ?? "" }]
    };
    updateComponent(componentIndex, { xiom: xioms });
  };

  const updateXiomMda = (
    componentIndex: number,
    xiomIndex: number,
    mdaIndex: number,
    updates: Partial<SrsimMda>
  ) => {
    const component = config.components[componentIndex];
    const xioms = [...(component.xiom ?? [])];
    const xiom = xioms[xiomIndex];
    const mdas = [...(xiom.mda ?? [])];
    mdas[mdaIndex] = { ...mdas[mdaIndex], ...updates };
    xioms[xiomIndex] = { ...xiom, mda: mdas };
    updateComponent(componentIndex, { xiom: xioms });
  };

  const removeXiomMda = (componentIndex: number, xiomIndex: number, mdaIndex: number) => {
    const component = config.components[componentIndex];
    const xioms = [...(component.xiom ?? [])];
    const xiom = xioms[xiomIndex];
    xioms[xiomIndex] = { ...xiom, mda: (xiom.mda ?? []).filter((_, idx) => idx !== mdaIndex) };
    updateComponent(componentIndex, { xiom: xioms });
  };

  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
      <Stack spacing={2}>
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1 }}>
          <Box>
            <Typography variant="h6">Hardware</Typography>
            <Typography variant="body2" color="text.secondary">
              {selectedEntry?.models.join(", ") || "No chassis selected"}
            </Typography>
          </Box>
          <Tooltip title="Reset components from the documented default layout">
            <IconButton onClick={resetDefaults} size="small">
              <RestartAltIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>

        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 1.5 }}>
          <TextField
            label="Lab name"
            size="small"
            value={config.labName}
            onChange={(event) => updateConfig({ labName: event.target.value })}
          />
          <TextField
            label="Node name"
            size="small"
            value={config.nodeName}
            onChange={(event) => updateConfig({ nodeName: event.target.value })}
          />
        </Box>

        <FieldAutocomplete label="Chassis type" value={config.chassis} options={chassisOptions} onChange={setChassis} allowFreeText={false} />
        <FormControl size="small" fullWidth>
          <InputLabel id="sfm-select-label">SFM</InputLabel>
          <Select
            labelId="sfm-select-label"
            label="SFM"
            value={config.sfm || defaultSfm}
            onChange={(event) => applySfm(event.target.value)}
          >
            {defaultSfm ? <MenuItem value={defaultSfm}>Default ({defaultSfm})</MenuItem> : null}
            {sharedSfmOptions
              .filter((sfm) => sfm !== defaultSfm)
              .map((sfm) => (
                <MenuItem key={sfm} value={sfm}>
                  {sfm}
                </MenuItem>
              ))}
          </Select>
          <FormHelperText>
            {sharedSfmOptions.length ? "Default is used for compatibility and omitted from YAML." : "This chassis has no SFM constraint"}
          </FormHelperText>
        </FormControl>

        <ComponentSection
          title="Control modules"
          items={cpms}
          addLabel="Add CPM"
          addDisabled={!availableCpmSlots.length || !cpmOptions(selectedEntry, config.sfm).length}
          onAdd={addCpm}
          renderItem={({ component, index }) => (
            <Paper variant="outlined" sx={{ p: 1.5 }}>
              <ComponentHeader
                label="CPM"
                component={component}
                onRemove={() => removeComponent(index)}
              />
              <Box sx={{ display: "grid", gridTemplateColumns: "120px minmax(0, 1fr)", gap: 1.5, mt: 1.5 }}>
                <SlotSelect
                  label="Slot"
                  value={component.slot}
                  options={cpmSlotOptions}
                  defaultOptions={cpmSlotOptions.filter((slot) =>
                    defaultImpliesFields(selectedEntry, { ...component, slot }, config.sfm, [])
                  )}
                  onChange={(slot) => updateComponent(index, { slot })}
                />
                <FieldAutocomplete
                  label="Type"
                  value={component.type ?? ""}
                  options={cpmOptions(selectedEntry, config.sfm)}
                  defaultOptions={cpmOptions(selectedEntry, config.sfm).filter((type) =>
                    defaultImpliesFields(selectedEntry, { ...component, type }, config.sfm, [])
                  )}
                  onChange={(type) => updateComponent(index, { type })}
                  allowFreeText={false}
                />
              </Box>
            </Paper>
          )}
        />

        <ComponentSection
          title="Line cards"
          items={cards}
          addLabel="Add card"
          addDisabled={!availableCardSlots.length || !componentTypeOptions(selectedEntry, {}, config.sfm).length}
          onAdd={addCard}
          renderItem={({ component, index }) => (
            <Paper variant="outlined" sx={{ p: 1.5 }}>
              <ComponentHeader
                label="Line card"
                component={component}
                onRemove={() => removeComponent(index)}
              />
              <Box sx={{ display: "grid", gridTemplateColumns: "120px minmax(0, 1fr)", gap: 1.5, mt: 1.5 }}>
                <SlotSelect
                  label="Slot"
                  value={component.slot}
                  options={cardSlotOptions}
                  defaultOptions={cardSlotOptions.filter((slot) =>
                    defaultImpliesFields(selectedEntry, { ...component, slot }, config.sfm, [])
                  )}
                  onChange={(slot) => updateComponent(index, { slot })}
                />
                <FieldAutocomplete
                  label="Type"
                  value={component.type ?? ""}
                  options={componentTypeOptions(selectedEntry, component, config.sfm)}
                  defaultOptions={componentTypeOptions(selectedEntry, component, config.sfm).filter((type) =>
                    defaultImpliesFields(selectedEntry, { ...component, type }, config.sfm, [])
                  )}
                  onChange={(type) => updateComponent(index, { type })}
                  allowFreeText={false}
                />
              </Box>

              <NestedMdaSection
                title="Direct MDAs"
                mdas={component.mda ?? []}
                options={mdaOptions(selectedEntry, component, config.sfm)}
                slotOptions={schemaNumericSlotOptions(component.mda ?? [], 2, slotRules.mdaIntegerMinimum)}
                defaultSlots={(component.mda ?? []).map((mda) =>
                  defaultImpliesFields(selectedEntry, { ...component, mda: [mda] }, config.sfm, ["mda"]) ? [1] : []
                )}
                defaultTypes={(component.mda ?? []).map((mda) =>
                  mdaOptions(selectedEntry, component, config.sfm).filter((type) =>
                    defaultImpliesFields(selectedEntry, { ...component, mda: [{ ...mda, type }] }, config.sfm, ["mda"])
                  )
                )}
                onAdd={() => addMda(index)}
                onUpdate={(mdaIndex, updates) => updateMda(index, mdaIndex, updates)}
                onRemove={(mdaIndex) => removeMda(index, mdaIndex)}
              />

              <NestedXiomSection
                xioms={component.xiom ?? []}
                xiomOptions={xiomOptions(selectedEntry, component, config.sfm)}
                mdaOptions={mdaOptions(selectedEntry, component, config.sfm)}
                xiomSlotOptions={schemaNumericSlotOptions(component.xiom ?? [], 2, slotRules.xiomIntegerMinimum)}
                xiomDefaultSlots={(component.xiom ?? []).map((xiom) =>
                  defaultImpliesFields(selectedEntry, { ...component, xiom: [xiom] }, config.sfm, ["xiom", "mda"]) ? [1] : []
                )}
                xiomDefaultTypes={(component.xiom ?? []).map((xiom) =>
                  xiomOptions(selectedEntry, component, config.sfm).filter((type) =>
                    defaultImpliesFields(selectedEntry, { ...component, xiom: [{ ...xiom, type }] }, config.sfm, ["xiom", "mda"])
                  )
                )}
                mdaDefaultSlots={(component.xiom ?? []).map((xiom) =>
                  (xiom.mda ?? []).map((mda) =>
                    defaultImpliesFields(selectedEntry, { ...component, xiom: [{ ...xiom, mda: [mda] }] }, config.sfm, ["mda"]) ? [1] : []
                  )
                )}
                mdaDefaultTypes={(component.xiom ?? []).map((xiom) =>
                  (xiom.mda ?? []).map((mda) =>
                    mdaOptions(selectedEntry, component, config.sfm).filter((type) =>
                      defaultImpliesFields(
                        selectedEntry,
                        { ...component, xiom: [{ ...xiom, mda: [{ ...mda, type }] }] },
                        config.sfm,
                        ["mda"]
                      )
                    )
                  )
                )}
                onAdd={() => addXiom(index)}
                onUpdate={(xiomIndex, updates) => updateXiom(index, xiomIndex, updates)}
                onRemove={(xiomIndex) => removeXiom(index, xiomIndex)}
                onAddMda={(xiomIndex) => addXiomMda(index, xiomIndex)}
                onUpdateMda={(xiomIndex, mdaIndex, updates) => updateXiomMda(index, xiomIndex, mdaIndex, updates)}
                onRemoveMda={(xiomIndex, mdaIndex) => removeXiomMda(index, xiomIndex, mdaIndex)}
              />
            </Paper>
          )}
        />
      </Stack>
    </Paper>
  );
}

function ComponentHeader({
  label,
  component,
  onRemove
}: {
  label: string;
  component: SrsimComponent;
  onRemove: () => void;
}) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
        <Chip label={String(component.slot ?? "?")} size="small" />
        <Typography variant="subtitle2" noWrap>
          {label}
        </Typography>
        {component.type ? (
          <Typography variant="body2" color="text.secondary" noWrap>
            {component.type}
          </Typography>
        ) : null}
      </Stack>
      <Tooltip title="Remove component">
        <IconButton size="small" color="error" onClick={onRemove}>
          <DeleteOutlineIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Box>
  );
}

function ComponentSection({
  title,
  items,
  addLabel,
  addDisabled,
  onAdd,
  renderItem
}: {
  title: string;
  items: IndexedComponent[];
  addLabel: string;
  addDisabled?: boolean;
  onAdd: () => void;
  renderItem: (item: IndexedComponent) => React.ReactNode;
}) {
  return (
    <Stack spacing={1.25}>
      <Divider />
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1 }}>
        <Typography variant="subtitle1">{title}</Typography>
        <Button size="small" startIcon={<AddIcon />} onClick={onAdd} disabled={addDisabled}>
          {addLabel}
        </Button>
      </Box>
      {items.length ? (
        <Stack spacing={1.25}>{items.map((item) => <Box key={item.index}>{renderItem(item)}</Box>)}</Stack>
      ) : (
        <Typography variant="body2" color="text.secondary">
          No entries configured.
        </Typography>
      )}
    </Stack>
  );
}

function withCurrentSlotOption(options: SlotOption[], value: SlotOption | undefined): SlotOption[] {
  if (value === undefined || value === "") return options;
  return options.some((option) => String(option) === String(value)) ? options : [...options, value];
}

function slotFromSelectValue(value: string, options: SlotOption[]): SlotOption {
  const option = options.find((candidate) => String(candidate) === value);
  if (option !== undefined) return option;
  return /^\d+$/.test(value) ? Number(value) : value.toUpperCase();
}

function SlotSelect({
  label,
  value,
  options,
  defaultOptions = [],
  onChange
}: {
  label: string;
  value?: SlotOption;
  options: SlotOption[];
  defaultOptions?: SlotOption[];
  onChange: (slot: SlotOption) => void;
}) {
  const visibleOptions = withCurrentSlotOption(options, value);
  const defaultSet = new Set(defaultOptions.map((option) => String(option)));
  const optionLabel = (option: SlotOption) => defaultSet.has(String(option)) ? `${String(option)} (default)` : String(option);
  const selectedLabel = (selected: unknown) => {
    const text = String(selected);
    return defaultSet.has(text) ? `${text} default` : text;
  };

  return (
    <FormControl size="small" fullWidth>
      <InputLabel>{label}</InputLabel>
      <Select
        label={label}
        value={value === undefined || value === "" ? "" : String(value)}
        renderValue={selectedLabel}
        onChange={(event: SelectChangeEvent) => onChange(slotFromSelectValue(event.target.value, visibleOptions))}
      >
        {visibleOptions.map((option) => (
          <MenuItem key={String(option)} value={String(option)}>
            {optionLabel(option)}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}

function NestedMdaSection({
  title,
  mdas,
  options,
  slotOptions,
  defaultSlots,
  defaultTypes,
  onAdd,
  onUpdate,
  onRemove
}: {
  title: string;
  mdas: SrsimMda[];
  options: string[];
  slotOptions: number[];
  defaultSlots?: SlotOption[][];
  defaultTypes?: string[][];
  onAdd: () => void;
  onUpdate: (index: number, updates: Partial<SrsimMda>) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <Stack spacing={1} sx={{ mt: 1.5 }}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1 }}>
        <Typography variant="subtitle2">{title}</Typography>
        <Button size="small" startIcon={<AddIcon />} onClick={onAdd}>
          Add
        </Button>
      </Box>
      {mdas.map((mda, index) => (
        <Box
          key={index}
          sx={{
            display: "grid",
            gridTemplateColumns: "112px minmax(0, 1fr) auto",
            gap: 1,
            alignItems: "center"
          }}
        >
          <SlotSelect
            label="Slot"
            value={mda.slot}
            options={slotOptions}
            defaultOptions={defaultSlots?.[index] ?? []}
            onChange={(slot) => onUpdate(index, { slot })}
          />
          <FieldAutocomplete
            label="Type"
            value={mda.type ?? ""}
            options={options}
            defaultOptions={defaultTypes?.[index] ?? []}
            onChange={(type) => onUpdate(index, { type })}
            allowFreeText={false}
          />
          <IconButton size="small" color="error" onClick={() => onRemove(index)}>
            <DeleteOutlineIcon fontSize="small" />
          </IconButton>
        </Box>
      ))}
    </Stack>
  );
}

function NestedXiomSection({
  xioms,
  xiomOptions: xiomTypeOptions,
  mdaOptions: mdaTypeOptions,
  xiomSlotOptions,
  xiomDefaultSlots,
  xiomDefaultTypes,
  mdaDefaultSlots,
  mdaDefaultTypes,
  onAdd,
  onUpdate,
  onRemove,
  onAddMda,
  onUpdateMda,
  onRemoveMda
}: {
  xioms: SrsimXiom[];
  xiomOptions: string[];
  mdaOptions: string[];
  xiomSlotOptions: number[];
  xiomDefaultSlots?: SlotOption[][];
  xiomDefaultTypes?: string[][];
  mdaDefaultSlots?: SlotOption[][][];
  mdaDefaultTypes?: string[][][];
  onAdd: () => void;
  onUpdate: (index: number, updates: Partial<SrsimXiom>) => void;
  onRemove: (index: number) => void;
  onAddMda: (xiomIndex: number) => void;
  onUpdateMda: (xiomIndex: number, mdaIndex: number, updates: Partial<SrsimMda>) => void;
  onRemoveMda: (xiomIndex: number, mdaIndex: number) => void;
}) {
  return (
    <Stack spacing={1} sx={{ mt: 1.5 }}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1 }}>
        <Typography variant="subtitle2">XIOMs</Typography>
        <Button size="small" startIcon={<AddIcon />} onClick={onAdd} disabled={xioms.length >= 2}>
          Add XIOM
        </Button>
      </Box>
      {xioms.map((xiom, xiomIndex) => (
        <Paper key={xiomIndex} variant="outlined" sx={{ p: 1.25, bgcolor: "action.hover" }}>
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: "112px minmax(0, 1fr) auto",
              gap: 1,
              alignItems: "center"
            }}
          >
            <SlotSelect
              label="Slot"
              value={xiom.slot}
              options={xiomSlotOptions}
              defaultOptions={xiomDefaultSlots?.[xiomIndex] ?? []}
              onChange={(slot) => onUpdate(xiomIndex, { slot })}
            />
            <FieldAutocomplete
              label="XIOM type"
              value={xiom.type ?? ""}
              options={xiomTypeOptions}
              defaultOptions={xiomDefaultTypes?.[xiomIndex] ?? []}
              onChange={(type) => onUpdate(xiomIndex, { type })}
              allowFreeText={false}
            />
            <IconButton size="small" color="error" onClick={() => onRemove(xiomIndex)}>
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          </Box>
          <NestedMdaSection
            title="XIOM MDAs"
            mdas={xiom.mda ?? []}
            options={mdaTypeOptions}
            slotOptions={schemaNumericSlotOptions(xiom.mda ?? [], 2, slotRules.mdaIntegerMinimum)}
            defaultSlots={mdaDefaultSlots?.[xiomIndex]}
            defaultTypes={mdaDefaultTypes?.[xiomIndex]}
            onAdd={() => onAddMda(xiomIndex)}
            onUpdate={(mdaIndex, updates) => onUpdateMda(xiomIndex, mdaIndex, updates)}
            onRemove={(mdaIndex) => onRemoveMda(xiomIndex, mdaIndex)}
          />
        </Paper>
      ))}
    </Stack>
  );
}

import type {
  HardwareModelEntry,
  HardwareSchema,
  MatrixEntry,
  MatrixRow,
  RawHardwareRecord,
  SrsimComponent,
  SrsimMda,
  SrsimXiom
} from "./types";

const hardwareFields = new Set(["card", "sfm", "xiom", "mda"]);

export function cleanText(value: unknown): string {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export function canonicalToken(value: unknown): string {
  return cleanText(value).toLowerCase();
}

export function isEmptyValue(value: unknown): boolean {
  const text = cleanText(value);
  return text === "" || text === "-" || text === "--" || text === "N/A" || text === "n/a";
}

export function uniqueSorted(values: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = cleanText(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result.sort((a, b) => {
    const aNum = /^\d+$/.test(a);
    const bNum = /^\d+$/.test(b);
    if (aNum && bNum) return Number(a) - Number(b);
    if (aNum !== bNum) return aNum ? -1 : 1;
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  });
}

export function splitValues(value: unknown): string[] {
  const text = cleanText(value);
  if (isEmptyValue(text)) return [];

  const parts: string[] = [];
  for (const line of text.split("\n")) {
    for (const part of line.split(/\s+\bor\b\s+/i)) {
      const cleaned = cleanText(part);
      if (cleaned && !isEmptyValue(cleaned) && cleaned.toLowerCase() !== "or") {
        parts.push(cleaned);
      }
    }
  }
  return uniqueSorted(parts.length ? parts : [text]);
}

export function clabChassisToken(value: unknown): string {
  return cleanText(value)
    .replace(/\s*\([^)]*\)\s*$/g, "")
    .replace(/^(?:7250|7450|7705|7750|7950)\s+/i, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();
}

function normalizedRecordValues(field: string, value: unknown): string[] {
  const values = splitValues(value);
  if (field === "chassis") {
    return uniqueSorted(values.map(clabChassisToken));
  }
  if (hardwareFields.has(field) || field.startsWith("mda_")) {
    return uniqueSorted(values.map((item) => cleanText(item).toLowerCase()));
  }
  return uniqueSorted(values);
}

function aliasesFromEntry(model: string, entry: HardwareModelEntry): string[] {
  let aliases: string[] = [];
  for (const value of entry.supported_values?.chassis ?? []) {
    aliases = aliases.concat(normalizedRecordValues("chassis", value));
  }
  if (aliases.length) return uniqueSorted(aliases);

  for (const source of ["default_layout", "supported_hardware"] as const) {
    for (const record of entry[source] ?? []) {
      if (record.chassis) {
        aliases = aliases.concat(normalizedRecordValues("chassis", record.chassis));
      }
    }
  }
  return aliases.length ? uniqueSorted(aliases) : uniqueSorted([clabChassisToken(model)]);
}

function normalizedRow(record: RawHardwareRecord): Record<string, string[]> {
  const row: Record<string, string[]> = {};
  for (const field of Object.keys(record).sort()) {
    const values = normalizedRecordValues(field, record[field]);
    if (values.length) row[field] = values;
  }
  return row;
}

function rowText(row: MatrixRow): string {
  const parts = [row.model, row.source];
  for (const field of ["slot", "card", "sfm", "xiom", "mda", "memory"]) {
    parts.push(...(row.values[field] ?? []));
  }
  return parts.join(" ").toLowerCase();
}

export function buildMatrix(data: HardwareSchema): MatrixEntry[] {
  const built = new Map<string, MatrixEntry & { seenRows: Set<string> }>();

  const ensureEntry = (chassis: string): MatrixEntry & { seenRows: Set<string> } => {
    const existing = built.get(chassis);
    if (existing) return existing;
    const next = { chassis, models: [], rows: [], seenRows: new Set<string>() };
    built.set(chassis, next);
    return next;
  };

  for (const [model, entry] of Object.entries(data.models ?? {}).sort()) {
    const aliases = aliasesFromEntry(model, entry);
    for (const alias of aliases) {
      const target = ensureEntry(alias);
      target.models = uniqueSorted([...target.models, model]);
    }

    for (const source of ["default_layout", "supported_hardware"] as const) {
      for (const record of entry[source] ?? []) {
        const values = normalizedRow(record);
        const rowAliases = values.chassis?.length ? values.chassis : aliases;
        for (const alias of rowAliases) {
          const target = ensureEntry(alias);
          target.models = uniqueSorted([...target.models, model]);
          const row = { model, source, values };
          const key = JSON.stringify(row);
          if (!target.seenRows.has(key)) {
            target.seenRows.add(key);
            target.rows.push(row);
          }
        }
      }
    }
  }

  return [...built.values()]
    .map(({ seenRows: _seenRows, ...entry }) => ({
      ...entry,
      rows: [...entry.rows].sort((a, b) =>
        rowText(a).localeCompare(rowText(b), undefined, { numeric: true, sensitivity: "base" })
      )
    }))
    .sort((a, b) =>
      a.chassis.localeCompare(b.chassis, undefined, { numeric: true, sensitivity: "base" })
    );
}

export function cardLooksCpm(card: unknown): boolean {
  const value = String(card ?? "");
  return value.startsWith("cpm") || value.startsWith("cpiom");
}

function rowHasAlphaSlot(row: MatrixRow): boolean {
  return (row.values.slot ?? []).some((slot) => /^[AB]$/i.test(slot));
}

function rowHasNumericSlot(row: MatrixRow): boolean {
  return (row.values.slot ?? []).some((slot) => /^\d+$/.test(slot));
}

function rowHasPayload(row: MatrixRow): boolean {
  return Boolean((row.values.mda ?? []).length || (row.values.xiom ?? []).length);
}

export function rowCpmCards(row: MatrixRow): string[] {
  return (row.values.card ?? []).filter(
    (card) => rowHasAlphaSlot(row) || (cardLooksCpm(card) && !rowHasPayload(row))
  );
}

export function rowLineCards(row: MatrixRow): string[] {
  return (row.values.card ?? []).filter(
    (card) => rowHasNumericSlot(row) || rowHasPayload(row) || !cardLooksCpm(card)
  );
}

export function firstNumericSlot(row: MatrixRow | undefined): string {
  return row?.values.slot?.find((slot) => /^\d+$/.test(slot)) ?? "";
}

export function firstAlphaSlot(row: MatrixRow | undefined): string {
  return row?.values.slot?.find((slot) => /^[AB]$/i.test(slot)) ?? "";
}

export function firstValue(row: MatrixRow | undefined, field: string): string {
  return row?.values[field]?.[0] ?? "";
}

export function getEntry(matrix: MatrixEntry[], chassis: string): MatrixEntry | undefined {
  return matrix.find((entry) => entry.chassis === chassis) ?? matrix[0];
}

function rowMatchesComponent(
  row: MatrixRow,
  component: SrsimComponent,
  sfm: string,
  omitField?: "card" | "sfm" | "xiom" | "mda"
): boolean {
  if (sfm && omitField !== "sfm" && (row.values.sfm ?? []).length && !row.values.sfm.includes(sfm)) {
    return false;
  }
  const cardValues = isCpmSlot(component.slot) ? rowCpmCards(row) : rowLineCards(row);
  if (component.type && omitField !== "card" && !cardValues.includes(component.type)) {
    return false;
  }
  const selectedXiom = component.xiom?.find((xiom) => xiom.type)?.type ?? "";
  if (selectedXiom && omitField !== "xiom" && !(row.values.xiom ?? []).includes(selectedXiom)) {
    return false;
  }
  const selectedMda =
    component.mda?.find((mda) => mda.type)?.type ??
    component.xiom?.flatMap((xiom) => xiom.mda ?? []).find((mda) => mda.type)?.type ??
    "";
  if (selectedMda && omitField !== "mda" && !(row.values.mda ?? []).includes(selectedMda)) {
    return false;
  }
  return true;
}

function optionRows(entry: MatrixEntry | undefined, component: SrsimComponent, sfm: string, omitField: "card" | "sfm" | "xiom" | "mda"): MatrixRow[] {
  return (entry?.rows ?? []).filter((row) => rowMatchesComponent(row, component, sfm, omitField));
}

export function cpmOptions(entry: MatrixEntry | undefined, sfm: string): string[] {
  const values: string[] = [];
  for (const row of entry?.rows ?? []) {
    if (sfm && (row.values.sfm ?? []).length && !row.values.sfm.includes(sfm)) continue;
    values.push(...rowCpmCards(row));
  }
  return uniqueSorted(values);
}

export function componentTypeOptions(entry: MatrixEntry | undefined, component: SrsimComponent, sfm: string): string[] {
  const values: string[] = [];
  for (const row of optionRows(entry, component, sfm, "card")) {
    values.push(...rowLineCards(row));
  }
  return uniqueSorted(values);
}

export function sfmOptions(entry: MatrixEntry | undefined, components: SrsimComponent[]): string[] {
  const selectedComponents = components.filter((component) => component.type);
  if (!selectedComponents.length) {
    return uniqueSorted((entry?.rows ?? []).flatMap((row) => row.values.sfm ?? []));
  }

  let intersection: string[] | null = null;
  for (const component of selectedComponents) {
    const values = uniqueSorted(
      (entry?.rows ?? [])
        .filter((row) => rowMatchesComponent(row, component, "", "sfm"))
        .flatMap((row) => row.values.sfm ?? [])
    );
    if (!values.length) continue;
    intersection = intersection === null ? values : intersection.filter((value) => values.includes(value));
  }
  return uniqueSorted(intersection ?? []);
}

export function xiomOptions(entry: MatrixEntry | undefined, component: SrsimComponent, sfm: string): string[] {
  return uniqueSorted(optionRows(entry, component, sfm, "xiom").flatMap((row) => row.values.xiom ?? []));
}

export function mdaOptions(entry: MatrixEntry | undefined, component: SrsimComponent, sfm: string): string[] {
  return uniqueSorted(optionRows(entry, component, sfm, "mda").flatMap((row) => row.values.mda ?? []));
}

function uniqueNumbers(values: unknown[]): number[] {
  const numbers = values
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
  return [...new Set(numbers)].sort((a, b) => a - b);
}

function numberRange(max: number, min = 1): number[] {
  const start = Math.max(1, min);
  const end = Math.max(start, max);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function inferredComponentSlotCount(chassis: string | undefined): number {
  const value = chassis ?? "";
  const srA = value.match(/^sr-a(\d+)$/);
  if (srA) return Number(srA[1]);

  const modular = value.match(/^(?:ess|ixr|sr|xrs)-(\d+)(?:[a-z]*)$/);
  if (modular) return Number(modular[1]);

  return 1;
}

export function componentCpmSlotOptions(entry: MatrixEntry | undefined, schemaSlots: string[] = ["A", "B"]): string[] {
  const slots = (entry?.rows ?? [])
    .flatMap((row) => row.values.slot ?? [])
    .filter((slot) => /^[AB]$/i.test(slot))
    .map((slot) => slot.toUpperCase());
  return uniqueSorted([...slots, ...schemaSlots.map((slot) => slot.toUpperCase())]);
}

export function componentCardSlotOptions(
  entry: MatrixEntry | undefined,
  components: Array<{ slot?: string | number }> = [],
  minimumSlot = 1
): number[] {
  const matrixSlots = uniqueNumbers((entry?.rows ?? []).flatMap((row) => row.values.slot ?? []));
  const configuredSlots = uniqueNumbers(components.map((component) => component.slot));
  const maxSlot = Math.max(inferredComponentSlotCount(entry?.chassis), ...matrixSlots, ...configuredSlots, minimumSlot);
  return numberRange(maxSlot, minimumSlot);
}

export function schemaNumericSlotOptions(
  items: Array<{ slot?: string | number }> = [],
  minimumVisibleSlots = 1,
  minimumSlot = 1
): number[] {
  const configuredSlots = uniqueNumbers(items.map((item) => item.slot));
  const maxSlot = Math.max(minimumVisibleSlots, ...configuredSlots, minimumSlot);
  return numberRange(maxSlot, minimumSlot);
}

export function matrixSearchRows(entry: MatrixEntry | undefined, query: string): MatrixRow[] {
  const needle = query.trim().toLowerCase();
  return (entry?.rows ?? []).filter((row) => !needle || rowText(row).includes(needle));
}

export function isCpmSlot(slot: unknown): boolean {
  if (slot === undefined || slot === null) return false;
  const value = String(slot).trim().toUpperCase();
  return value === "A" || value === "B";
}

function makeMda(slot: string | number, type: string): SrsimMda {
  return { slot, type };
}

function makeXiom(slot: string | number, type: string, mdaType: string): SrsimXiom {
  return { slot, type, mda: mdaType ? [makeMda(1, mdaType)] : [] };
}

export function defaultComponentsForEntry(entry: MatrixEntry | undefined): SrsimComponent[] {
  if (!entry) return [];

  const components: SrsimComponent[] = [];
  const seen = new Set<string>();
  const addComponent = (component: SrsimComponent) => {
    const key = `${component.slot ?? ""}:${component.type ?? ""}`;
    if (!component.type || seen.has(key)) return;
    seen.add(key);
    components.push(component);
  };

  for (const row of entry.rows.filter((candidate) => candidate.source === "default_layout")) {
    for (const type of rowCpmCards(row)) {
      addComponent({ slot: firstAlphaSlot(row) || "A", type });
    }
    for (const type of rowLineCards(row)) {
      const component: SrsimComponent = {
        slot: firstNumericSlot(row) || "1",
        type
      };
      const xiom = firstValue(row, "xiom");
      const mda = firstValue(row, "mda");
      if (xiom) {
        component.xiom = [makeXiom(1, xiom, mda)];
      } else if (mda) {
        component.mda = [makeMda(1, mda)];
      }
      addComponent(component);
    }
  }

  if (components.length) return components;

  const cpm = cpmOptions(entry, "")[0];
  const card = componentTypeOptions(entry, {}, "")[0];
  return [
    ...(cpm ? [{ slot: "A", type: cpm }] : []),
    ...(card ? [{ slot: 1, type: card }] : [])
  ];
}

export function componentFromMatrixRow(
  row: MatrixRow,
  existingComponents: SrsimComponent[] = []
): SrsimComponent | null {
  const cpmType = rowCpmCards(row)[0];
  if (cpmType) {
    const slot = firstAlphaSlot(row) || firstExistingComponentSlot(existingComponents, "cpm") || nextCpmSlot(existingComponents);
    return slot ? { slot, type: cpmType } : null;
  }

  const cardType = rowLineCards(row)[0];
  if (!cardType) return null;

  const rowSlot = firstNumericSlot(row);
  const component: SrsimComponent = {
    slot: rowSlot ? Number(rowSlot) : (firstExistingComponentSlot(existingComponents, "card") ?? nextNumericSlot(existingComponents)),
    type: cardType
  };
  const xiom = firstValue(row, "xiom");
  const mda = firstValue(row, "mda");
  if (xiom) {
    component.xiom = [makeXiom(1, xiom, mda)];
  } else if (mda) {
    component.mda = [makeMda(1, mda)];
  }
  return component;
}

function firstExistingComponentSlot(components: SrsimComponent[], kind: "cpm" | "card"): string | number | undefined {
  return components.find((component) => kind === "cpm" ? isCpmSlot(component.slot) : !isCpmSlot(component.slot))?.slot;
}

export function upsertComponentBySlot(components: SrsimComponent[], component: SrsimComponent): SrsimComponent[] {
  const slotKey = String(component.slot ?? "").toUpperCase();
  const next = [...components];
  const index = next.findIndex((item) => String(item.slot ?? "").toUpperCase() === slotKey);
  if (index === -1) {
    next.push(component);
  } else {
    next[index] = component;
  }
  return next;
}

export function defaultSfmForEntry(entry: MatrixEntry | undefined): string {
  const defaults = entry?.rows.filter((row) => row.source === "default_layout") ?? [];
  const sfms = uniqueSorted(defaults.flatMap((row) => row.values.sfm ?? []));
  return sfms.length === 1 ? sfms[0] : (sfms[0] ?? "");
}

export function nextCpmSlot(components: SrsimComponent[]): string | null {
  const used = new Set(components.map((component) => String(component.slot ?? "").toUpperCase()));
  if (!used.has("A")) return "A";
  if (!used.has("B")) return "B";
  return null;
}

export function nextNumericSlot(items: Array<{ slot?: string | number }>): number {
  const used = items
    .map((item) => Number(item.slot))
    .filter((slot) => Number.isFinite(slot) && slot > 0);
  return used.length ? Math.max(...used) + 1 : 1;
}

export function matchingRowsForSummary(entry: MatrixEntry | undefined, component: SrsimComponent, sfm: string): MatrixRow[] {
  return (entry?.rows ?? []).filter((row) => rowMatchesComponent(row, component, sfm));
}

type DefaultField = "sfm" | "xiom" | "mda";

function selectedXiom(component: SrsimComponent): string {
  return component.xiom?.find((xiom) => xiom.type)?.type ?? "";
}

function selectedMda(component: SrsimComponent): string {
  return (
    component.mda?.find((mda) => mda.type)?.type ??
    component.xiom?.flatMap((xiom) => xiom.mda ?? []).find((mda) => mda.type)?.type ??
    ""
  );
}

function rowContains(row: MatrixRow, field: string, expected: string): boolean {
  if (!expected) return true;
  const values = field === "card" ? rowLineCards(row) : row.values[field];
  return values === undefined || values.includes(expected);
}

function rowContainsSelectedDefault(row: MatrixRow, field: DefaultField, component: SrsimComponent, sfm: string): boolean {
  const expected = field === "sfm" ? sfm : field === "xiom" ? selectedXiom(component) : selectedMda(component);
  if (!expected) return true;
  return (row.values[field] ?? []).includes(expected);
}

export function defaultImpliesFields(
  entry: MatrixEntry | undefined,
  component: SrsimComponent,
  sfm: string,
  fields: DefaultField[]
): boolean {
  if (!entry || !component.type) return false;
  const omitted = new Set(fields);

  return entry.rows.some((row) => {
    if (row.source !== "default_layout") return false;
    if (!rowContains(row, "slot", String(component.slot ?? ""))) return false;

    const cards = isCpmSlot(component.slot) ? rowCpmCards(row) : rowLineCards(row);
    if (!cards.includes(component.type ?? "")) return false;

    if (!omitted.has("sfm") && !rowContains(row, "sfm", sfm)) return false;
    if (!omitted.has("xiom") && !rowContains(row, "xiom", selectedXiom(component))) return false;
    if (!omitted.has("mda") && !rowContains(row, "mda", selectedMda(component))) return false;

    return fields.every((field) => rowContainsSelectedDefault(row, field, component, sfm));
  });
}

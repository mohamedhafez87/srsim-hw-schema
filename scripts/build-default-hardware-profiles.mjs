#!/usr/bin/env node
/**
 * Build default Containerlab hardware profiles from srsim-hw-schema release schemas.
 *
 * Output:
 *   - releases/<release-id>/default-hardware-profiles.yaml
 *   - src/data/default-hardware-profiles.yaml
 *
 * Usage:
 *   node scripts/build-default-hardware-profiles.mjs
 *
 * Optional:
 *   node scripts/build-default-hardware-profiles.mjs --catalog releases.yaml
 *   node scripts/build-default-hardware-profiles.mjs --output src/data/default-hardware-profiles.yaml
 *
 * Notes:
 * - No npm dependency is required.
 * - The hardware schema remains the source of truth.
 * - Defaults are derived from each model's `default_layout` first.
 * - If a chassis has no `default_layout`, the script falls back to the first
 *   deterministic CPM/card tuple from supported hardware.
 */

import fs from "node:fs";
import path from "node:path";

const integratedChassis = new Set(["sr-1", "sr-1s", "ixr-r6", "ixr-ec", "ixr-e2", "ixr-e2c"]);
const redundantIntegratedChassis = new Set(["ixr-r6"]);
const hardwareFields = new Set(["card", "sfm", "xiom", "mda"]);

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : fallback;
}

const repoRoot = process.cwd();
const catalogPath = path.resolve(repoRoot, argValue("--catalog", "releases.yaml"));
const combinedOutputPath = path.resolve(
  repoRoot,
  argValue("--output", "src/data/default-hardware-profiles.yaml")
);

function cleanText(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function isEmptyValue(value) {
  const text = cleanText(value);
  return text === "" || text === "-" || text === "--" || text === "N/A" || text === "n/a";
}

function uniqueSorted(values) {
  const seen = new Set();
  const result = [];
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

function splitValues(value) {
  const text = cleanText(value);
  if (isEmptyValue(text)) return [];

  const parts = [];
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

function clabChassisToken(value) {
  return cleanText(value)
    .replace(/\s*\([^)]*\)\s*$/g, "")
    .replace(/^(?:7250|7450|7705|7750|7950)\s+/i, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();
}

function normalizedRecordValues(field, value) {
  const values = splitValues(value);
  if (field === "chassis") return uniqueSorted(values.map(clabChassisToken));
  if (hardwareFields.has(field) || field.startsWith("mda_")) {
    return uniqueSorted(values.map((item) => cleanText(item).toLowerCase()));
  }
  return uniqueSorted(values);
}

function normalizedRow(record) {
  const row = {};
  for (const field of Object.keys(record).sort()) {
    const values = normalizedRecordValues(field, record[field]);
    if (values.length) row[field] = values;
  }
  return row;
}

function aliasesFromEntry(model, entry) {
  let aliases = [];
  for (const value of entry.supported_values?.chassis ?? []) {
    aliases = aliases.concat(normalizedRecordValues("chassis", value));
  }
  if (aliases.length) return uniqueSorted(aliases);

  for (const source of ["default_layout", "supported_hardware"]) {
    for (const record of entry[source] ?? []) {
      if (record.chassis) aliases = aliases.concat(normalizedRecordValues("chassis", record.chassis));
    }
  }
  return aliases.length ? uniqueSorted(aliases) : uniqueSorted([clabChassisToken(model)]);
}

function rowText(row) {
  const parts = [row.model, row.source];
  for (const field of ["slot", "card", "sfm", "xiom", "mda", "memory"]) {
    parts.push(...(row.values[field] ?? []));
  }
  return parts.join(" ").toLowerCase();
}

function buildMatrix(schema) {
  const built = new Map();

  const ensureEntry = (chassis) => {
    const existing = built.get(chassis);
    if (existing) return existing;
    const next = { chassis, models: [], rows: [], seenRows: new Set() };
    built.set(chassis, next);
    return next;
  };

  for (const [model, entry] of Object.entries(schema.models ?? {}).sort()) {
    const aliases = aliasesFromEntry(model, entry);
    for (const alias of aliases) {
      const target = ensureEntry(alias);
      target.models = uniqueSorted([...target.models, model]);
    }

    for (const source of ["default_layout", "supported_hardware"]) {
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
    .map(({ seenRows, ...entry }) => ({
      ...entry,
      rows: [...entry.rows].sort((a, b) =>
        rowText(a).localeCompare(rowText(b), undefined, { numeric: true, sensitivity: "base" })
      )
    }))
    .sort((a, b) => a.chassis.localeCompare(b.chassis, undefined, { numeric: true, sensitivity: "base" }));
}

function cardLooksCpm(card) {
  const value = String(card ?? "");
  return value.startsWith("cpm") || value.startsWith("cpiom");
}

function splitCardParts(card) {
  const index = card.indexOf("/");
  if (index === -1) return null;
  const cpm = card.slice(0, index);
  const lineCard = card.slice(index + 1);
  return cardLooksCpm(cpm) && lineCard ? [cpm, lineCard] : null;
}

function combinedCardPreserved(entry, card) {
  let alpha = false;
  let numeric = false;
  for (const row of entry?.rows ?? []) {
    if (row.source !== "default_layout" || !(row.values.card ?? []).includes(card)) continue;
    alpha ||= (row.values.slot ?? []).some((slot) => /^[A-Z]$/i.test(slot));
    numeric ||= (row.values.slot ?? []).some((slot) => /^\d+$/.test(slot));
  }
  return alpha && numeric;
}

function roleCardValue(card, entry, role) {
  const parts = splitCardParts(card);
  if (parts && !combinedCardPreserved(entry, card)) return role === "cpm" ? parts[0] : parts[1];
  return card;
}

function rowHasAlphaSlot(row) {
  return (row.values.slot ?? []).some((slot) => /^[AB]$/i.test(slot));
}

function rowHasNumericSlot(row) {
  return (row.values.slot ?? []).some((slot) => /^\d+$/.test(slot));
}

function mdaFields(row) {
  return Object.keys(row.values).filter((field) => field === "mda" || field.startsWith("mda_"));
}

function rowMdaValues(row) {
  return uniqueSorted(mdaFields(row).flatMap((field) => row.values[field] ?? []));
}

function rowHasPayload(row) {
  return Boolean(rowMdaValues(row).length || (row.values.xiom ?? []).length);
}

function rowCpmCards(row, entry) {
  const mode = deploymentMode(entry);
  const values = [];
  for (const card of row.values.card ?? []) {
    const splitForRoles = splitCardParts(card) !== null && !combinedCardPreserved(entry, card);
    if (mode === "standalone" || mode === "integrated_redundant") {
      values.push(roleCardValue(card, entry, "cpm"));
    } else if (rowHasAlphaSlot(row) || splitForRoles || (cardLooksCpm(card) && !rowHasPayload(row))) {
      values.push(roleCardValue(card, entry, "cpm"));
    }
  }
  return uniqueSorted(values);
}

function rowLineCards(row, entry) {
  const mode = deploymentMode(entry);
  if (mode === "standalone" || mode === "integrated_redundant") return [];

  const values = [];
  for (const card of row.values.card ?? []) {
    if (rowHasNumericSlot(row) || rowHasPayload(row) || !cardLooksCpm(card)) {
      values.push(roleCardValue(card, entry, "line"));
    }
  }
  return uniqueSorted(values);
}

function firstAlphaSlot(row) {
  return row?.values.slot?.find((slot) => /^[AB]$/i.test(slot)) ?? "";
}

function firstNumericSlot(row) {
  return row?.values.slot?.find((slot) => /^\d+$/.test(slot)) ?? "";
}

function firstValue(row, field) {
  return row?.values[field]?.[0] ?? "";
}

function entrySlots(entry) {
  return uniqueSorted(
    (entry?.rows ?? [])
      .filter((row) => row.source === "default_layout")
      .flatMap((row) => row.values.slot ?? [])
  );
}

function deploymentMode(entry) {
  const chassis = entry?.chassis ?? "";
  if (redundantIntegratedChassis.has(chassis)) return "integrated_redundant";
  const slots = entrySlots(entry);
  const hasAlphaSlot = slots.some((slot) => /^[A-Z]$/i.test(slot));
  const hasNumericSlot = slots.some((slot) => /^\d+$/.test(slot));
  if (integratedChassis.has(chassis) || (hasAlphaSlot && !hasNumericSlot)) return "standalone";
  return "distributed";
}

function directMdasFromRow(row) {
  const mdas = [];
  for (const field of mdaFields(row)) {
    const slot = field.startsWith("mda_") ? Number(field.slice(4)) : 1;
    for (const type of row.values[field] ?? []) mdas.push({ slot, type });
  }
  return mdas;
}

function componentMdasFromRow(row) {
  const numberedFields = mdaFields(row).filter((field) => field.startsWith("mda_"));
  if (numberedFields.length) return directMdasFromRow(row);

  const type = firstValue(row, "mda");
  return type ? [{ slot: 1, type }] : [];
}

function makeXiom(slot, type, mdaType) {
  return { slot, type, ...(mdaType ? { mda: [{ slot: 1, type: mdaType }] } : {}) };
}

function cpmOptions(entry) {
  const values = [];
  for (const row of entry?.rows ?? []) values.push(...rowCpmCards(row, entry));
  return uniqueSorted(values);
}

function componentTypeOptions(entry) {
  const values = [];
  for (const row of entry?.rows ?? []) values.push(...rowLineCards(row, entry));
  return uniqueSorted(values);
}

function defaultSfmForEntry(entry) {
  const fromDefault = uniqueSorted(
    (entry?.rows ?? [])
      .filter((row) => row.source === "default_layout")
      .flatMap((row) => row.values.sfm ?? [])
  );
  return fromDefault[0] ?? "";
}

function addComponentFactory() {
  const components = [];
  const seen = new Set();
  const seenSlots = new Set();

  function addComponent(component) {
    const key = `${component.slot ?? ""}:${component.type ?? ""}:${JSON.stringify(component.mda ?? [])}:${JSON.stringify(component.xiom ?? [])}`;
    const slotKey = String(component.slot ?? "").trim().toUpperCase();
    if ((!component.type && !component.mda?.length && !component.xiom?.length) || seen.has(key)) return;
    if (slotKey && seenSlots.has(slotKey)) return;
    seen.add(key);
    if (slotKey) seenSlots.add(slotKey);
    components.push(component);
  }

  return { components, addComponent };
}

function defaultComponentsForEntry(entry) {
  if (!entry) return [];

  const { components, addComponent } = addComponentFactory();

  for (const row of entry.rows.filter((candidate) => candidate.source === "default_layout")) {
    if (deploymentMode(entry) === "standalone" || deploymentMode(entry) === "integrated_redundant") {
      const cpmType = rowCpmCards(row, entry)[0];
      const mdas = componentMdasFromRow(row);
      addComponent({
        slot: firstAlphaSlot(row) || "A",
        type: cpmType,
        ...(mdas.length ? { mda: mdas } : {})
      });
      continue;
    }

    for (const type of rowCpmCards(row, entry)) {
      addComponent({ slot: firstAlphaSlot(row) || "A", type });
    }

    for (const type of rowLineCards(row, entry)) {
      const component = {
        slot: firstNumericSlot(row) || "1",
        type
      };
      const xiom = firstValue(row, "xiom");
      const mdas = directMdasFromRow(row);
      if (xiom) {
        component.xiom = [makeXiom(1, xiom, mdas[0]?.type ?? "")];
      } else if (mdas.length) {
        component.mda = mdas;
      }
      addComponent(component);
    }
  }

  if (components.length) return components;

  const cpm = cpmOptions(entry)[0];
  const card = componentTypeOptions(entry)[0];
  return [
    ...(cpm ? [{ slot: "A", type: cpm }] : []),
    ...(card ? [{ slot: 1, type: card }] : [])
  ];
}

function profileForEntry(entry) {
  const sfm = defaultSfmForEntry(entry);
  return {
    model: entry.models[0] ?? "",
    deployment: deploymentMode(entry),
    ...(sfm ? { sfm } : {}),
    components: defaultComponentsForEntry(entry)
  };
}

function parseReleaseCatalog(yamlText) {
  const releases = [];
  const blocks = yamlText
    .split(/\n(?=\s*-\s+id:\s+)/)
    .map((block) => block.trim())
    .filter((block) => block.startsWith("- id:"));

  for (const block of blocks) {
    const valueFor = (key) => {
      const match = block.match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m"));
      if (!match) return "";
      return match[1].replace(/^["']|["']$/g, "");
    };

    const id = valueFor("id");
    const schemaOutput = valueFor("schema_output");
    if (!id || !schemaOutput) continue;

    releases.push({
      id,
      label: valueFor("label") || id,
      default: valueFor("default") === "true",
      platform: valueFor("platform") || "srsim",
      platform_label: valueFor("platform_label") || valueFor("label") || id,
      containerlab_kind: valueFor("containerlab_kind") || "nokia_srsim",
      eda_default_version: valueFor("eda_default_version"),
      schema_output: schemaOutput
    });
  }

  return releases;
}

function yamlScalar(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = String(value);
  if (text === "") return '""';
  if (/^[A-Za-z0-9._/+:-]+$/.test(text) && !/^(true|false|null|yes|no|on|off)$/i.test(text)) {
    return text;
  }
  return JSON.stringify(text);
}

function yamlKey(key) {
  const text = String(key);
  if (/^[A-Za-z_][A-Za-z0-9._/-]*$/.test(text) && !/^(true|false|null|yes|no|on|off)$/i.test(text)) {
    return text;
  }
  return JSON.stringify(text);
}

function toYaml(value, indent = 0) {
  const pad = " ".repeat(indent);

  if (Array.isArray(value)) {
    if (!value.length) return `${pad}[]`;
    return value
      .map((item) => {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const entries = Object.entries(item).filter(([, entryValue]) => entryValue !== undefined);
          if (!entries.length) return `${pad}- {}`;
          const [firstKey, firstValue] = entries[0];
          const first =
            firstValue && typeof firstValue === "object"
              ? `${pad}- ${firstKey}:\n${toYaml(firstValue, indent + 4)}`
              : `${pad}- ${firstKey}: ${yamlScalar(firstValue)}`;
          const rest = entries
            .slice(1)
            .map(([key, entryValue]) =>
              entryValue && typeof entryValue === "object"
                ? `${pad}  ${key}:\n${toYaml(entryValue, indent + 4)}`
                : `${pad}  ${key}: ${yamlScalar(entryValue)}`
            );
          return [first, ...rest].join("\n");
        }

        if (Array.isArray(item)) return `${pad}-\n${toYaml(item, indent + 2)}`;
        return `${pad}- ${yamlScalar(item)}`;
      })
      .join("\n");
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined);
    if (!entries.length) return `${pad}{}`;
    return entries
      .map(([key, entryValue]) =>
        entryValue && typeof entryValue === "object"
          ? `${pad}${yamlKey(key)}:\n${toYaml(entryValue, indent + 2)}`
          : `${pad}${yamlKey(key)}: ${yamlScalar(entryValue)}`
      )
      .join("\n");
  }

  return `${pad}${yamlScalar(value)}`;
}

function buildReleaseDefaults(release) {
  const schemaPath = path.resolve(repoRoot, release.schema_output);
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Schema file not found for release ${release.id}: ${release.schema_output}`);
  }

  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const matrix = buildMatrix(schema);
  const chassisDefaults = {};

  for (const entry of matrix) {
    const profile = profileForEntry(entry);
    if (!profile.components.length) continue;
    chassisDefaults[entry.chassis] = profile;
  }

  return {
    id: release.id,
    label: schema.release_label || release.label,
    default: release.default,
    platform: release.platform,
    platform_label: release.platform_label,
    containerlab_kind: schema.containerlab_kind || release.containerlab_kind,
    eda_default_version: release.eda_default_version,
    schema_output: release.schema_output,
    chassis_defaults: chassisDefaults
  };
}

function writeYamlFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const banner = [
    "# Generated by scripts/build-default-hardware-profiles.mjs.",
    "# Do not edit manually.",
    "# Source of truth: releases.yaml + generated srsim-supported-hardware.json schemas.",
    ""
  ].join("\n");
  fs.writeFileSync(filePath, `${banner}${toYaml(data)}\n`, "utf8");
}

if (!fs.existsSync(catalogPath)) {
  throw new Error(`Release catalog not found: ${catalogPath}`);
}

const releases = parseReleaseCatalog(fs.readFileSync(catalogPath, "utf8"));
if (!releases.length) {
  throw new Error(`No releases found in ${catalogPath}`);
}

const combined = {
  generated_from: path.relative(repoRoot, catalogPath),
  releases: {}
};

for (const release of releases) {
  const defaults = buildReleaseDefaults(release);
  combined.releases[release.id] = defaults;

  const perReleaseOutput = path.resolve(
    repoRoot,
    path.dirname(release.schema_output),
    "default-hardware-profiles.yaml"
  );
  writeYamlFile(perReleaseOutput, {
    generated_from: release.schema_output,
    release: defaults
  });

  console.log(`wrote ${path.relative(repoRoot, perReleaseOutput)}`);
}

writeYamlFile(combinedOutputPath, combined);
console.log(`wrote ${path.relative(repoRoot, combinedOutputPath)}`);

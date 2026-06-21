#!/usr/bin/env node
/**
 * Generate default Containerlab hardware profiles from srsim-hw-schema release schemas.
 *
 * Outputs:
 *   - releases/<release-id>/default-hardware-profiles.yaml
 *   - src/data/default-hardware-profiles.yaml
 */

import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : fallback;
}

const catalogPath = path.resolve(repoRoot, argValue("--catalog", "releases.yaml"));
const combinedOutputPath = path.resolve(repoRoot, argValue("--output", "src/data/default-hardware-profiles.yaml"));

function cleanText(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function splitValues(value) {
  const text = cleanText(value);
  if (!text || text === "-" || text === "--" || text.toLowerCase() === "n/a") return [];

  const values = [];
  for (const line of text.split("\n")) {
    for (const part of line.split(/\s+\bor\b\s+/i)) {
      const next = cleanText(part);
      if (next && next.toLowerCase() !== "or") values.push(next);
    }
  }
  return uniqueSorted(values.length ? values : [text]);
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
  return result.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

function clabChassisToken(value) {
  return cleanText(value)
    .replace(/\s*\([^)]*\)\s*$/g, "")
    .replace(/^(?:7250|7450|7705|7750|7950)\s+/i, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();
}

function hardwareValues(field, value) {
  const values = splitValues(value);
  if (field === "chassis") return uniqueSorted(values.map(clabChassisToken));
  if (["card", "sfm", "xiom", "mda"].includes(field) || field.startsWith("mda_")) {
    return uniqueSorted(values.map((item) => cleanText(item).toLowerCase()));
  }
  return uniqueSorted(values);
}

function firstHardwareValue(record, field) {
  return hardwareValues(field, record?.[field])[0] ?? "";
}

function cardLooksCpm(card) {
  return String(card ?? "").startsWith("cpm") || String(card ?? "").startsWith("cpiom");
}

function splitCardPair(card) {
  const index = String(card).indexOf("/");
  if (index === -1) return null;
  const cpm = card.slice(0, index);
  const lineCard = card.slice(index + 1);
  return cardLooksCpm(cpm) && lineCard ? [cpm, lineCard] : null;
}

function slotRank(slot) {
  const value = String(slot ?? "").toUpperCase();
  if (value === "A") return 0;
  if (value === "B") return 1;
  if (/^\d+$/.test(value)) return 100 + Number(value);
  return 1000;
}

function sortComponents(components) {
  return components.sort((a, b) => {
    const slotCompare = slotRank(a.slot) - slotRank(b.slot);
    if (slotCompare) return slotCompare;
    return String(a.type ?? "").localeCompare(String(b.type ?? ""), undefined, {
      numeric: true,
      sensitivity: "base"
    });
  });
}

function addComponent(components, seen, component) {
  if (!component?.type && !component?.mda?.length && !component?.xiom?.length) return;
  const key = JSON.stringify(component);
  if (seen.has(key)) return;
  seen.add(key);
  components.push(component);
}

function mdasFromRecord(record) {
  const mdas = [];
  for (const field of Object.keys(record ?? {}).filter((key) => key === "mda" || key.startsWith("mda_")).sort()) {
    const slot = field.startsWith("mda_") ? Number(field.slice(4)) : 1;
    for (const type of hardwareValues(field, record[field])) {
      mdas.push({ slot, type });
    }
  }
  return mdas;
}

function componentsFromDefaultLayout(defaultLayout) {
  const components = [];
  const seen = new Set();

  for (const record of defaultLayout ?? []) {
    const slot = firstHardwareValue(record, "slot");
    const mdas = mdasFromRecord(record);
    const xiom = firstHardwareValue(record, "xiom");

    for (const card of hardwareValues("card", record.card)) {
      const pair = splitCardPair(card);
      if (pair) {
        addComponent(components, seen, { slot: "A", type: pair[0] });
        addComponent(components, seen, { slot: "1", type: pair[1] });
        continue;
      }

      const component = {
        slot: slot || (cardLooksCpm(card) ? "A" : "1"),
        type: card
      };

      if (xiom) {
        component.xiom = [{
          slot: 1,
          type: xiom,
          ...(mdas[0]?.type ? { mda: [{ slot: 1, type: mdas[0].type }] } : {})
        }];
      } else if (mdas.length) {
        component.mda = mdas;
      }

      addComponent(components, seen, component);
    }
  }

  return sortComponents(components);
}

function fallbackComponents(entry) {
  const components = [];
  const seen = new Set();
  const cards = hardwareValues("card", entry.supported_values?.card ?? []);
  const pair = cards.map(splitCardPair).find(Boolean);

  if (pair) {
    addComponent(components, seen, { slot: "A", type: pair[0] });
    addComponent(components, seen, { slot: "1", type: pair[1] });
  } else {
    const cpm = cards.find((card) => cardLooksCpm(card) && !card.includes("/"));
    const lineCard = cards.find((card) => !cardLooksCpm(card) && !card.includes("/"));
    if (cpm) addComponent(components, seen, { slot: "A", type: cpm });
    if (lineCard) addComponent(components, seen, { slot: "1", type: lineCard });
  }

  return sortComponents(components);
}

function chassisAliases(model, entry) {
  let aliases = [];
  for (const chassis of entry.supported_values?.chassis ?? []) {
    aliases = aliases.concat(hardwareValues("chassis", chassis));
  }

  if (!aliases.length) {
    for (const source of ["default_layout", "supported_hardware"]) {
      for (const record of entry[source] ?? []) {
        aliases = aliases.concat(hardwareValues("chassis", record.chassis));
      }
    }
  }

  return aliases.length ? uniqueSorted(aliases) : uniqueSorted([clabChassisToken(model)]);
}

function defaultSfm(defaultLayout) {
  return uniqueSorted((defaultLayout ?? []).flatMap((record) => hardwareValues("sfm", record.sfm)))[0] ?? "";
}

function deploymentMode(components) {
  const slots = components.map((component) => String(component.slot ?? ""));
  const hasAlpha = slots.some((slot) => /^[AB]$/i.test(slot));
  const hasNumeric = slots.some((slot) => /^\d+$/.test(slot));
  return hasAlpha && hasNumeric ? "distributed" : "standalone";
}

function profileForModel(model, entry) {
  const components = componentsFromDefaultLayout(entry.default_layout ?? []);
  const resolvedComponents = components.length ? components : fallbackComponents(entry);
  const sfm = defaultSfm(entry.default_layout ?? []);

  return {
    model,
    deployment: deploymentMode(resolvedComponents),
    ...(sfm ? { sfm } : {}),
    components: resolvedComponents
  };
}

function unquote(value) {
  return String(value ?? "").trim().replace(/^["']|["']$/g, "");
}

function parseReleaseCatalog(text) {
  const releases = [];
  let current = null;

  const flush = () => {
    if (current?.id && current?.schema_output) releases.push(current);
    current = null;
  };

  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const idMatch = line.match(/^\s*-\s+id:\s*(.+?)\s*$/);
    if (idMatch) {
      flush();
      current = { id: unquote(idMatch[1]) };
      continue;
    }

    if (!current) continue;
    const match = line.match(/^\s+([A-Za-z0-9_]+):\s*(.*?)\s*$/);
    if (!match) continue;
    current[match[1]] = unquote(match[2]);
  }

  flush();

  return releases.map((release) => ({
    id: release.id,
    label: release.label || release.id,
    default: release.default === "true",
    platform: release.platform || "srsim",
    platform_label: release.platform_label || release.label || release.id,
    containerlab_kind: release.containerlab_kind || "nokia_srsim",
    eda_default_version: release.eda_default_version || "",
    schema_output: release.schema_output
  }));
}

function yamlScalar(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = String(value);
  if (!text) return '""';
  if (/^[A-Za-z0-9._/+:-]+$/.test(text) && !/^(true|false|null|yes|no|on|off)$/i.test(text)) return text;
  return JSON.stringify(text);
}

function yamlKey(key) {
  const text = String(key);
  if (/^[A-Za-z_][A-Za-z0-9._/-]*$/.test(text) && !/^(true|false|null|yes|no|on|off)$/i.test(text)) return text;
  return JSON.stringify(text);
}

function toYaml(value, indent = 0) {
  const pad = " ".repeat(indent);

  if (Array.isArray(value)) {
    if (!value.length) return `${pad}[]`;
    return value.map((item) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const entries = Object.entries(item).filter(([, entryValue]) => entryValue !== undefined);
        const [firstKey, firstValue] = entries[0];
        const first = firstValue && typeof firstValue === "object"
          ? `${pad}- ${yamlKey(firstKey)}:\n${toYaml(firstValue, indent + 4)}`
          : `${pad}- ${yamlKey(firstKey)}: ${yamlScalar(firstValue)}`;
        const rest = entries.slice(1).map(([key, entryValue]) => entryValue && typeof entryValue === "object"
          ? `${pad}  ${yamlKey(key)}:\n${toYaml(entryValue, indent + 4)}`
          : `${pad}  ${yamlKey(key)}: ${yamlScalar(entryValue)}`);
        return [first, ...rest].join("\n");
      }
      return `${pad}- ${yamlScalar(item)}`;
    }).join("\n");
  }

  if (value && typeof value === "object") {
    return Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .map(([key, entryValue]) => entryValue && typeof entryValue === "object"
        ? `${pad}${yamlKey(key)}:\n${toYaml(entryValue, indent + 2)}`
        : `${pad}${yamlKey(key)}: ${yamlScalar(entryValue)}`)
      .join("\n");
  }

  return `${pad}${yamlScalar(value)}`;
}

function buildReleaseDefaults(release) {
  const schemaPath = path.resolve(repoRoot, release.schema_output);
  if (!fs.existsSync(schemaPath)) throw new Error(`Schema file not found for release ${release.id}: ${release.schema_output}`);

  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const chassisDefaults = {};

  for (const [model, entry] of Object.entries(schema.models ?? {}).sort()) {
    const profile = profileForModel(model, entry);
    if (!profile.components.length) continue;
    for (const chassis of chassisAliases(model, entry)) chassisDefaults[chassis] ??= profile;
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

function writeYaml(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const banner = [
    "# Generated by scripts/build-default-hardware-profiles.mjs.",
    "# Do not edit manually.",
    "# Source of truth: releases.yaml + generated srsim-supported-hardware.json schemas.",
    ""
  ].join("\n");
  fs.writeFileSync(filePath, `${banner}${toYaml(data)}\n`, "utf8");
}

if (!fs.existsSync(catalogPath)) throw new Error(`Release catalog not found: ${catalogPath}`);

const releases = parseReleaseCatalog(fs.readFileSync(catalogPath, "utf8"));
if (!releases.length) throw new Error(`No releases found in ${catalogPath}`);

const combined = { generated_from: path.relative(repoRoot, catalogPath), releases: {} };

for (const release of releases) {
  const defaults = buildReleaseDefaults(release);
  combined.releases[release.id] = defaults;

  const perReleaseOutput = path.resolve(repoRoot, path.dirname(release.schema_output), "default-hardware-profiles.yaml");
  writeYaml(perReleaseOutput, { generated_from: release.schema_output, release: defaults });
  console.log(`wrote ${path.relative(repoRoot, perReleaseOutput)}`);
}

writeYaml(combinedOutputPath, combined);
console.log(`wrote ${path.relative(repoRoot, combinedOutputPath)}`);

import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import YAML from "yaml";

import clabSchemaData from "./data/clab.schema.json";
import srsimSchemaData from "./data/srsim-hw.schema.json";
import {
  canonicalToken,
  cleanText,
  isEmptyValue,
  splitValues
} from "./matrix";
import type {
  HardwareModelEntry,
  HardwareSchema,
  RawHardwareRecord,
  ValidationIssue,
  ValidationReport
} from "./types";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

let compiledValidator: ValidateFunction | null = null;

function clabValidator(): ValidateFunction {
  if (compiledValidator) return compiledValidator;

  const clabSchema = clabSchemaData as Record<string, unknown>;
  const clabDefinitions = asRecord(clabSchema.definitions) ?? {};
  const srsimSchema = structuredClone(srsimSchemaData) as Record<string, unknown>;
  const srsimDefinitions = asRecord(srsimSchema.definitions) ?? {};

  // The generated sidecar references the containerlab env definition locally.
  // Add it before compiling so browser validation can resolve every local ref.
  if (!("env" in srsimDefinitions) && "env" in clabDefinitions) {
    srsimDefinitions.env = clabDefinitions.env;
    srsimSchema.definitions = srsimDefinitions;
  }

  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    verbose: true
  });
  ajv.addSchema(srsimSchema);
  compiledValidator = ajv.compile(clabSchema);
  return compiledValidator;
}

function formatAjvError(error: ErrorObject): ValidationIssue {
  const path = error.instancePath || "/";
  const label = error.params && "missingProperty" in error.params
    ? `${path}/${String(error.params.missingProperty)}`
    : path;
  return {
    source: "schema",
    path: label.replace(/\/+/g, "/"),
    message: error.message ?? `schema validation failed at ${label}`
  };
}

function filterSchemaIssues(issues: ValidationIssue[]): ValidationIssue[] {
  const filtered = issues.filter((issue) => {
    if (issue.path?.startsWith("/topology/nodes/") && issue.message === "must be null") {
      return false;
    }
    if (issue.path?.startsWith("/topology/nodes/") && issue.message.includes('must match "then" schema')) {
      return false;
    }
    return true;
  });
  return filtered.length ? filtered : issues;
}

function findModel(schema: HardwareSchema, model: string): [string, HardwareModelEntry] | null {
  const wanted = canonicalToken(model);
  for (const [name, entry] of Object.entries(schema.models ?? {})) {
    if (canonicalToken(name) === wanted) return [name, entry];
    const chassisValues = entry.supported_values?.chassis ?? [];
    if (chassisValues.some((value) => canonicalToken(value) === wanted)) {
      return [name, entry];
    }
  }
  return null;
}

function recordMatchesTopology(record: RawHardwareRecord, criteria: Record<string, string>): boolean {
  for (const [field, expected] of Object.entries(criteria)) {
    if (!expected || !(field in record)) continue;
    const values = new Set(splitValues(record[field]).map(canonicalToken));
    if (!values.has(canonicalToken(expected))) return false;
  }
  return true;
}

function matchingRows(rows: RawHardwareRecord[] | undefined, criteria: Record<string, string>): RawHardwareRecord[] {
  return (rows ?? []).filter((row) => recordMatchesTopology(row, criteria));
}

function missingRequiredFields(matches: RawHardwareRecord[], criteria: Record<string, string>): Set<string> {
  const topologyFields = new Set(["card", "sfm", "xiom", "mda"]);
  const missing = new Set<string>();
  for (const row of matches) {
    for (const [field, value] of Object.entries(row)) {
      if (!topologyFields.has(field) || field in criteria || isEmptyValue(value)) continue;
      missing.add(field);
    }
  }
  return missing;
}

function cleanCriteria(criteria: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(criteria)
      .map(([key, value]) => [key, cleanText(value)] as const)
      .filter(([, value]) => value.length > 0)
  );
}

function validateCriteria(params: {
  schema: HardwareSchema;
  nodeName: string;
  location: string;
  modelName: string;
  criteria: Record<string, string>;
  strict: boolean;
}): ValidationIssue[] {
  const { schema, nodeName, location, modelName, strict } = params;
  const modelMatch = findModel(schema, modelName);
  if (!modelMatch) {
    return [{ source: "hardware", message: `${nodeName}: model/chassis not found: ${modelName}` }];
  }

  const [, model] = modelMatch;
  const criteria = cleanCriteria(params.criteria);
  const supportedMatches = matchingRows(model.supported_hardware, criteria);
  const defaultMatches = matchingRows(model.default_layout, criteria);
  const matches = [...supportedMatches, ...defaultMatches];

  if (!matches.length) {
    return [
      {
        source: "hardware",
        path: location,
        message: `unsupported tuple ${JSON.stringify(criteria)}`
      }
    ];
  }

  if (strict && supportedMatches.length && !defaultMatches.length) {
    const missing = missingRequiredFields(supportedMatches, criteria);
    if (missing.size) {
      return [
        {
          source: "hardware",
          path: location,
          message: `missing required field(s): ${[...missing].sort().join(", ")}; tuple ${JSON.stringify(criteria)}`
        }
      ];
    }
  }

  return [];
}

function asList(value: unknown, label: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  throw new Error(`${label} expected list, got ${Array.isArray(value) ? "array" : typeof value}`);
}

function componentName(nodeName: string, slot: unknown): string {
  return `${nodeName}[slot=${slot === undefined || slot === null ? "?" : String(slot)}]`;
}

function validateComponent(params: {
  schema: HardwareSchema;
  nodeName: string;
  chassis: string;
  component: Record<string, unknown>;
  strict: boolean;
}): ValidationIssue[] {
  const { schema, nodeName, chassis, component, strict } = params;
  const slot = component.slot;
  const location = componentName(nodeName, slot);
  const base = {
    chassis,
    slot: slot === undefined || slot === null ? "" : String(slot),
    sfm: String(component.sfm ?? ""),
    card: String(component.type ?? "")
  };

  let xioms: unknown[];
  let mdas: unknown[];
  try {
    xioms = asList(component.xiom, "XIOM");
    mdas = asList(component.mda, "MDA");
  } catch (error) {
    return [{ source: "hardware", path: location, message: (error as Error).message }];
  }

  if (!xioms.length && !mdas.length) {
    return validateCriteria({ schema, nodeName, location, modelName: chassis, criteria: base, strict });
  }

  const issues: ValidationIssue[] = [];
  for (const mda of mdas) {
    const mdaRecord = asRecord(mda);
    if (!mdaRecord) {
      issues.push({ source: "hardware", path: location, message: "MDA entries must be mappings" });
      continue;
    }
    issues.push(
      ...validateCriteria({
        schema,
        nodeName,
        location: `${location}.mda[${String(mdaRecord.slot ?? "?")}]`,
        modelName: chassis,
        criteria: { ...base, mda: String(mdaRecord.type ?? "") },
        strict
      })
    );
  }

  for (const xiom of xioms) {
    const xiomRecord = asRecord(xiom);
    if (!xiomRecord) {
      issues.push({ source: "hardware", path: location, message: "XIOM entries must be mappings" });
      continue;
    }

    let xiomMdas: unknown[];
    try {
      xiomMdas = asList(xiomRecord.mda, "mda");
    } catch (error) {
      issues.push({
        source: "hardware",
        path: `${location}.xiom[${String(xiomRecord.slot ?? "?")}]`,
        message: (error as Error).message
      });
      continue;
    }

    const xiomBase = { ...base, xiom: String(xiomRecord.type ?? "") };
    if (!xiomMdas.length) {
      issues.push(
        ...validateCriteria({
          schema,
          nodeName,
          location: `${location}.xiom[${String(xiomRecord.slot ?? "?")}]`,
          modelName: chassis,
          criteria: xiomBase,
          strict
        })
      );
      continue;
    }

    for (const mda of xiomMdas) {
      const mdaRecord = asRecord(mda);
      if (!mdaRecord) {
        issues.push({
          source: "hardware",
          path: `${location}.xiom[${String(xiomRecord.slot ?? "?")}]`,
          message: "MDA entries must be mappings"
        });
        continue;
      }
      issues.push(
        ...validateCriteria({
          schema,
          nodeName,
          location: `${location}.xiom[${String(xiomRecord.slot ?? "?")}].mda[${String(mdaRecord.slot ?? "?")}]`,
          modelName: chassis,
          criteria: { ...xiomBase, mda: String(mdaRecord.type ?? "") },
          strict
        })
      );
    }
  }

  return issues;
}

export function validateSrsimHardware(topology: unknown, schema: HardwareSchema, strict = true): ValidationIssue[] {
  const root = asRecord(topology);
  const topologyRecord = root ? asRecord(root.topology) : null;
  const nodes = topologyRecord ? asRecord(topologyRecord.nodes) : null;
  if (!nodes) {
    return [{ source: "hardware", path: "/topology/nodes", message: "expected topology.nodes mapping" }];
  }

  const issues: ValidationIssue[] = [];
  for (const [nodeName, nodeValue] of Object.entries(nodes)) {
    const node = asRecord(nodeValue);
    if (!node || node.kind !== "nokia_srsim") continue;

    if (!("components" in node)) continue;
    const chassis = String(node.type ?? "");
    if (!chassis) {
      issues.push({
        source: "hardware",
        path: `/topology/nodes/${nodeName}/type`,
        message: `${nodeName}: nokia_srsim node with components requires a type/chassis`
      });
      continue;
    }

    let components: unknown[];
    try {
      components = asList(node.components, "components");
    } catch (error) {
      issues.push({
        source: "hardware",
        path: `/topology/nodes/${nodeName}/components`,
        message: `${nodeName}: ${(error as Error).message}`
      });
      continue;
    }

    for (const component of components) {
      const componentRecord = asRecord(component);
      if (!componentRecord) {
        issues.push({
          source: "hardware",
          path: `/topology/nodes/${nodeName}/components`,
          message: `${nodeName}: component entries must be mappings`
        });
        continue;
      }
      issues.push(...validateComponent({ schema, nodeName, chassis, component: componentRecord, strict }));
    }
  }

  return issues;
}

export function validateTopologyYaml(yamlText: string, hardwareSchema: HardwareSchema): ValidationReport {
  const document = YAML.parseDocument(yamlText, { prettyErrors: true });
  if (document.errors.length) {
    const issues = document.errors.map((error) => ({
      source: "yaml" as const,
      message: error.message
    }));
    return { valid: false, issues };
  }

  const parsed = document.toJSON();
  const validate = clabValidator();
  const schemaValid = validate(parsed);
  const schemaIssues = schemaValid ? [] : filterSchemaIssues((validate.errors ?? []).map(formatAjvError));
  const hardwareIssues = validateSrsimHardware(parsed, hardwareSchema, true);
  const issues = [...schemaIssues, ...hardwareIssues];

  return {
    valid: issues.length === 0,
    parsed,
    issues
  };
}

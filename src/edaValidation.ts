import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import YAML from "yaml";

import {
  edaComponentTypeOptions,
  edaConnectorTypesForChassis,
  edaHasPowerProfileForChassis,
  edaPowerSlotsForChassis,
  edaPowerTypesForChassis
} from "./edaComponents";
import { buildMatrix, clabChassisToken } from "./matrix";
import type { EdaTopoNodeComponent, EdaYangCatalog, HardwareSchema, MatrixEntry, ValidationIssue, ValidationReport } from "./types";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const componentKinds = ["controlCard", "lineCard", "fabric", "mda", "connector", "xiom", "powerShelf", "powerModule"];

const topoNodeSchema = {
  type: "object",
  required: ["apiVersion", "kind", "metadata", "spec"],
  properties: {
    apiVersion: { const: "core.eda.nokia.com/v1" },
    kind: { const: "TopoNode" },
    metadata: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1 },
        namespace: { type: "string" }
      }
    },
    spec: {
      type: "object",
      required: ["nodeProfile", "operatingSystem", "platform", "version"],
      properties: {
        nodeProfile: { type: "string", minLength: 1 },
        operatingSystem: { enum: ["srl", "sros", "eos", "sonic", "ios-xr", "nxos"] },
        platform: { type: "string", minLength: 1 },
        version: { type: "string", minLength: 1 },
        component: {
          type: "array",
          items: {
            type: "object",
            required: ["kind", "type"],
            properties: {
              kind: { enum: componentKinds },
              slot: { type: "string" },
              type: { type: "string", minLength: 1 }
            }
          }
        }
      }
    }
  }
};

let topoNodeValidator: ValidateFunction | null = null;

function validateTopoNodeSchema(value: unknown): ErrorObject[] {
  if (!topoNodeValidator) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    topoNodeValidator = ajv.compile(topoNodeSchema);
  }
  return topoNodeValidator(value) ? [] : [...(topoNodeValidator.errors ?? [])];
}

function formatAjvError(error: ErrorObject, docIndex: number): ValidationIssue {
  const path = error.instancePath || "/";
  const label = error.params && "missingProperty" in error.params
    ? `${path}/${String(error.params.missingProperty)}`
    : path;
  return {
    source: "schema",
    path: `document ${docIndex + 1}${label.replace(/\/+/g, "/")}`,
    message: error.message ?? `schema validation failed at ${label}`
  };
}

function entryForPlatform(schema: HardwareSchema, platform: string): MatrixEntry | undefined {
  const matrix = buildMatrix(schema);
  const token = clabChassisToken(platform);
  return matrix.find((entry) =>
    entry.chassis === token ||
    entry.models.some((model) => model.toLowerCase() === platform.toLowerCase())
  );
}

function validatePowerComponent(
  component: EdaTopoNodeComponent,
  entry: MatrixEntry,
  catalog: EdaYangCatalog,
  path: string
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const kind = component.kind as "powerShelf" | "powerModule";
  const label = kind === "powerShelf" ? "power shelf" : "power module";
  if (!edaHasPowerProfileForChassis(catalog, entry.chassis)) return issues;

  const slots = edaPowerSlotsForChassis(catalog, entry.chassis, kind);
  const types = edaPowerTypesForChassis(catalog, entry.chassis, kind);

  if (!slots.length) {
    issues.push({ source: "hardware", path, message: `${entry.chassis} has no supported EDA ${label} profile` });
  } else if (!slots.includes(component.slot)) {
    issues.push({ source: "hardware", path: `${path}/slot`, message: `${entry.chassis} ${label} slot must be ${slots.join(", ")}` });
  }

  if (types.length && !types.includes(component.type)) {
    issues.push({ source: "hardware", path: `${path}/type`, message: `${entry.chassis} ${label} type must be ${types.join(", ")}` });
  }

  return issues;
}

function validateTopoNodeHardware(document: Record<string, unknown>, schema: HardwareSchema, catalog: EdaYangCatalog, docIndex: number): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const spec = asRecord(document.spec) ?? {};
  if (spec.operatingSystem !== "sros") return issues;

  const entry = entryForPlatform(schema, String(spec.platform ?? ""));
  if (!entry) {
    issues.push({
      source: "hardware",
      path: `document ${docIndex + 1}/spec/platform`,
      message: `unsupported SR-SIM platform ${String(spec.platform ?? "")}`
    });
    return issues;
  }

  const components = Array.isArray(spec.component) ? spec.component : [];
  components.forEach((item, index) => {
    const component = asRecord(item) as unknown as EdaTopoNodeComponent | null;
    if (!component) return;
    const path = `document ${docIndex + 1}/spec/component/${index}`;

    if (component.kind === "connector") {
      const connectorTypes = edaConnectorTypesForChassis(catalog, entry.chassis);
      if (connectorTypes.length && !connectorTypes.includes(component.type)) {
        issues.push({ source: "hardware", path: `${path}/type`, message: `${entry.chassis} connector type must be ${connectorTypes.join(", ")}` });
      }
      return;
    }

    if (component.kind === "powerShelf" || component.kind === "powerModule") {
      issues.push(...validatePowerComponent(component, entry, catalog, path));
      return;
    }

    const options = edaComponentTypeOptions(catalog, component);
    if (options.length && !options.includes(component.type)) {
      issues.push({ source: "hardware", path: `${path}/type`, message: `${component.type} is not in the SR OS 26.3 YANG typedefs for ${component.kind}` });
    }
  });
  return issues;
}

export function validateEdaYaml(yamlText: string, schema: HardwareSchema, catalog: EdaYangCatalog): ValidationReport {
  let docs: YAML.Document[];
  try {
    const parsed = YAML.parseAllDocuments(yamlText);
    docs = Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return { valid: false, issues: [{ source: "yaml", message: error instanceof Error ? error.message : String(error) }] };
  }

  const issues: ValidationIssue[] = [];
  const values: Record<string, unknown>[] = [];
  docs.forEach((doc, index) => {
    if (doc.errors.length) {
      for (const error of doc.errors) {
        issues.push({ source: "yaml", path: `document ${index + 1}`, message: error.message });
      }
      return;
    }
    const value = asRecord(doc.toJSON());
    if (!value) {
      issues.push({ source: "schema", path: `document ${index + 1}`, message: "EDA YAML document must be an object" });
      return;
    }
    values.push(value);
  });

  values.forEach((value, index) => {
    if (value.apiVersion === "core.eda.nokia.com/v1" && value.kind === "TopoNode") {
      issues.push(...validateTopoNodeSchema(value).map((error) => formatAjvError(error, index)));
      issues.push(...validateTopoNodeHardware(value, schema, catalog, index));
      return;
    }

    issues.push({
      source: "schema",
      path: `document ${index + 1}`,
      message: `unsupported EDA resource ${String(value.apiVersion ?? "?")}/${String(value.kind ?? "?")}`
    });
  });

  if (!values.some((value) => value.apiVersion === "core.eda.nokia.com/v1" && value.kind === "TopoNode")) {
    issues.push({ source: "schema", message: "EDA YAML must include a TopoNode resource" });
  }

  return {
    valid: issues.length === 0,
    parsed: values,
    issues
  };
}

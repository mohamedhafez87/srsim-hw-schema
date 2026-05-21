import assert from "node:assert/strict";
import { describe, it } from "node:test";

import hardwareData from "../srsim-supported-hardware.json";
import edaCatalogData from "./data/eda-yang-catalog.json";
import { buildEdaTopoNodeYaml, defaultEdaVersion, normalizeEdaConfig } from "./edaComponents";
import { buildMatrix, defaultComponentsForEntry, defaultSfmForEntry, getEntry } from "./matrix";
import type { EdaYangCatalog, HardwareSchema, SrsimConfig } from "./types";
import { validateEdaYaml } from "./edaValidation";

const hardware = hardwareData as HardwareSchema;
const catalog = edaCatalogData as EdaYangCatalog;

function defaultConfig(chassis: string): SrsimConfig {
  const entry = getEntry(buildMatrix(hardware), chassis);
  return normalizeEdaConfig({
    labName: "srsim-lab",
    nodeName: "sros1",
    chassis,
    sfm: defaultSfmForEntry(entry),
    components: defaultComponentsForEntry(entry),
    edaNamespace: "eda",
    edaNodeProfile: "",
    edaVersion: defaultEdaVersion,
    edaComponents: []
  }, catalog);
}

describe("EDA validation", () => {
  it("validates generated TopoNode resources", () => {
    const yaml = buildEdaTopoNodeYaml(defaultConfig("sr-2s"), getEntry(buildMatrix(hardware), "sr-2s"));
    const report = validateEdaYaml(yaml, hardware, catalog);

    assert.equal(report.valid, true);
    assert.deepEqual(report.issues, []);
  });

  it("validates generated SR-1se TopoNodes with split EDA card role types", () => {
    const yaml = buildEdaTopoNodeYaml(defaultConfig("sr-1se"), getEntry(buildMatrix(hardware), "sr-1se"));
    const report = validateEdaYaml(yaml, hardware, catalog);

    assert.equal(report.valid, true);
    assert.deepEqual(report.issues, []);
    assert.ok(yaml.includes("type: cpm-1se"));
    assert.ok(yaml.includes("type: imm36-800g-qsfpdd"));
    assert.equal(yaml.includes("type: cpm-1se/imm36-800g-qsfpdd"), false);
  });

  it("rejects Component CR documents", () => {
    const yaml = `${buildEdaTopoNodeYaml(defaultConfig("sr-2s"), getEntry(buildMatrix(hardware), "sr-2s"))}---
apiVersion: components.eda.nokia.com/v2
kind: Component
metadata:
  name: sros1-fantray-1
spec:
  node: sros1
  slot: "1"
  type: FanTray
`;
    const report = validateEdaYaml(yaml, hardware, catalog);

    assert.equal(report.valid, false);
    assert.ok(report.issues.some((issue) => issue.source === "schema" && issue.message.includes("unsupported EDA resource components.eda.nokia.com/v2/Component")));
  });

  it("rejects invalid EDA component schema and unsupported profiled power slots", () => {
    const yaml = buildEdaTopoNodeYaml(defaultConfig("sr-2s"), getEntry(buildMatrix(hardware), "sr-2s"))
      .replace("  component:\n", `  component:
    - kind: fanTray
      slot: "1"
      type: ps-a4-shelf-dc
    - kind: powerModule
      slot: 3-1
      type: ps-a-dc-6000
`);
    const report = validateEdaYaml(yaml, hardware, catalog);

    assert.equal(report.valid, false);
    assert.ok(report.issues.some((issue) => issue.source === "schema" && issue.message.includes("must be equal to one of the allowed values")));
    assert.ok(report.issues.some((issue) => issue.source === "hardware" && issue.message.includes("power module slot must be")));
  });

  it("allows free power inventory values when no chassis power profile is known", () => {
    const yaml = buildEdaTopoNodeYaml(defaultConfig("sr-1"), getEntry(buildMatrix(hardware), "sr-1"))
      .replace("  component:\n", `  component:
    - kind: powerShelf
      slot: custom-shelf
      type: custom-power-shelf
`);
    const report = validateEdaYaml(yaml, hardware, catalog);

    assert.equal(report.valid, true);
    assert.deepEqual(report.issues, []);
  });
});

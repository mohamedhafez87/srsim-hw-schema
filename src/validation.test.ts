import assert from "node:assert/strict";
import { describe, it } from "node:test";

import hardwareData from "./data/srsim-supported-hardware.json";
import {
  buildMatrix,
  componentFromMatrixRow,
  defaultComponentsForEntry,
  defaultImpliesFields,
  firstValue,
  getEntry,
  upsertComponentBySlot
} from "./matrix";
import { buildTopologyYaml } from "./topologyYaml";
import type { HardwareSchema, SrsimConfig } from "./types";
import { validateTopologyYaml } from "./validation";

const hardware = hardwareData as HardwareSchema;

const validConfig: SrsimConfig = {
  labName: "srsimtest",
  nodeName: "sros1",
  chassis: "sr-7s",
  sfm: "sfm-s",
  components: [
    { slot: "A", type: "cpm2-s" },
    {
      slot: 1,
      type: "xcm-7s",
      xiom: [
        {
          slot: 1,
          type: "iom-s-1.5t",
          mda: [{ slot: 1, type: "ms2-400gb-qsfpdd+2-100gb-qsfp28" }]
        }
      ]
    }
  ]
};

describe("topology validation", () => {
  it("omits default SR-7s values while keeping the topology valid", () => {
    const entry = getEntry(buildMatrix(hardware), "sr-7s");
    const yaml = buildTopologyYaml(
      {
        labName: "srsimtest",
        nodeName: "sros1",
        chassis: "sr-7s",
        sfm: "sfm2-s",
        components: [
          { slot: "A", type: "cpm2-s" },
          { slot: 1, type: "xcm2-7s", mda: [{ slot: 1, type: "x2-s36-800g-qsfpdd-18.0t" }] }
        ]
      },
      {
        shouldWriteSfm: (component) => !defaultImpliesFields(entry, component, "sfm2-s", ["sfm"]),
        shouldWriteDirectMda: (component, mda) =>
          !defaultImpliesFields(entry, { ...component, mda: [mda] }, "sfm2-s", ["mda"])
      }
    );

    assert.equal(yaml.includes("sfm:"), false);
    assert.equal(yaml.includes("mda:"), false);
    assert.equal(validateTopologyYaml(yaml, hardware).valid, true);
  });

  it("validates a generated SR-SIM topology through schema and hardware checks", () => {
    const report = validateTopologyYaml(buildTopologyYaml(validConfig), hardware);

    assert.equal(report.valid, true);
    assert.deepEqual(report.issues, []);
  });

  it("keeps generated YAML valid when adding a slotless supported matrix row", () => {
    const entry = getEntry(buildMatrix(hardware), "sr-7s");
    assert.ok(entry);
    const supportedRow = entry.rows.find((row) =>
      row.source === "supported_hardware" &&
      row.values.card?.includes("xcm-7s") &&
      row.values.xiom?.includes("iom-s-1.5t") &&
      row.values.mda?.includes("ms2-400gb-qsfpdd+2-100gb-qsfp28")
    );
    assert.ok(supportedRow);

    const defaults = defaultComponentsForEntry(entry);
    const component = componentFromMatrixRow(supportedRow, defaults);
    assert.ok(component);
    const yaml = buildTopologyYaml({
      labName: "srsimtest",
      nodeName: "sros1",
      chassis: "sr-7s",
      sfm: firstValue(supportedRow, "sfm"),
      components: upsertComponentBySlot(defaults, component)
    });

    assert.equal(yaml.includes("slot: 2"), false);
    assert.equal(validateTopologyYaml(yaml, hardware).valid, true);
  });

  it("reports incompatible pasted SR-SIM hardware tuples", () => {
    const yaml = buildTopologyYaml({
      ...validConfig,
      components: [
        validConfig.components[0],
        {
          slot: 1,
          type: "xcm-7s",
          xiom: [{ slot: 1, type: "iom-s-1.5t", mda: [{ slot: 1, type: "not-a-real-mda" }] }]
        }
      ]
    });

    const report = validateTopologyYaml(yaml, hardware);

    assert.equal(report.valid, false);
    assert.ok(report.issues.some((issue) => issue.source === "hardware"));
  });

  it("requires SFM for non-default supported CPMs", () => {
    const invalid = validateTopologyYaml(
      "name: srsim-lab\ntopology:\n  nodes:\n    sros1:\n      kind: nokia_srsim\n      type: sr-7s\n      components:\n        - slot: A\n          type: cpm-s\n",
      hardware
    );
    const valid = validateTopologyYaml(
      "name: srsim-lab\ntopology:\n  nodes:\n    sros1:\n      kind: nokia_srsim\n      type: sr-7s\n      components:\n        - slot: A\n          sfm: sfm-s\n          type: cpm-s\n",
      hardware
    );

    assert.equal(invalid.valid, false);
    assert.equal(invalid.issues[0].message.startsWith("sros1[slot=A]:"), false);
    assert.equal(valid.valid, true);
  });

  it("does not surface low-signal node branch schema errors", () => {
    const report = validateTopologyYaml(
      "name: srsim-lab\ntopology:\n  nodes:\n    sros1:\n      kind: nokia_srsim\n      type: sr-7s\n      components:\n        - slot: 1\n          type: xcm2-7s\n          mda:\n            - slot: 1\n              type: not-a-real-mda\n",
      hardware
    );

    assert.equal(report.valid, false);
    assert.equal(report.issues.some((issue) => issue.message === "must be null"), false);
    assert.equal(report.issues.some((issue) => issue.message.includes('must match "then" schema')), false);
  });


  it("reports YAML parser errors before schema validation", () => {
    const report = validateTopologyYaml("name: [", hardware);

    assert.equal(report.valid, false);
    assert.equal(report.issues[0].source, "yaml");
  });
});

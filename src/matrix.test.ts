import assert from "node:assert/strict";
import { describe, it } from "node:test";

import hardwareData from "./data/srsim-supported-hardware.json";
import {
  buildMatrix,
  componentCardSlotOptions,
  componentFromMatrixRow,
  componentCpmSlotOptions,
  componentTypeOptions,
  cpmOptions,
  defaultImpliesFields,
  defaultComponentsForEntry,
  defaultSfmForEntry,
  getEntry,
  mdaOptions,
  schemaNumericSlotOptions,
  sfmOptions,
  upsertComponentBySlot,
  xiomOptions
} from "./matrix";
import type { HardwareSchema } from "./types";

const hardware = hardwareData as HardwareSchema;

describe("SR-SIM matrix helpers", () => {
  it("normalizes Nokia model rows into clab chassis aliases", () => {
    const matrix = buildMatrix(hardware);
    const sr7s = getEntry(matrix, "sr-7s");

    assert.ok(sr7s);
    assert.equal(sr7s.chassis, "sr-7s");
    assert.ok(sr7s.models.includes("7750 SR-7s"));
  });

  it("builds default components and compatible option lists", () => {
    const entry = getEntry(buildMatrix(hardware), "sr-7s");
    const components = defaultComponentsForEntry(entry);
    const lineCard = components.find((component) => component.slot === 1 || component.slot === "1");
    const blankLineCard = { slot: 1 };

    assert.ok(components.some((component) => component.slot === "A"));
    assert.ok(lineCard);
    assert.ok(cpmOptions(entry, "").includes("cpm2-s"));
    assert.ok(componentTypeOptions(entry, blankLineCard, "sfm-s").includes("xcm-7s"));
    assert.ok(sfmOptions(entry, []).includes("sfm-s"));
    assert.deepEqual(sfmOptions(entry, [{ slot: "A", type: "cpm-s" }]), ["sfm-s"]);
    assert.ok(sfmOptions(entry, components).includes("sfm2-s"));
    assert.equal(defaultSfmForEntry(entry), "sfm2-s");
    assert.ok(xiomOptions(entry, { ...blankLineCard, type: "xcm-7s" }, "sfm-s").includes("iom-s-1.5t"));
    assert.ok(
      mdaOptions(entry, { ...blankLineCard, type: "xcm-7s", xiom: [{ slot: 1, type: "iom-s-1.5t" }] }, "sfm-s").includes(
        "ms2-400gb-qsfpdd+2-100gb-qsfp28"
      )
    );
  });

  it("knows which selected values are implied by the default layout", () => {
    const entry = getEntry(buildMatrix(hardware), "sr-7s");

    assert.equal(defaultImpliesFields(entry, { slot: "A", type: "cpm2-s" }, "sfm2-s", ["sfm"]), true);
    assert.equal(defaultImpliesFields(entry, { slot: "A", type: "cpm-s" }, "sfm-s", ["sfm"]), false);
    assert.equal(
      defaultImpliesFields(
        entry,
        { slot: 1, type: "xcm2-7s", mda: [{ slot: 1, type: "x2-s36-800g-qsfpdd-18.0t" }] },
        "sfm2-s",
        ["mda"]
      ),
      true
    );
  });

  it("builds schema-compatible slot option lists for dropdowns", () => {
    const entry = getEntry(buildMatrix(hardware), "sr-7s");

    assert.deepEqual(componentCpmSlotOptions(entry), ["A", "B"]);
    assert.deepEqual(componentCardSlotOptions(entry), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(schemaNumericSlotOptions([], 2), [1, 2]);
    assert.deepEqual(schemaNumericSlotOptions([{ slot: 5 }], 2), [1, 2, 3, 4, 5]);
  });

  it("converts matrix rows into editor components", () => {
    const entry = getEntry(buildMatrix(hardware), "sr-7s");
    assert.ok(entry);

    const defaultCardRow = entry.rows.find((row) => row.source === "default_layout" && row.values.card?.includes("xcm2-7s"));
    assert.ok(defaultCardRow);
    assert.deepEqual(componentFromMatrixRow(defaultCardRow), {
      slot: 1,
      type: "xcm2-7s",
      mda: [{ slot: 1, type: "x2-s36-800g-qsfpdd-18.0t" }]
    });

    const supportedCpmRow = entry.rows.find((row) => row.source === "supported_hardware" && row.values.card?.includes("cpm-s"));
    assert.ok(supportedCpmRow);
    assert.deepEqual(componentFromMatrixRow(supportedCpmRow, [{ slot: "A", type: "cpm2-s" }]), {
      slot: "A",
      type: "cpm-s"
    });

    const supportedCardRow = entry.rows.find((row) =>
      row.source === "supported_hardware" &&
      row.values.card?.includes("xcm-7s") &&
      row.values.xiom?.includes("iom-s-1.5t") &&
      row.values.mda?.includes("ms2-400gb-qsfpdd+2-100gb-qsfp28")
    );
    assert.ok(supportedCardRow);
    assert.deepEqual(componentFromMatrixRow(supportedCardRow, [{ slot: 1, type: "xcm2-7s" }]), {
      slot: 1,
      type: "xcm-7s",
      xiom: [
        {
          slot: 1,
          type: "iom-s-1.5t",
          mda: [{ slot: 1, type: "ms2-400gb-qsfpdd+2-100gb-qsfp28" }]
        }
      ]
    });

    assert.deepEqual(
      upsertComponentBySlot([{ slot: 1, type: "xcm2-7s" }], { slot: 1, type: "xcm-7s" }),
      [{ slot: 1, type: "xcm-7s" }]
    );
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import srsimSchemaData from "./data/srsim-hw.schema.json";
import { extractSlotRules } from "./schemaSlots";

describe("SR-SIM schema slot rules", () => {
  it("extracts component and nested slot constraints from the generated schema", () => {
    const rules = extractSlotRules(srsimSchemaData as Record<string, unknown>);

    assert.deepEqual(rules.componentStringSlots, ["A", "B"]);
    assert.equal(rules.componentIntegerMinimum, 1);
    assert.equal(rules.mdaIntegerMinimum, 1);
    assert.equal(rules.xiomIntegerMinimum, 1);
  });
});

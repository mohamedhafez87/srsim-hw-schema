import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  defaultReleaseId,
  getReleaseEntry,
  listReleases,
  loadReleaseSchema
} from "./releases";

describe("releases", () => {
  it("lists catalog entries from the bundled manifest", () => {
    const releases = listReleases();
    assert.ok(releases.length >= 1);
    assert.ok(releases.some((entry) => entry.key === defaultReleaseId));
  });

  it("loads distinct schemas per release key", () => {
    const releases = listReleases();
    assert.ok(releases.length >= 1);
    const first = loadReleaseSchema(releases[0].key);
    assert.ok(first.source || first.release);
    if (releases.length > 1) {
      const second = loadReleaseSchema(releases[1].key);
      assert.notEqual(first.source, second.source);
    }
  });

  it("exposes per-release EDA defaults from the manifest", () => {
    const entry = getReleaseEntry(defaultReleaseId);
    assert.ok(entry);
    assert.ok(entry.eda_default_version);
  });

  it("uses stable platform-qualified release keys", () => {
    const keys = listReleases().map((entry) => entry.key);
    assert.ok(keys.includes("srsim:26.3"));
    assert.ok(keys.includes("srsim:25.10"));
    assert.ok(keys.includes("srsim:25.7"));
    assert.ok(keys.includes("sros:26.3"));
    assert.ok(keys.includes("sros:25.10"));
    assert.ok(keys.includes("sros:25.7"));
  });

  it("includes SROS metadata for vSIM releases", () => {
    const entry = getReleaseEntry("sros:25.10");
    assert.ok(entry);
    assert.equal(entry.platform, "sros");
    assert.equal(entry.platform_label, "SR OS vSIM");
    assert.equal(entry.containerlab_kind, "nokia_sros");
  });

  it("loads SROS schema metadata from bundled release files", () => {
    const schema = loadReleaseSchema("sros:25.10");
    assert.equal(schema.platform, "sros");
    assert.equal(schema.platform_label, "SR OS vSIM");
    assert.equal(schema.containerlab_kind, "nokia_sros");
  });
});

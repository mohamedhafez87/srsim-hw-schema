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
    assert.ok(releases.some((entry) => entry.id === defaultReleaseId));
  });

  it("loads distinct schemas per release id", () => {
    const releases = listReleases();
    assert.ok(releases.length >= 1);
    const first = loadReleaseSchema(releases[0].id);
    assert.ok(first.source || first.release);
    if (releases.length > 1) {
      const second = loadReleaseSchema(releases[1].id);
      assert.notEqual(first.source, second.source);
    }
  });

  it("exposes per-release EDA defaults from the manifest", () => {
    const entry = getReleaseEntry(defaultReleaseId);
    assert.ok(entry);
    assert.ok(entry.eda_default_version);
  });
});

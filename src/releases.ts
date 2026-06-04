import type { HardwareSchema } from "./types";

import manifestData from "./data/releases-manifest.json";
import { bundledReleaseSchemas } from "./releaseSchemas";

export const releasesManifest = manifestData as import("./types").ReleasesManifest;

export const defaultReleaseId = releasesManifest.default_release;

const releaseSchemaById = new Map<string, HardwareSchema>(
  Object.entries(bundledReleaseSchemas)
);

export function listReleases() {
  return releasesManifest.releases;
}

export function getReleaseEntry(releaseId: string) {
  return releasesManifest.releases.find((entry) => entry.id === releaseId);
}

export function loadReleaseSchema(releaseId: string): HardwareSchema {
  const schema = releaseSchemaById.get(releaseId);
  if (!schema) {
    throw new Error(`unknown release ${releaseId}`);
  }
  return schema;
}

export function defaultEdaVersionForRelease(releaseId: string): string | undefined {
  return getReleaseEntry(releaseId)?.eda_default_version;
}

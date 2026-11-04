import type { LocalStorageConfig, ObjectStorageConfig } from "../config/storage-config";
import { S3ObjectStorage } from "./object-storage";
import { LocalDiskStorage, type FileStorage } from "./storage";

/**
 * Builds the store a configuration names. Depends on nothing but the configuration (no database, no session secret),
 * so the API and the standalone storage check (scripts/storage-check.ts) build it the same way.
 */
export function createFileStorage(config: ObjectStorageConfig | LocalStorageConfig): FileStorage {
  return config.driver === "local" ? new LocalDiskStorage(config.dir) : new S3ObjectStorage(config);
}

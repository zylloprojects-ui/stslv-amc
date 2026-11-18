import { configArchiveKey, configKindKey, configManifestKey, promoteConfigBackup } from "./config-backup";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { dumpKey, kindMarkerKey, manifestKey, promoteDatabaseBackup, uploadKindMarker } from "./db-backup";
import { RcloneStore } from "./rclone-store";
import type { RecoveryKind } from "./retention";
import type { WritableStore } from "./store";

// Raising today's backup to a higher recovery-point type (a daily backup followed by that day's weekly or monthly
// job, e.g. after downtime) — never a second backup of the same day.
//
//   - One store for every type (S3 bucket, local folder): one more type marker beside the backup.
//   - Google Drive (Daily/Weekly/Monthly sub-folders): the backup is COPIED on the Drive server into the higher
//     sub-folder (size and MD5 checked), the new type marker is added, the manifest copied LAST; only then is the
//     lower copy moved to the Drive trash, manifest FIRST. An interruption leaves the recovery point complete in
//     at least one folder (possibly both, finished by the next promotion), never broken.

const KINDS: readonly RecoveryKind[] = ["daily", "weekly", "monthly"];

export async function promoteBackup(input: {
  step: "database" | "configuration";
  id: string;
  from: RecoveryKind;
  to: RecoveryKind;
  storeFor: (kind: RecoveryKind) => WritableStore;
  workDir: string;
}): Promise<void> {
  const { step, id, from, to, storeFor, workDir } = input;
  const source = storeFor(from);
  const target = storeFor(to);

  if (!(source instanceof RcloneStore) || !(target instanceof RcloneStore) || source.subFolder === target.subFolder) {
    if (step === "database") await promoteDatabaseBackup(target, id, to, workDir);
    else await promoteConfigBackup(target, id, to, workDir);
    return;
  }

  const data = step === "database" ? dumpKey(id) : configArchiveKey(id);
  const manifest = step === "database" ? manifestKey(id) : configManifestKey(id);
  const marker = (kind: RecoveryKind) => (step === "database" ? kindMarkerKey(id, kind) : configKindKey(id, kind));
  const existingMarkers: string[] = [];
  for (const kind of KINDS) if (await source.head(marker(kind))) existingMarkers.push(marker(kind));

  // Already promoted by an earlier, interrupted attempt and the lower copy gone: nothing to copy.
  if (!(await source.head(manifest))) {
    if (await target.head(manifest)) return;
    throw new Error(`Backup ${id} is not complete in ${source.subFolder}; it cannot be promoted.`);
  }

  await source.copyTo(data, target);
  for (const key of existingMarkers) await source.copyTo(key, target);
  // The new type marker before the manifest, as for a new backup: complete means typed.
  await writeMarkerOnly(target, marker(to), id, to, workDir);
  await source.copyTo(manifest, target);

  // The higher folder now holds the complete recovery point: trash the lower copy, manifest first.
  await source.remove(manifest);
  for (const key of existingMarkers) await source.remove(key);
  await source.remove(data);
}

async function writeMarkerOnly(store: WritableStore, key: string, id: string, kind: RecoveryKind, workDir: string): Promise<void> {
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  await uploadKindMarker(store, key, path.join(workDir, `promote-${id}-${kind}.json`), { id, kind, promotedAt: new Date().toISOString() });
}

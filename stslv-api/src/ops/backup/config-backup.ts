import { chmod, open, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { BackupConfig } from "./config";
import { decryptFile, type GpgOptions } from "./gpg";
import { describeFailure, type Logger } from "./log";
import { pingHeartbeat, readState, sendAlert, writeState, type Fetch } from "./notify";
import { uploadKindMarker } from "./db-backup";
import { readEncryptedJson, uploadEncryptedJson } from "./manifest-crypto";
import { highestKind, selectByKind, type RecoveryKind } from "./retention";
import { newestFirst, newRunId } from "./run-id";
import type { ReadableStore, WritableStore } from "./store";
import { sha256File } from "./tools";

// Weekly copy of the VPS configuration needed to rebuild the server: /etc/stslv-amc (api.env, backup.env),
// Nginx, Let's Encrypt, the systemd units, the deploy scripts and sudoers rule, SSH/UFW/fail2ban settings.
//
// Those files belong to root and hold secrets, while this job runs as the unprivileged "stslv-backup" user.
// So the archive is made by deploy/hostinger/scripts/config-snapshot.sh, run as root just before the weekly job
// (ExecStartPre=+ in stslv-amc-backup-weekly.service): it streams `tar` straight into GnuPG (the plain archive
// never touches the disk) and leaves only the ENCRYPTED file in the work folder. This step checks that the file
// is really encrypted and recent, uploads it (never over an existing object), verifies the stored copy, writes
// the manifest last and applies retention.

export const CONFIG_PREFIX = "config/";
export const CONFIG_SNAPSHOT_FILE = "config-snapshot.tar.gpg";
export const CONFIG_SNAPSHOT_PATHS = "config-snapshot.paths";
export const CONFIG_ID_PREFIX = "stslv-config";

export const configArchiveKey = (id: string) => `${CONFIG_PREFIX}${id}.tar.gpg`;
/** The ENCRYPTED manifest (it lists the configuration paths): manifest-crypto.ts. */
export const configManifestKey = (id: string) => `${CONFIG_PREFIX}${id}.manifest.json.gpg`;
export const configKindKey = (id: string, kind: RecoveryKind) => `${CONFIG_PREFIX}${id}.kind-${kind}.json`;
const CONFIG_KIND_MARKER = /^config\/(.+)\.kind-(daily|weekly|monthly)\.json$/;

export interface ConfigManifest {
  format: 1;
  id: string;
  environment: string;
  createdAt: string;
  /** Recovery-point type: weekly, or monthly on the last Friday of the month. */
  kind: RecoveryKind;
  snapshotCreatedAt: string;
  /** The paths the archive was made from (names only: the contents are inside the encrypted file). */
  paths: string[];
  encrypted: { key: string; bytes: number; sha256: string; recipient: string };
}

/**
 * True when the first bytes are an OpenPGP message and not a plain archive: the first byte of an OpenPGP packet
 * has its top bit set, a tar archive has "ustar" at offset 257, a gzip file starts with 1f 8b.
 */
export function looksEncrypted(head: Buffer): boolean {
  if (head.length === 0 || (head[0]! & 0x80) === 0) return false;
  if (head.length >= 262 && head.subarray(257, 262).toString("latin1") === "ustar") return false;
  if (head[0] === 0x1f && head[1] === 0x8b) return false;

  return true;
}

export interface ConfigBackupDeps {
  config: Pick<BackupConfig, "environment" | "workDir" | "stateDir" | "gpg" | "retention" | "prune" | "verifyDownload" | "alertWebhookUrl" | "heartbeatConfigUrl">;
  store: WritableStore;
  log: Logger;
  now?: () => Date;
  fetchImpl?: Fetch;
  /** The snapshot must have been made within this time (it is made right before the weekly job). */
  maxSnapshotAgeMs?: number;
  /** Recovery-point type (schedule.ts). Default: weekly. */
  kind?: RecoveryKind;
}

/** Complete configuration backups (with a manifest), newest first. */
export async function listConfigBackups(store: Pick<WritableStore, "list">): Promise<{ id: string; createdAt: Date; kind: RecoveryKind }[]> {
  const objects = await store.list(CONFIG_PREFIX);
  const manifests = objects.map((object) => object.key).filter((key) => key.endsWith(".manifest.json.gpg"));
  const kinds = new Map<string, RecoveryKind[]>();

  for (const object of objects) {
    const match = CONFIG_KIND_MARKER.exec(object.key);
    if (match) kinds.set(match[1] as string, [...(kinds.get(match[1] as string) ?? []), match[2] as RecoveryKind]);
  }

  // A configuration copy is never daily: without a marker it counts as weekly.
  return newestFirst(CONFIG_ID_PREFIX, manifests.map((key) => key.slice(CONFIG_PREFIX.length, -".manifest.json.gpg".length))).map((backup) => ({
    ...backup,
    kind: highestKind(kinds.get(backup.id) ?? ["weekly"]),
  }));
}

/** Raises a configuration backup to a higher recovery-point type (one more marker; nothing overwritten). */
export async function promoteConfigBackup(store: WritableStore, id: string, kind: RecoveryKind, workDir: string): Promise<void> {
  if (!(await store.head(configManifestKey(id)))) throw new Error(`Configuration backup ${id} is not complete in the off-site store; it cannot be promoted.`);
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  await uploadKindMarker(store, configKindKey(id, kind), path.join(workDir, `promote-${id}.json`), { id, kind, promotedAt: new Date().toISOString() });
}

/** Removes the snapshot files left in the work folder (a job that skipped the configuration step calls this). */
export async function discardConfigSnapshot(workDir: string): Promise<void> {
  await rm(path.join(workDir, CONFIG_SNAPSHOT_FILE), { force: true });
  await rm(path.join(workDir, CONFIG_SNAPSHOT_PATHS), { force: true });
}

export async function runConfigBackup(deps: ConfigBackupDeps): Promise<{ id: string; manifest: ConfigManifest; pruned: string[] }> {
  const { config, store, log } = deps;
  const now = deps.now ?? (() => new Date());
  const maxAge = deps.maxSnapshotAgeMs ?? 6 * 60 * 60_000;
  const snapshot = path.join(config.workDir, CONFIG_SNAPSHOT_FILE);
  const id = newRunId(CONFIG_ID_PREFIX, config.environment, now());
  const runDir = path.join(config.workDir, id);
  const state = await readState(config.stateDir, "config-backup");

  log.info("config_backup.start", { id, store: store.label });

  try {
    const info = await stat(snapshot).catch(() => null);

    if (!info) throw new Error("No configuration snapshot was made (config-snapshot.sh did not run or failed).");
    if (now().getTime() - info.mtimeMs > maxAge) throw new Error("The configuration snapshot is too old: config-snapshot.sh did not run before this job.");

    const handle = await open(snapshot, "r");
    const head = Buffer.alloc(512);
    const { bytesRead } = await handle.read(head, 0, 512, 0);
    await handle.close();

    if (!looksEncrypted(head.subarray(0, bytesRead))) throw new Error("The configuration snapshot is not encrypted: refusing to upload it.");

    const paths = (await readFile(path.join(config.workDir, CONFIG_SNAPSHOT_PATHS), "utf8").catch(() => ""))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const encrypted = { key: configArchiveKey(id), bytes: info.size, sha256: await sha256File(snapshot), recipient: config.gpg.recipient };

    await store.upload(encrypted.key, snapshot, "application/pgp-encrypted");

    const uploaded = await store.head(encrypted.key);

    if (!uploaded || uploaded.size !== encrypted.bytes) throw new Error("The uploaded configuration backup has the wrong size in the off-site store.");

    await mkdir(runDir, { recursive: true, mode: 0o700 });
    if (config.verifyDownload) {
      const check = path.join(runDir, "verify.gpg");
      await store.download(encrypted.key, check);
      if ((await sha256File(check)) !== encrypted.sha256) throw new Error("The uploaded configuration backup does not match its checksum when downloaded again.");
    }

    const manifest: ConfigManifest = {
      format: 1,
      id,
      environment: config.environment,
      createdAt: now().toISOString(),
      kind: deps.kind ?? "weekly",
      snapshotCreatedAt: new Date(info.mtimeMs).toISOString(),
      paths,
      encrypted,
    };
    await uploadKindMarker(store, configKindKey(id, manifest.kind), path.join(runDir, "kind.json"), { id, kind: manifest.kind, at: now().toISOString() });
    await uploadEncryptedJson({ store, key: configManifestKey(id), value: manifest, gpg: config.gpg, recipient: config.gpg.recipient, scratchDir: runDir });
    log.info("config_backup.stored", { id, encryptedBytes: encrypted.bytes, paths: paths.length });

    // Retention by type: the newest 8 weekly (never fewer than 4) and 12 monthly copies; the newest always kept. A pruning problem is reported but
    // does not fail the run (the backup is stored).
    let pruned: string[] = [];
    if (config.prune) {
      try {
        const backups = await listConfigBackups(store);
        if (backups.length > 4) {
          const decision = selectByKind(backups, { daily: 0, weekly: Math.max(4, config.retention.weekly), monthly: config.retention.monthly });
          for (const old of decision.remove.filter((candidate) => candidate !== id)) {
            await store.remove(configArchiveKey(old));
            for (const kind of ["daily", "weekly", "monthly"] as const) await store.remove(configKindKey(old, kind));
            await store.remove(configManifestKey(old));
            pruned.push(old);
          }
        }
      } catch (error) {
        const reason = describeFailure(error, log);
        log.warn("config_backup.prune_failed", { id, reason });
        await sendAlert(config.alertWebhookUrl, `[STSLV AMC ${config.environment}] Configuration backup ${id} succeeded, but removing old copies failed: ${reason}`, log, deps.fetchImpl);
      }
    }

    await writeState(config.stateDir, { ...state, lastSuccessAt: now().toISOString(), lastRunId: id, details: { encryptedBytes: encrypted.bytes, paths: paths.length, pruned: pruned.length } });
    await pingHeartbeat(config.heartbeatConfigUrl, true, log, deps.fetchImpl);
    log.info("config_backup.done", { id, pruned: pruned.length });

    return { id, manifest, pruned };
  } catch (error) {
    const reason = describeFailure(error, log);

    log.error("config_backup.failed", { id, reason });
    await writeState(config.stateDir, { ...state, lastFailureAt: now().toISOString(), lastFailure: reason, lastRunId: id }).catch(() => undefined);
    await sendAlert(config.alertWebhookUrl, `[STSLV AMC ${config.environment}] CONFIGURATION BACKUP FAILED (${id}): ${reason}`, log, deps.fetchImpl);
    await pingHeartbeat(config.heartbeatConfigUrl, false, log, deps.fetchImpl);
    throw error;
  } finally {
    // The encrypted snapshot is uploaded or reported; nothing is left behind in the work folder.
    await rm(runDir, { recursive: true, force: true });
    await discardConfigSnapshot(config.workDir);
  }
}

/**
 * Restores a configuration backup for inspection or a server rebuild: the encrypted archive is downloaded, its
 * SHA-256 checked against the (encrypted) manifest, then decrypted into `<toDir>/<id>.config.tar` (mode 0600) — a new
 * or empty folder on the administrator's machine, never applied to a server automatically. Needs the PRIVATE key.
 */
export async function restoreConfigBackup(input: {
  store: ReadableStore;
  backupId: string;
  toDir: string;
  gpg: GpgOptions;
  workDir: string;
  log: Logger;
}): Promise<{ id: string; manifest: ConfigManifest; archive: string }> {
  const id = input.backupId === "latest" ? (await listConfigBackups(input.store))[0]?.id : input.backupId;
  if (!id) throw new Error("There is no complete configuration backup in this store.");

  const runDir = path.join(input.workDir, `config-restore-${id}`);
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  try {
    const manifest = await readEncryptedJson<ConfigManifest>({ store: input.store, key: configManifestKey(id), gpg: input.gpg, scratchDir: runDir });
    if (manifest.format !== 1 || manifest.id !== id) throw new Error("The manifest is not the configuration manifest of this backup.");

    const encrypted = path.join(runDir, "config.tar.gpg");
    await input.store.download(configArchiveKey(id), encrypted);
    if ((await sha256File(encrypted)) !== manifest.encrypted.sha256) throw new Error("The configuration archive does not match its manifest checksum.");

    await mkdir(input.toDir, { recursive: true, mode: 0o700 });
    const archive = path.join(input.toDir, `${id}.config.tar`);
    await decryptFile(input.gpg, encrypted, archive);
    await chmod(archive, 0o600).catch(() => undefined);
    input.log.info("config_restore.done", { id, kind: manifest.kind, paths: manifest.paths.length });

    return { id, manifest, archive };
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
}

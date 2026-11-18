import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { decryptFile, encryptFile, type GpgOptions } from "./gpg";
import type { ReadableStore, WritableStore } from "./store";

// Manifests are ENCRYPTED like the backups they describe (approved 2026-11-18): a document manifest names every
// document (original file names, record ids, upload times), a database manifest counts every table, a configuration
// manifest lists the server's configuration paths. They are written with the backup PUBLIC key, so the server can
// write them but never read them back; restores read them on the administrator's machine with the private key.
//
// The server never needs to read a manifest: listing, retention and promotion work on object NAMES (the manifest's
// presence marks a complete backup) and on the small plain type markers ("<id>.kind-<type>.json": id, type, time).

/** Writes `value` as JSON, encrypts it to the backup key and uploads it under `key` (which ends in ".gpg"). */
export async function uploadEncryptedJson(input: {
  store: WritableStore;
  key: string;
  value: unknown;
  gpg: GpgOptions;
  recipient: string;
  scratchDir: string;
}): Promise<void> {
  if (!input.key.endsWith(".gpg")) throw new Error(`An encrypted manifest key must end in .gpg (${input.key}).`);
  const plain = path.join(input.scratchDir, `manifest-${process.pid}-${Date.now()}.json`);
  const encrypted = `${plain}.gpg`;

  try {
    await writeFile(plain, `${JSON.stringify(input.value, null, 2)}\n`, { mode: 0o600 });
    await encryptFile(input.gpg, input.recipient, plain, encrypted);
    await rm(plain, { force: true });
    await input.store.upload(input.key, encrypted, "application/pgp-encrypted");
  } finally {
    await rm(plain, { force: true });
    await rm(encrypted, { force: true });
  }
}

/** Downloads and decrypts an encrypted manifest (needs the backup PRIVATE key, e.g. GNUPGHOME on the admin PC). */
export async function readEncryptedJson<T>(input: { store: ReadableStore; key: string; gpg: GpgOptions; scratchDir: string }): Promise<T> {
  const encrypted = path.join(input.scratchDir, `read-${process.pid}-${Date.now()}.json.gpg`);
  const plain = encrypted.slice(0, -".gpg".length);

  try {
    await input.store.download(input.key, encrypted);
    await decryptFile(input.gpg, encrypted, plain);
    return JSON.parse(await readFile(plain, "utf8")) as T;
  } finally {
    await rm(encrypted, { force: true });
    await rm(plain, { force: true });
  }
}

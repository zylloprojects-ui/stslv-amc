import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { GpgOptions } from "./gpg";
import { gpgPathArg } from "./gpg";
import { childEnv, runTool } from "./tools";

// Checks before a production backup writes anything (approved 2026-11-18):
//   - the backup keyring holds the PUBLIC key only: a private key on the server would let anyone who takes the
//     server read every backup, so its presence stops the run;
//   - the rclone configuration (Google OAuth token) is private to the backup user: mode 0600 (no group or other
//     access) and owned by the user running the job.
// On Windows (development) POSIX modes and owners do not apply; the private-key check still runs.

const PRIVATE_KEY_FOUND = 'The backup keyring on this server holds a PRIVATE key. Only the public key may be here: remove the private key (docs/BACKUP_AUTOMATION.md "Keys").';

export async function assertNoPrivateKey(gpg: GpgOptions): Promise<void> {
  // 1. On disk, independent of gpg-agent (which may fail to start and then hide secret keys from a listing):
  //    GnuPG 2.1+ keeps private keys as files in private-keys-v1.d; GnuPG 1 in secring.gpg.
  if (gpg.homeDir) {
    const keyFiles = (await readdir(path.join(gpg.homeDir, "private-keys-v1.d")).catch(() => [] as string[])).filter((name) => name.endsWith(".key"));
    const legacy = await stat(path.join(gpg.homeDir, "secring.gpg")).catch(() => null);
    if (keyFiles.length > 0 || (legacy && legacy.size > 0)) throw new Error(PRIVATE_KEY_FOUND);
  }

  // 2. GnuPG's own view (also covers a keyring outside homeDir, e.g. the default one).
  const env = childEnv(gpg.homeDir ? { GNUPGHOME: await gpgPathArg(gpg.gpgPath, gpg.homeDir) } : {});
  const listed = await runTool(gpg.gpgPath, ["--batch", "--with-colons", "--list-secret-keys"], { env, timeoutMs: 30_000 });

  if (/^sec:/m.test(listed.stdout)) throw new Error(PRIVATE_KEY_FOUND);
}

export async function assertPrivateFile(file: string, label: string, platform: NodeJS.Platform = process.platform, uid: number | null = typeof process.getuid === "function" ? process.getuid() : null): Promise<void> {
  const info = await stat(file).catch(() => null);

  if (!info) throw new Error(`${label} (${file}) does not exist.`);
  if (!info.isFile()) throw new Error(`${label} (${file}) is not a file.`);
  if (platform === "win32") return;
  if ((info.mode & 0o077) !== 0) throw new Error(`${label} (${file}) is readable by other users: chmod 600 it.`);
  if (uid !== null && info.uid !== uid) throw new Error(`${label} (${file}) must belong to the backup user.`);
}

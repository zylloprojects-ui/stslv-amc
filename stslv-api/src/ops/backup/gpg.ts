import { childEnv, runTool } from "./tools";

// Backups are encrypted with GnuPG public-key encryption. The production server holds only the PUBLIC key:
// it can encrypt but never decrypt, so a copy of the backup bucket, or of the server, does not expose the
// data. The private key is kept offline by the business (docs/BACKUP_AUTOMATION.md "Keys").

export interface GpgOptions {
  gpgPath: string;
  /** GnuPG home folder (keyring). Undefined: GNUPGHOME or the user's default. */
  homeDir?: string;
  /** For decryption only: a file holding the private key's passphrase. Undefined: gpg-agent asks, or the key has none. */
  passphraseFile?: string;
}

const TIMEOUT_MS = 30 * 60 * 1000;

// On Windows, the gpg that ships with Git for Windows (MSYS2) only understands POSIX-style paths (/c/Users/...),
// while a native build (Gpg4win) needs C:\Users\... . The style is detected once from "gpg --version", whose
// "Home:" line is POSIX-style for an MSYS2 build. On Linux (the server) paths are passed unchanged.
const posixStyle = new Map<string, Promise<boolean>>();

function usesPosixPaths(gpgPath: string): Promise<boolean> {
  if (process.platform !== "win32") return Promise.resolve(false);

  let known = posixStyle.get(gpgPath);
  if (!known) {
    known = runTool(gpgPath, ["--version"], { env: childEnv({}), timeoutMs: 30_000 }).then((result) => /^Home:\s+\//m.test(result.stdout));
    posixStyle.set(gpgPath, known);
  }

  return known;
}

/** A path as this gpg expects it: unchanged, except C:\x\y -> /c/x/y for an MSYS2 gpg on Windows. */
export async function gpgPathArg(gpgPath: string, file: string): Promise<string> {
  if (!(await usesPosixPaths(gpgPath))) return file;

  const match = /^([A-Za-z]):[\\/](.*)$/.exec(file);

  return match ? `/${(match[1] as string).toLowerCase()}/${(match[2] as string).replace(/\\/g, "/")}` : file.replace(/\\/g, "/");
}

async function env(options: GpgOptions): Promise<NodeJS.ProcessEnv> {
  const home = options.homeDir ?? process.env.GNUPGHOME;

  return childEnv({ GNUPGHOME: home ? await gpgPathArg(options.gpgPath, home) : undefined });
}

/** Refuses a recipient that is not a full key fingerprint, so a similar-looking key cannot be used by mistake. */
export function assertFingerprint(recipient: string): void {
  if (!/^[0-9A-F]{40}$|^[0-9A-F]{64}$/.test(recipient)) {
    throw new Error("BACKUP_GPG_RECIPIENT must be the full key fingerprint (40 or 64 upper-case hexadecimal characters).");
  }
}

/** Checks the recipient's public key is in the keyring and can encrypt. */
export async function checkRecipient(options: GpgOptions, recipient: string): Promise<void> {
  assertFingerprint(recipient);
  const result = await runTool(options.gpgPath, ["--batch", "--no-tty", "--with-colons", "--list-keys", recipient], { env: await env(options), timeoutMs: 60_000 });

  if (result.code !== 0) {
    throw new Error("The backup encryption key (BACKUP_GPG_RECIPIENT) is not in the GnuPG keyring.");
  }
  // A key or subkey with the encryption capability "e", not revoked ("r") or expired ("e" in the validity field).
  const usable = result.stdout
    .split(/\r?\n/)
    .map((line) => line.split(":"))
    .some((fields) => (fields[0] === "pub" || fields[0] === "sub") && !["r", "e"].includes(fields[1] ?? "") && (fields[11] ?? "").includes("e"));

  if (!usable) {
    throw new Error("The backup encryption key (BACKUP_GPG_RECIPIENT) cannot encrypt: it is revoked, expired or has no encryption subkey.");
  }
}

export async function encryptFile(options: GpgOptions, recipient: string, input: string, output: string): Promise<void> {
  assertFingerprint(recipient);
  const result = await runTool(
    options.gpgPath,
    // trust-model always: the key is chosen by its full fingerprint in configuration, not by a web of trust.
    [
      "--batch", "--yes", "--no-tty", "--quiet", "--trust-model", "always", "--compress-algo", "none", "--cipher-algo", "AES256",
      "--encrypt", "--recipient", recipient, "--output", await gpgPathArg(options.gpgPath, output), await gpgPathArg(options.gpgPath, input),
    ],
    { env: await env(options), timeoutMs: TIMEOUT_MS }
  );

  if (result.code !== 0) {
    throw new Error(`GPG encryption failed (exit ${result.code}).`);
  }
}

export async function decryptFile(options: GpgOptions, input: string, output: string): Promise<void> {
  const passphrase = options.passphraseFile ? ["--pinentry-mode", "loopback", "--passphrase-file", await gpgPathArg(options.gpgPath, options.passphraseFile)] : [];
  const args = ["--batch", "--yes", "--no-tty", "--quiet", ...passphrase, "--decrypt", "--output", await gpgPathArg(options.gpgPath, output), await gpgPathArg(options.gpgPath, input)];
  const result = await runTool(options.gpgPath, args, {
    env: await env(options),
    timeoutMs: TIMEOUT_MS,
  });

  if (result.code !== 0) {
    throw new Error(`GPG decryption failed (exit ${result.code}). Is the backup private key in this keyring?`);
  }
}

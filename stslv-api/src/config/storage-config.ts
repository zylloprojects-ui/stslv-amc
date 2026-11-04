import path from "node:path";

export interface R2StorageConfig {
  driver: "r2";
  accountId: string;
  bucket: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface LocalStorageConfig {
  driver: "local";
  dir: string;
}

/** Where uploaded documents are kept, or null when this server has no document storage. */
export type StorageConfig = R2StorageConfig | LocalStorageConfig | null;

/** The R2 settings, all four needed together. The secret values are never printed in an error. */
export const R2_VARIABLES = ["R2_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;

type Vars = Record<string, string | undefined>;

const read = (vars: Vars, name: string) => vars[name]?.trim() ?? "";

function readEndpoint(vars: Vars, accountId: string, nodeEnv: string | undefined): string {
  const raw = read(vars, "R2_ENDPOINT");

  if (!raw) {
    return `https://${accountId}.r2.cloudflarestorage.com`;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid R2_ENDPOINT. It must be a web address such as https://<account id>.eu.r2.cloudflarestorage.com.");
  }
  // Outside production an http endpoint is allowed, for a local S3-compatible test server.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && nodeEnv !== "production")) {
    throw new Error("Invalid R2_ENDPOINT. It must use https.");
  }

  return raw.replace(/\/+$/, "");
}

/**
 * Chooses the document storage from the environment.
 *   R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (all four)  a private Cloudflare R2 bucket.
 *   ATTACHMENTS_DIR                                                             a local folder.
 *   neither                                                                    a local folder (stslv-api/storage/attachments)
 *                                                                               outside production; none in production, because
 *                                                                               the hosting disk may not be permanent.
 * Setting only some R2 values, or both R2 and ATTACHMENTS_DIR, stops the API from starting, so a half-made
 * configuration is noticed at deploy time instead of at the first upload.
 */
export function resolveStorageConfig(vars: Vars, nodeEnv: string | undefined, cwd: string): StorageConfig {
  const present = R2_VARIABLES.filter((name) => read(vars, name) !== "");
  const dir = read(vars, "ATTACHMENTS_DIR");

  if (present.length > 0) {
    const missing = R2_VARIABLES.filter((name) => !present.includes(name));

    if (missing.length > 0) {
      throw new Error(`Cloudflare R2 document storage is partly configured: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing. Set all of ${R2_VARIABLES.join(", ")}, or none.`);
    }
    if (dir) {
      throw new Error("Both ATTACHMENTS_DIR and Cloudflare R2 document storage are configured. Choose one: remove ATTACHMENTS_DIR to use R2.");
    }

    const accountId = read(vars, "R2_ACCOUNT_ID");
    const bucket = read(vars, "R2_BUCKET");

    if (!/^[0-9a-f]{32}$/i.test(accountId)) {
      throw new Error("Invalid R2_ACCOUNT_ID. It is the 32-character account ID shown in the Cloudflare dashboard.");
    }
    // R2 bucket names: 3 to 63 lowercase letters, digits and hyphens, not starting or ending with a hyphen.
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
      throw new Error("Invalid R2_BUCKET. Use the bucket's name: 3 to 63 lowercase letters, digits and hyphens.");
    }

    return {
      driver: "r2",
      accountId,
      bucket,
      endpoint: readEndpoint(vars, accountId, nodeEnv),
      accessKeyId: read(vars, "R2_ACCESS_KEY_ID"),
      secretAccessKey: read(vars, "R2_SECRET_ACCESS_KEY"),
    };
  }

  if (dir) {
    return { driver: "local", dir: path.resolve(dir) };
  }

  return nodeEnv === "production" ? null : { driver: "local", dir: path.resolve(cwd, "storage", "attachments") };
}

/** A description safe to show on the Security page: never a key, secret, account ID or address. */
export function describeStorage(config: StorageConfig): { kind: "R2" | "LOCAL" | "NONE"; detail: string } {
  if (!config) return { kind: "NONE", detail: "Not configured, so document uploads are off." };
  if (config.driver === "r2") return { kind: "R2", detail: "A private Cloudflare R2 bucket. Files are served only through the API, after its permission checks." };

  return { kind: "LOCAL", detail: "A folder on this server is configured. Its durability cannot be checked from here." };
}

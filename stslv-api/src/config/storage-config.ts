import path from "node:path";

/** A private bucket reached through an S3-compatible API: Supabase Storage or Cloudflare R2. */
export interface ObjectStorageConfig {
  driver: "supabase" | "r2";
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface LocalStorageConfig {
  driver: "local";
  dir: string;
}

/** Where uploaded documents are kept, or null when this server has no document storage. */
export type StorageConfig = ObjectStorageConfig | LocalStorageConfig | null;

/** The Supabase Storage settings, all five needed together. The secret values are never printed in an error. */
export const SUPABASE_VARIABLES = ["SUPABASE_PROJECT_REF", "SUPABASE_S3_REGION", "SUPABASE_S3_BUCKET", "SUPABASE_S3_ACCESS_KEY_ID", "SUPABASE_S3_SECRET_ACCESS_KEY"] as const;

/** The Cloudflare R2 settings, all four needed together. */
export const R2_VARIABLES = ["R2_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;

type Vars = Record<string, string | undefined>;

const read = (vars: Vars, name: string) => vars[name]?.trim() ?? "";

/** Throws unless every variable of a provider is set, naming the missing ones (never a value). */
function requireAll(vars: Vars, names: readonly string[], provider: string): void {
  const missing = names.filter((name) => read(vars, name) === "");

  if (missing.length > 0) {
    throw new Error(`${provider} document storage is partly configured: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing. Set all of ${names.join(", ")}, or none.`);
  }
}

/** An optional endpoint override: https only in production (http allowed elsewhere, for a local S3-compatible server). */
function readEndpoint(vars: Vars, name: string, fallback: string, nodeEnv: string | undefined): string {
  const raw = read(vars, name);

  if (!raw) {
    return fallback;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid ${name}. It must be a web address such as ${fallback}.`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && nodeEnv !== "production")) {
    throw new Error(`Invalid ${name}. It must use https.`);
  }

  return raw.replace(/\/+$/, "");
}

function supabaseConfig(vars: Vars, nodeEnv: string | undefined): ObjectStorageConfig {
  requireAll(vars, SUPABASE_VARIABLES, "Supabase");

  const projectRef = read(vars, "SUPABASE_PROJECT_REF");
  const region = read(vars, "SUPABASE_S3_REGION");
  const bucket = read(vars, "SUPABASE_S3_BUCKET");

  // The project reference: the 20 lowercase letters and digits in the project's URL (https://<ref>.supabase.co).
  if (!/^[a-z0-9]{20}$/.test(projectRef)) {
    throw new Error("Invalid SUPABASE_PROJECT_REF. It is the 20-character project reference in the project's URL.");
  }
  // The project's region as shown on Storage > S3 Connection, for example eu-central-1 or ap-south-1.
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) {
    throw new Error("Invalid SUPABASE_S3_REGION. Use the region shown under Storage > S3 Connection, for example eu-central-1.");
  }
  if (!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error("Invalid SUPABASE_S3_BUCKET. Use the bucket's name: 3 to 63 lowercase letters, digits, dots, hyphens or underscores.");
  }

  return {
    driver: "supabase",
    bucket,
    region,
    // Supabase's recommended direct storage host name.
    endpoint: readEndpoint(vars, "SUPABASE_S3_ENDPOINT", `https://${projectRef}.storage.supabase.co/storage/v1/s3`, nodeEnv),
    accessKeyId: read(vars, "SUPABASE_S3_ACCESS_KEY_ID"),
    secretAccessKey: read(vars, "SUPABASE_S3_SECRET_ACCESS_KEY"),
  };
}

function r2Config(vars: Vars, nodeEnv: string | undefined): ObjectStorageConfig {
  requireAll(vars, R2_VARIABLES, "Cloudflare R2");

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
    bucket,
    region: "auto",
    endpoint: readEndpoint(vars, "R2_ENDPOINT", `https://${accountId}.r2.cloudflarestorage.com`, nodeEnv),
    accessKeyId: read(vars, "R2_ACCESS_KEY_ID"),
    secretAccessKey: read(vars, "R2_SECRET_ACCESS_KEY"),
  };
}

/**
 * Chooses the document storage from the environment. Exactly one of these may be configured:
 *   SUPABASE_PROJECT_REF, SUPABASE_S3_REGION, SUPABASE_S3_BUCKET,
 *   SUPABASE_S3_ACCESS_KEY_ID, SUPABASE_S3_SECRET_ACCESS_KEY (all five)       a private Supabase Storage bucket.
 *   R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (all four) a private Cloudflare R2 bucket.
 *   ATTACHMENTS_DIR                                                            a local folder.
 *   none of them                                                              a local folder (stslv-api/storage/attachments)
 *                                                                              outside production; none in production, because
 *                                                                              the hosting disk may not be permanent.
 * A partial set, or more than one store, stops the API from starting, so a half-made configuration is noticed at
 * deploy time instead of at the first upload.
 */
export function resolveStorageConfig(vars: Vars, nodeEnv: string | undefined, cwd: string): StorageConfig {
  const supabase = SUPABASE_VARIABLES.some((name) => read(vars, name) !== "");
  const r2 = R2_VARIABLES.some((name) => read(vars, name) !== "");
  const dir = read(vars, "ATTACHMENTS_DIR");
  const chosen = [supabase && "Supabase (SUPABASE_*)", r2 && "Cloudflare R2 (R2_*)", dir && "ATTACHMENTS_DIR"].filter(Boolean);

  if (chosen.length > 1) {
    throw new Error(`More than one document storage is configured: ${chosen.join(", ")}. Choose one and remove the others' settings.`);
  }
  if (supabase) return supabaseConfig(vars, nodeEnv);
  if (r2) return r2Config(vars, nodeEnv);
  if (dir) return { driver: "local", dir: path.resolve(dir) };

  return nodeEnv === "production" ? null : { driver: "local", dir: path.resolve(cwd, "storage", "attachments") };
}

/**
 * For a custom Supabase endpoint: whether its host name contains the configured project reference. Only a yes/no for
 * review (neither value is shown). The two are separate settings and never substituted for one another: the
 * reference is validated and kept, the endpoint is used as given. Null when no custom endpoint is set.
 */
export function endpointNamesProject(vars: Vars): boolean | null {
  const endpoint = read(vars, "SUPABASE_S3_ENDPOINT");
  const projectRef = read(vars, "SUPABASE_PROJECT_REF");

  if (!endpoint || !projectRef) return null;
  try {
    return new URL(endpoint).hostname.toLowerCase().split(".").includes(projectRef.toLowerCase());
  } catch {
    return null;
  }
}

/** A description safe to show on the Security page: never a key, secret, project, account, bucket or address. */
export function describeStorage(config: StorageConfig): { kind: "SUPABASE" | "R2" | "LOCAL" | "NONE"; detail: string } {
  if (!config) return { kind: "NONE", detail: "Not configured, so document uploads are off." };
  if (config.driver === "supabase") return { kind: "SUPABASE", detail: "A private Supabase Storage bucket. Files are served only through the API, after its permission checks." };
  if (config.driver === "r2") return { kind: "R2", detail: "A private Cloudflare R2 bucket. Files are served only through the API, after its permission checks." };

  return { kind: "LOCAL", detail: "A folder on this server is configured. Its durability cannot be checked from here." };
}

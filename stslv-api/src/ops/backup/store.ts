import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, S3ServiceException, type S3ClientConfig } from "@aws-sdk/client-s3";

// Where backups are read from and written to. Two kinds:
//   ReadableStore  list / head / download only. The production document bucket is only ever reached through
//                  this interface, so the backup code has no way to write to it or delete from it.
//   WritableStore  adds upload (which REFUSES to replace an existing object) and remove (used only to prune
//                  database backups that fall out of the retention policy).

export interface ObjectInfo {
  key: string;
  size: number;
  lastModified?: Date;
}

export interface ReadableStore {
  /** A description for logs: kind and bucket or folder, never a credential. */
  readonly label: string;
  list(prefix: string): Promise<ObjectInfo[]>;
  head(key: string): Promise<ObjectInfo | null>;
  download(key: string, destinationFile: string): Promise<void>;
}

export interface WritableStore extends ReadableStore {
  /** Fails with ObjectExistsError when the key already exists: nothing is ever overwritten. */
  upload(key: string, sourceFile: string, contentType?: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export class ObjectExistsError extends Error {
  constructor(readonly key: string) {
    super(`Refusing to overwrite existing backup object ${key}.`);
  }
}

/** Object keys are relative, use forward slashes and never climb out of their prefix. */
export function assertObjectKey(key: string): void {
  if (key === "" || key.startsWith("/") || key.includes("\\") || key.split("/").some((part) => part === ".." || part === "." || part === "") || /[\u0000-\u001f]/.test(key)) {
    throw new Error(`Invalid object key "${key.slice(0, 80)}".`);
  }
}

/** Returns a store that exposes only the read operations of `store`. */
export function readOnly(store: ReadableStore): ReadableStore {
  return {
    label: store.label,
    list: (prefix) => store.list(prefix),
    head: (key) => store.head(key),
    download: (key, file) => store.download(key, file),
  };
}

// ---------------------------------------------------------------------------------------------
// A folder on disk: a mounted second disk, a NAS share, or the tests' temporary folders.
// ---------------------------------------------------------------------------------------------
export class LocalDirStore implements WritableStore {
  readonly label: string;

  constructor(private readonly root: string) {
    this.label = `folder ${path.basename(root)}`;
  }

  private file(key: string): string {
    assertObjectKey(key);
    const resolved = path.resolve(this.root, ...key.split("/"));

    if (!resolved.startsWith(path.resolve(this.root) + path.sep)) {
      throw new Error("Object key escapes the store folder.");
    }

    return resolved;
  }

  async list(prefix: string): Promise<ObjectInfo[]> {
    const out: ObjectInfo[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && !entry.name.endsWith(".partial")) {
          const key = path.relative(this.root, full).split(path.sep).join("/");
          if (key.startsWith(prefix)) {
            const info = await stat(full);
            out.push({ key, size: info.size, lastModified: info.mtime });
          }
        }
      }
    };

    await walk(this.root);

    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const info = await stat(this.file(key));

      return info.isFile() ? { key, size: info.size, lastModified: info.mtime } : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async download(key: string, destinationFile: string): Promise<void> {
    await copyFile(this.file(key), destinationFile);
  }

  async upload(key: string, sourceFile: string): Promise<void> {
    const target = this.file(key);

    await mkdir(path.dirname(target), { recursive: true });
    // Written beside the target first, then moved into place only if the target does not exist ("wx").
    const partial = `${target}.partial`;
    await pipeline(createReadStream(sourceFile), createWriteStream(partial, { flags: "w" }));
    try {
      await pipeline(createReadStream(partial), createWriteStream(target, { flags: "wx" }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ObjectExistsError(key);
      throw error;
    } finally {
      await rm(partial, { force: true });
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.file(key), { force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// An S3-compatible bucket (Backblaze B2, Cloudflare R2, Wasabi, AWS S3, Supabase Storage...).
// ---------------------------------------------------------------------------------------------
export interface S3StoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Prefix every key is placed under, for example "stslv-amc/production/". "" for none. */
  prefix: string;
  /** Send If-None-Match: * on upload, so the bucket itself refuses an overwrite (AWS S3, R2 and B2 support it). */
  conditionalWrites: boolean;
}

const notFound = (error: unknown) =>
  (error instanceof S3ServiceException && (error.$metadata?.httpStatusCode === 404 || error.name === "NotFound" || error.name === "NoSuchKey")) ||
  (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404;

export class S3Store implements WritableStore {
  readonly label: string;
  private readonly client: S3Client;

  constructor(
    private readonly config: S3StoreConfig,
    requestHandler?: S3ClientConfig["requestHandler"]
  ) {
    this.label = `bucket ${config.bucket}${config.prefix ? `/${config.prefix.replace(/\/+$/, "")}` : ""}`;
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      requestHandler: requestHandler ?? { connectionTimeout: 10_000, requestTimeout: 15 * 60_000 },
      maxAttempts: 4,
    });
  }

  private full(key: string): string {
    assertObjectKey(key);

    return `${this.config.prefix}${key}`;
  }

  async list(prefix: string): Promise<ObjectInfo[]> {
    const out: ObjectInfo[] = [];
    let token: string | undefined;

    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: `${this.config.prefix}${prefix}`, ContinuationToken: token }));
      for (const item of page.Contents ?? []) {
        if (!item.Key) continue;
        out.push({ key: item.Key.slice(this.config.prefix.length), size: Number(item.Size ?? 0), ...(item.LastModified ? { lastModified: item.LastModified } : {}) });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);

    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: this.full(key) }));

      return { key, size: Number(result.ContentLength ?? 0), ...(result.LastModified ? { lastModified: result.LastModified } : {}) };
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  }

  async download(key: string, destinationFile: string): Promise<void> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: this.full(key) }));

    if (!result.Body) throw new Error(`Empty response for ${key}.`);
    await pipeline(result.Body as Readable, createWriteStream(destinationFile));
  }

  async upload(key: string, sourceFile: string, contentType = "application/octet-stream"): Promise<void> {
    if (await this.head(key)) throw new ObjectExistsError(key);

    const size = (await stat(sourceFile)).size;

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: this.full(key),
          Body: createReadStream(sourceFile),
          ContentLength: size,
          ContentType: contentType,
          ...(this.config.conditionalWrites ? { IfNoneMatch: "*" } : {}),
        })
      );
    } catch (error) {
      if (error instanceof S3ServiceException && (error.$metadata?.httpStatusCode === 412 || error.name === "PreconditionFailed")) throw new ObjectExistsError(key);
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: this.full(key) }));
  }
}

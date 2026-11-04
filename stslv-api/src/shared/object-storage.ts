import { DeleteObjectCommand, GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client, S3ServiceException, type S3ClientConfig } from "@aws-sdk/client-s3";
import type { ObjectStorageConfig } from "../config/storage-config";
import { assertStorageKey, StoredFileNotFoundError, type FileStorage } from "./storage";

/** Every object this application writes sits under this prefix, so the bucket can later hold other things beside it. */
export const OBJECT_KEY_PREFIX = "attachments/";

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/**
 * Files in a private bucket reached through an S3-compatible API: Supabase Storage (its /storage/v1/s3 endpoint) or
 * Cloudflare R2. Only PutObject, GetObject and DeleteObject are used, which both support. The bucket is never public
 * and no presigned or public link is ever created: the API reads the file and serves it after its own permission and
 * checksum checks, exactly as with the local folder. The access key lives only in the API's environment.
 */
/**
 * The S3 client for a bucket. `requestHandler` replaces the HTTP layer (tests record the exact requests with it).
 * Requests are plain SigV4 with a signed payload hash: no x-amz-checksum-* headers and no aws-chunked streaming,
 * which Supabase's S3 endpoint does not need (tests/object-storage.test.ts checks the headers sent over https).
 */
export function createS3Client(config: ObjectStorageConfig, requestHandler?: S3ClientConfig["requestHandler"]): S3Client {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // Path-style addressing (endpoint/bucket/key): Supabase requires it, and R2 supports it.
    forcePathStyle: true,
    // Only send/require checksums where the S3 API demands them; the API checks each file's SHA-256 itself on every read.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    // An unreachable store fails the request instead of holding it open.
    requestHandler: requestHandler ?? { connectionTimeout: 5_000, requestTimeout: 30_000 },
    maxAttempts: 3,
  });
}

/**
 * What went wrong with a storage request, in words safe to print or log: the provider's error code and HTTP status,
 * and its message reduced to one short line. Web addresses, signature fields, long tokens and every value in
 * `sensitive` (keys, project, bucket, host) are replaced, so no credential, signed header or private URL appears.
 * A response that is not an S3 XML error (Supabase's storage host answers an unknown project with the plain text
 * "Project not specified.") is shown as such, instead of the SDK's bare "Error".
 */
export function describeStorageError(error: unknown, sensitive: readonly string[] = []): string {
  const value = (error ?? {}) as { name?: string; message?: string; code?: string; $metadata?: { httpStatusCode?: number }; $responseBodyText?: string };
  const status = value.$metadata?.httpStatusCode;
  const at = status ? ` (HTTP ${status})` : "";
  const clean = (text: string) => {
    let line = text.split(/\r?\n/)[0] ?? "";
    for (const secret of sensitive) if (secret.length >= 3) line = line.split(secret).join("<redacted>");
    line = line
      .replace(/https?:\/\/\S+/gi, "<url>")
      .replace(/(Credential|Signature|X-Amz-[A-Za-z-]+|AWSAccessKeyId|Authorization)\s*[=:]\s*\S+/gi, "$1=<redacted>")
      .replace(/[A-Za-z0-9+/_=-]{24,}/g, "<redacted>")
      .trim();

    return line.length > 160 ? `${line.slice(0, 157)}...` : line;
  };

  if (typeof value.$responseBodyText === "string") {
    return `non-S3 response${at}: "${clean(value.$responseBodyText) || "(empty)"}"`;
  }
  if (error instanceof S3ServiceException) {
    const message = clean(error.message ?? "");

    return `S3 error ${error.name}${at}${message && message !== error.name ? `: ${message}` : ""}`;
  }
  if (value.code) {
    // A network error: ENOTFOUND (no such host), ECONNREFUSED, ETIMEDOUT...
    return `network error ${value.code}`;
  }

  return `${value.name ?? "error"}${at}`;
}

export class S3ObjectStorage implements FileStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: ObjectStorageConfig, client?: S3Client) {
    this.bucket = config.bucket;
    this.client = client ?? createS3Client(config);
  }

  private objectKey(key: string): string {
    assertStorageKey(key);

    return `${OBJECT_KEY_PREFIX}${key}`;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const objectKey = this.objectKey(key);

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: data,
        ContentLength: data.length,
        ContentType: CONTENT_TYPES[key.split(".").pop() ?? ""] ?? "application/octet-stream",
      })
    );
  }

  async get(key: string): Promise<Buffer> {
    const objectKey = this.objectKey(key);

    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }));

      if (!result.Body) {
        throw new StoredFileNotFoundError(key);
      }

      return Buffer.from(await result.Body.transformToByteArray());
    } catch (error) {
      if (error instanceof NoSuchKey || (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404)) {
        throw new StoredFileNotFoundError(key);
      }
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
  }
}

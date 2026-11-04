import { DeleteObjectCommand, GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import type { R2StorageConfig } from "../config/storage-config";
import { assertStorageKey, StoredFileNotFoundError, type FileStorage } from "./storage";

/** Every object this application writes sits under this prefix, so the bucket can later hold other things beside it. */
export const R2_KEY_PREFIX = "attachments/";

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/**
 * Files in a private Cloudflare R2 bucket, through R2's S3-compatible API. The bucket is never public and no
 * presigned or public link is ever created: the API reads the file and serves it after its own permission and
 * checksum checks, exactly as with the local folder. The access key lives only in the API's environment.
 */
export class R2Storage implements FileStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: R2StorageConfig, client?: S3Client) {
    this.bucket = config.bucket;
    this.client =
      client ??
      new S3Client({
        region: "auto",
        endpoint: config.endpoint,
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        // Path-style addressing (endpoint/bucket/key): R2 supports it, and it needs no per-bucket host name.
        forcePathStyle: true,
        // Only send/require checksums where the S3 API demands them; the API checks each file's SHA-256 itself on every read.
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
        // An unreachable store fails the request instead of holding it open.
        requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
        maxAttempts: 3,
      });
  }

  private objectKey(key: string): string {
    assertStorageKey(key);

    return `${R2_KEY_PREFIX}${key}`;
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

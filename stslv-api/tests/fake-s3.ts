import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A minimal in-process stand-in for an S3-compatible API such as Supabase Storage's /storage/v1/s3 or Cloudflare R2
 * (path-style PUT, GET and DELETE of one bucket), for the tests only. It checks what a real store would: a SigV4
 * signature header for the expected access key and region, and a payload hash that matches the body. `mode` makes it fail like an unreachable store ("down", HTTP 500) or a wrong key
 * ("denied", HTTP 403). Nothing leaves the machine.
 */
export class FakeS3 {
  readonly objects = new Map<string, Buffer>();
  readonly requests: { method: string; key: string }[] = [];
  mode: "ok" | "down" | "denied" = "ok";
  private server: Server | null = null;

  constructor(
    readonly bucket: string,
    readonly accessKeyId: string,
    readonly region = "auto",
    /** The path the S3 API is served under: "" for R2, "/storage/v1/s3" for Supabase. */
    readonly basePath = ""
  ) {}

  get endpoint(): string {
    return `http://127.0.0.1:${(this.server?.address() as AddressInfo).port}${this.basePath}`;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req).then(({ status, body, headers }) => {
        res.writeHead(status, headers);
        res.end(body);
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private async handle(req: IncomingMessage): Promise<{ status: number; body?: Buffer | string; headers?: Record<string, string> }> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", "http://fake");
    if (!url.pathname.startsWith(`${this.basePath}/`)) return { status: 404, body: "Not Found" };
    const [, bucket, ...rest] = url.pathname.slice(this.basePath.length).split("/");
    const key = decodeURIComponent(rest.join("/"));
    const xml = (code: string, message: string) => `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;
    const error = (status: number, code: string, message: string) => ({ status, body: xml(code, message), headers: { "Content-Type": "application/xml" } });

    this.requests.push({ method: req.method ?? "", key });

    if (this.mode === "down") return error(500, "InternalError", "We encountered an internal error. Please try again.");
    if (this.mode === "denied") return error(403, "AccessDenied", "Access Denied");

    const auth = req.headers.authorization ?? "";
    if (!new RegExp(`^AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/[0-9]{8}/${this.region}/s3/aws4_request,`).test(auth) || !auth.includes("Signature=")) {
      return error(403, "InvalidAccessKeyId", "The access key is not valid.");
    }
    if (bucket !== this.bucket) return error(404, "NoSuchBucket", "The specified bucket does not exist.");

    switch (req.method) {
      case "PUT": {
        const declared = req.headers["x-amz-content-sha256"];
        if (declared !== createHash("sha256").update(body).digest("hex")) {
          return error(400, "XAmzContentSHA256Mismatch", "The provided payload hash does not match the body.");
        }
        this.objects.set(key, body);
        return { status: 200, headers: { ETag: `"${createHash("md5").update(body).digest("hex")}"` } };
      }
      case "GET": {
        const object = this.objects.get(key);
        if (!object) return error(404, "NoSuchKey", "The specified key does not exist.");
        return { status: 200, body: object, headers: { "Content-Type": "application/octet-stream", "Content-Length": String(object.length) } };
      }
      case "DELETE":
        this.objects.delete(key);
        return { status: 204 };
      default:
        return error(405, "MethodNotAllowed", "Not supported here.");
    }
  }
}

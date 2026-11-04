import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { describeStorage, endpointNamesProject, resolveStorageConfig, type ObjectStorageConfig } from "../src/config/storage-config";
import { setStorageForTests } from "../src/modules/attachments/attachments.service";
import { createS3Client, describeStorageError, OBJECT_KEY_PREFIX, S3ObjectStorage } from "../src/shared/object-storage";
import { StoredFileNotFoundError } from "../src/shared/storage";
import { activeContract, createClient, newContractBody, TEST_PDF, visitsOf, type Session } from "./amc-helpers";
import { FakeS3 } from "./fake-s3";
import { api, closePool, resetData, signedIn } from "./helpers";

// Private bucket document storage (2026-11-04): Supabase Storage through its S3-compatible endpoint, or Cloudflare R2.
// The adapter is exercised against an in-process S3 stand-in (tests/fake-s3.ts) that serves the API under Supabase's
// /storage/v1/s3 path and checks the region in the signature. No real bucket, key or network is involved.
// Every record here is invented.

const REF = "abcdefghijklmnopqrst";
const REGION = "eu-central-1";
const BUCKET = "stslv-amc-documents";
const KEY_ID = "test-access-key-id";
const SECRET = "test-secret-access-key-not-real";
const supabaseVars = (extra: Record<string, string> = {}) => ({
  SUPABASE_PROJECT_REF: REF,
  SUPABASE_S3_REGION: REGION,
  SUPABASE_S3_BUCKET: BUCKET,
  SUPABASE_S3_ACCESS_KEY_ID: KEY_ID,
  SUPABASE_S3_SECRET_ACCESS_KEY: SECRET,
  ...extra,
});
const r2Vars = { R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", R2_BUCKET: BUCKET, R2_ACCESS_KEY_ID: KEY_ID, R2_SECRET_ACCESS_KEY: SECRET };

describe("choosing the document storage (resolveStorageConfig)", () => {
  it("uses Supabase Storage when all five values are set, with the project's direct storage endpoint", () => {
    expect(resolveStorageConfig(supabaseVars(), "production", "/app")).toEqual({
      driver: "supabase",
      bucket: BUCKET,
      region: REGION,
      endpoint: `https://${REF}.storage.supabase.co/storage/v1/s3`,
      accessKeyId: KEY_ID,
      secretAccessKey: SECRET,
    });
  });

  it("accepts an endpoint override, https only in production", () => {
    const other = `https://${REF}.supabase.co/storage/v1/s3`;
    expect((resolveStorageConfig(supabaseVars({ SUPABASE_S3_ENDPOINT: `${other}/` }), "production", "/app") as ObjectStorageConfig).endpoint).toBe(other);
    expect(() => resolveStorageConfig(supabaseVars({ SUPABASE_S3_ENDPOINT: "http://127.0.0.1:54321/storage/v1/s3" }), "production", "/app")).toThrow(/https/);
    expect(() => resolveStorageConfig(supabaseVars({ SUPABASE_S3_ENDPOINT: "not a url" }), "production", "/app")).toThrow(/SUPABASE_S3_ENDPOINT/);
  });

  it("refuses to start with a half-made configuration, naming what is missing but never a value", () => {
    const partial = { SUPABASE_PROJECT_REF: REF, SUPABASE_S3_SECRET_ACCESS_KEY: "secret-value-123" };
    let message = "";
    try {
      resolveStorageConfig(partial, "production", "/app");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("SUPABASE_S3_REGION, SUPABASE_S3_BUCKET, SUPABASE_S3_ACCESS_KEY_ID are missing");
    expect(message).not.toContain("secret-value-123");
    expect(() => resolveStorageConfig({ R2_BUCKET: BUCKET }, "production", "/app")).toThrow(/Cloudflare R2 .*partly configured/);
  });

  it("refuses more than one store, and malformed project references, regions or bucket names", () => {
    expect(() => resolveStorageConfig({ ...supabaseVars(), ...r2Vars }, "production", "/app")).toThrow(/More than one document storage/);
    expect(() => resolveStorageConfig(supabaseVars({ ATTACHMENTS_DIR: "/data" }), "production", "/app")).toThrow(/More than one document storage/);
    expect(() => resolveStorageConfig(supabaseVars({ SUPABASE_PROJECT_REF: "https://x.supabase.co" }), "production", "/app")).toThrow(/SUPABASE_PROJECT_REF/);
    expect(() => resolveStorageConfig(supabaseVars({ SUPABASE_S3_REGION: "Frankfurt" }), "production", "/app")).toThrow(/SUPABASE_S3_REGION/);
    expect(() => resolveStorageConfig(supabaseVars({ SUPABASE_S3_BUCKET: "Bad Bucket" }), "production", "/app")).toThrow(/SUPABASE_S3_BUCKET/);
  });

  it("still supports Cloudflare R2, and keeps the earlier behaviour without a bucket", () => {
    expect(resolveStorageConfig(r2Vars, "production", "/app")).toMatchObject({ driver: "r2", region: "auto", endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com" });
    expect(resolveStorageConfig({ ATTACHMENTS_DIR: "/data/files" }, "production", "/app")).toMatchObject({ driver: "local" });
    expect(resolveStorageConfig({}, "development", "/app")).toMatchObject({ driver: "local" });
    expect(resolveStorageConfig({}, "production", "/app")).toBeNull();
  });

  it("describes the store for the Security page without any secret, project, region or bucket name", () => {
    const text = JSON.stringify(describeStorage(resolveStorageConfig(supabaseVars(), "production", "/app")));
    expect(text).toContain("Supabase");
    for (const secret of [REF, REGION, KEY_ID, SECRET, BUCKET]) expect(text).not.toContain(secret);
    expect(describeStorage(null).kind).toBe("NONE");
  });
});

const fakeSupabase = () => new FakeS3(BUCKET, KEY_ID, REGION, "/storage/v1/s3");
const configFor = (s3: FakeS3) => resolveStorageConfig(supabaseVars({ SUPABASE_S3_ENDPOINT: s3.endpoint }), "test", "/app") as ObjectStorageConfig;

describe("S3ObjectStorage against a Supabase-style S3 endpoint", () => {
  const s3 = fakeSupabase();
  let store: S3ObjectStorage;
  const KEY = "11111111-2222-3333-4444-555555555555.pdf";

  beforeAll(async () => {
    await s3.start();
    store = new S3ObjectStorage(configFor(s3));
  });
  afterAll(() => s3.stop());
  beforeEach(() => {
    s3.mode = "ok";
  });

  it("stores, reads and removes a file under the attachments/ prefix, signed for the project's region", async () => {
    await store.put(KEY, TEST_PDF);
    expect([...s3.objects.keys()]).toContain(`${OBJECT_KEY_PREFIX}${KEY}`);
    expect(await store.get(KEY)).toEqual(TEST_PDF);
    // A new client, as after an API restart, reads the same file.
    expect(await new S3ObjectStorage(configFor(s3)).get(KEY)).toEqual(TEST_PDF);

    await store.remove(KEY);
    await expect(store.get(KEY)).rejects.toBeInstanceOf(StoredFileNotFoundError);
  });

  it("is refused when signed for the wrong region", async () => {
    const wrong = new S3ObjectStorage({ ...configFor(s3), region: "us-east-1" });
    await expect(wrong.put(KEY, TEST_PDF)).rejects.not.toBeInstanceOf(StoredFileNotFoundError);
    expect(s3.objects.has(`${OBJECT_KEY_PREFIX}${KEY}`)).toBe(false);
  });

  it("refuses any key the application did not generate, before a request is made", async () => {
    const before = s3.requests.length;
    for (const key of ["../secret.pdf", "attachments/../../x.pdf", "a.exe", "11111111-2222-3333-4444-555555555555.pdf/../x"]) {
      await expect(store.put(key, TEST_PDF)).rejects.toThrow("Invalid storage key.");
      await expect(store.get(key)).rejects.toThrow("Invalid storage key.");
    }
    expect(s3.requests.length).toBe(before);
  });

  it("tells a missing file apart from a store that cannot be reached", async () => {
    await expect(store.get("99999999-2222-3333-4444-555555555555.pdf")).rejects.toBeInstanceOf(StoredFileNotFoundError);
    s3.mode = "denied";
    const denied = await store.get(KEY).catch((error: unknown) => error);
    expect(denied).not.toBeInstanceOf(StoredFileNotFoundError);
  });
});

describe("Supabase S3 compatibility and error reporting (2026-11-04: a bare \"Error (HTTP 400)\")", () => {
  const s3 = fakeSupabase();
  const KEY = "22222222-3333-4444-5555-666666666666.pdf";

  beforeAll(() => s3.start());
  afterAll(() => s3.stop());

  it("reports Supabase's plain-text answer for an unknown project with its body, not as the SDK's bare Error", async () => {
    s3.mode = "unknown-project";
    const error = await new S3ObjectStorage(configFor(s3)).put(KEY, TEST_PDF).catch((caught: unknown) => caught);
    s3.mode = "ok";

    // What the SDK gives on its own: a plain Error named "Error" (the body is not S3 XML).
    expect((error as Error).name).toBe("Error");
    expect(describeStorageError(error)).toBe('non-S3 response (HTTP 400): "Project not specified."');
  });

  it("reports a real S3 error by its code, status and message", async () => {
    s3.mode = "denied";
    const error = await new S3ObjectStorage(configFor(s3)).put(KEY, TEST_PDF).catch((caught: unknown) => caught);
    s3.mode = "ok";

    expect(describeStorageError(error)).toBe("S3 error AccessDenied (HTTP 403): Access Denied");
  });

  it("never shows a key, secret, signature, token, address or configured value", () => {
    const leaky = Object.assign(new Error("x"), {
      $metadata: { httpStatusCode: 400 },
      $responseBodyText: `Bad request to https://${REF}.storage.supabase.co/storage/v1/s3/${BUCKET} Credential=${KEY_ID}/20261104/${REGION}/s3 Signature=0123456789abcdef0123456789abcdef secret ${SECRET} token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9xx\nsecond line`,
    });
    const text = describeStorageError(leaky, [KEY_ID, SECRET, REF, BUCKET, REGION]);

    for (const secret of [KEY_ID, SECRET, REF, BUCKET, REGION, "storage.supabase.co", "0123456789abcdef", "eyJhbGci", "second line"]) expect(text).not.toContain(secret);
    expect(text).toMatch(/^non-S3 response \(HTTP 400\): "Bad request to <url>/);
    expect(describeStorageError(Object.assign(new Error("getaddrinfo ENOTFOUND host"), { code: "ENOTFOUND" }))).toBe("network error ENOTFOUND");
  });

  it("sends Supabase a plain SigV4 PUT over https: path-style, signed for the project's region, no checksum or streaming headers", async () => {
    type Sent = { protocol: string; hostname: string; path: string; method: string; headers: Record<string, string> };
    const sent: { request?: Sent } = {};
    const recorder = {
      handle: async (request: Sent) => {
        sent.request = request;
        return { response: { statusCode: 200, headers: {}, body: Readable.from([]) } };
      },
    };
    const config = resolveStorageConfig(supabaseVars({ SUPABASE_S3_REGION: "ap-southeast-1" }), "production", "/app") as ObjectStorageConfig;

    await new S3ObjectStorage(config, createS3Client(config, recorder as never)).put(KEY, TEST_PDF);

    const request = sent.request as Sent;
    const headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]));
    expect(request.protocol).toBe("https:");
    expect(request.hostname).toBe(`${REF}.storage.supabase.co`);
    expect(request.method).toBe("PUT");
    expect(request.path).toBe(`/storage/v1/s3/${BUCKET}/${OBJECT_KEY_PREFIX}${KEY}`);
    expect(headers.authorization).toMatch(new RegExp(`^AWS4-HMAC-SHA256 Credential=${KEY_ID}/[0-9]{8}/ap-southeast-1/s3/aws4_request, SignedHeaders=`));
    expect(headers["x-amz-content-sha256"]).toBe(createHash("sha256").update(TEST_PDF).digest("hex"));
    expect(headers["content-length"]).toBe(String(TEST_PDF.length));
    expect(headers["content-type"]).toBe("application/pdf");
    // None of the newer SDK defaults that S3-compatible stores may reject.
    expect(Object.keys(headers).filter((name) => /checksum|decoded-content-length|trailer|^expect$/.test(name))).toEqual([]);
    expect(headers["content-encoding"] ?? "").not.toContain("aws-chunked");
  });
});

describe("a custom Supabase endpoint in production (the form the real bucket check passed with, 2026-11-04)", () => {
  // Invented values: a custom endpoint whose host is not the default <ref>.storage.supabase.co.
  const CUSTOM = "https://custom-host.example-storage.supabase.co/storage/v1/s3";
  const KEY = "33333333-4444-5555-6666-777777777777.pdf";

  it("is read by the API's own configuration (env.ts) at start, exactly as given, alongside the unchanged project reference", async () => {
    const run = promisify(execFile);
    const root = path.resolve(__dirname, "..");
    const { stdout } = await run(process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), "tests/fixtures/print-storage-env.ts"], {
      cwd: root,
      timeout: 60_000,
      env: {
        PATH: process.env.PATH ?? process.env.Path ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        NODE_ENV: "production",
        DOTENV_CONFIG_PATH: process.platform === "win32" ? "NUL" : "/dev/null",
        JWT_SECRET: "fixture-only-secret-0123456789abcdefghijklmnop",
        ...supabaseVars({ SUPABASE_S3_REGION: "ap-southeast-1", SUPABASE_S3_ENDPOINT: `${CUSTOM}/` }),
      },
    });

    expect(JSON.parse(stdout.trim().split(/\r?\n/).pop() as string)).toEqual({ driver: "supabase", endpoint: CUSTOM, region: "ap-southeast-1", bucket: BUCKET });
  });

  it("sends every request to the custom endpoint's host and path, never to the default host built from the project reference", async () => {
    const hosts: string[] = [];
    const paths: string[] = [];
    const recorder = {
      handle: async (request: { hostname: string; path: string }) => {
        hosts.push(request.hostname);
        paths.push(request.path);
        return { response: { statusCode: 200, headers: {}, body: Readable.from([TEST_PDF]) } };
      },
    };
    const config = resolveStorageConfig(supabaseVars({ SUPABASE_S3_REGION: "ap-southeast-1", SUPABASE_S3_ENDPOINT: CUSTOM }), "production", "/app") as ObjectStorageConfig;
    const store = new S3ObjectStorage(config, createS3Client(config, recorder as never));

    await store.put(KEY, TEST_PDF);
    await store.get(KEY);
    await store.remove(KEY);

    expect(new Set(hosts)).toEqual(new Set(["custom-host.example-storage.supabase.co"]));
    expect(paths.every((item) => item === `/storage/v1/s3/${BUCKET}/${OBJECT_KEY_PREFIX}${KEY}`)).toBe(true);
    expect(hosts).not.toContain(`${REF}.storage.supabase.co`);
  });

  it("keeps the project reference and the endpoint separate: still validated, never substituted, compared only as yes/no", () => {
    // The reference stays required and validated even when the endpoint is custom.
    expect(() => resolveStorageConfig(supabaseVars({ SUPABASE_S3_ENDPOINT: CUSTOM, SUPABASE_PROJECT_REF: "" }), "production", "/app")).toThrow(/SUPABASE_PROJECT_REF is missing/);
    expect(() => resolveStorageConfig(supabaseVars({ SUPABASE_S3_ENDPOINT: CUSTOM, SUPABASE_PROJECT_REF: "Not-A-Ref" }), "production", "/app")).toThrow(/Invalid SUPABASE_PROJECT_REF/);

    expect(endpointNamesProject(supabaseVars({ SUPABASE_S3_ENDPOINT: CUSTOM }))).toBe(false);
    expect(endpointNamesProject(supabaseVars({ SUPABASE_S3_ENDPOINT: `https://${REF}.storage.supabase.co/storage/v1/s3` }))).toBe(true);
    expect(endpointNamesProject(supabaseVars())).toBeNull();
  });
});

describe("the document workflows on bucket storage", () => {
  const s3 = fakeSupabase();
  let admin: Session;
  let procurement: Session;
  let clientId: string;

  const download = (url: string, session?: Session) => {
    const request = api().get(url);
    if (session) request.set(session.headers);

    return request.buffer(true).parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => done(null, Buffer.concat(chunks)));
    });
  };
  const contractCount = async () => ((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM amc_contracts_all")).rows[0] as { n: number }).n;
  const attachmentCount = async () => ((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM attachments")).rows[0] as { n: number }).n;
  const useBucket = () => setStorageForTests(new S3ObjectStorage(configFor(s3)));

  beforeAll(async () => {
    await s3.start();
    useBucket();
    await resetData();
    admin = await signedIn("admin@example.com", ["ADMIN"]);
    procurement = await signedIn("procurement@example.com", ["PROCUREMENT"]);
    clientId = await createClient(admin, "Bucket Storage Hotel");
  });
  afterAll(async () => {
    setStorageForTests(null);
    await s3.stop();
    await closePool();
  });
  beforeEach(() => {
    s3.mode = "ok";
  });

  it("creates a contract with its document in the bucket, and serves it back only to those allowed", async () => {
    const created = await api().post("/api/amc/contracts").set(admin.headers).send(await newContractBody(clientId));
    expect(created.status).toBe(201);

    const rows = await pool.query<{ id: string; storage_key: string }>("SELECT id, storage_key FROM attachments WHERE entity_type = 'amc_contracts' AND entity_id = $1", [created.body.data.id]);
    const row = rows.rows[0] as { id: string; storage_key: string };
    expect(s3.objects.get(`${OBJECT_KEY_PREFIX}${row.storage_key}`)).toEqual(TEST_PDF);

    const file = await download(`/api/attachments/${row.id}/download`, admin);
    expect(file.status).toBe(200);
    expect(file.body).toEqual(TEST_PDF);
    expect(file.headers["content-type"]).toBe("application/pdf");
    expect(file.headers["cache-control"]).toBe("no-store");

    // After a restart the API builds a new client; the file is still there because it lives in the bucket.
    useBucket();
    expect((await download(`/api/attachments/${row.id}/download`, admin)).body).toEqual(TEST_PDF);
    const listed = await api().get("/api/attachments").query({ entityType: "amc_contracts", entityId: created.body.data.id }).set(admin.headers);
    expect(listed.body.data[0].integrity).toBe("VERIFIED");
    expect(JSON.stringify(listed.body)).not.toMatch(/storage_?key|supabase|storage\/v1|attachments\//i);

    expect((await download(`/api/attachments/${row.id}/download`, procurement)).status).toBe(403);
    expect((await download(`/api/attachments/${row.id}/download`)).status).toBe(401);
  });

  it("refuses a file the bucket would never see: unsupported type or over the size limit", async () => {
    const before = s3.objects.size;
    const exe = await api().post("/api/amc/contracts").set(admin.headers).send(await newContractBody(clientId, { contractDocument: { fileName: "x.exe", contentBase64: Buffer.from("MZ...").toString("base64") } }));
    expect(exe.status).toBe(400);
    expect(s3.objects.size).toBe(before);
  });

  it("creates no contract and no document row when the bucket cannot be written", async () => {
    const before = { contracts: await contractCount(), attachments: await attachmentCount(), objects: s3.objects.size };

    for (const mode of ["denied", "down"] as const) {
      s3.mode = mode;
      const response = await api().post("/api/amc/contracts").set(admin.headers).send(await newContractBody(clientId));
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe("STORAGE_ERROR");
      expect(response.body.error.message).toContain("no contract was created");
      expect(JSON.stringify(response.body)).not.toMatch(/AccessDenied|InternalError|test-access-key/);
    }
    s3.mode = "ok";
    expect({ contracts: await contractCount(), attachments: await attachmentCount(), objects: s3.objects.size }).toEqual(before);
  });

  it("removes the stored object again when the contract itself is refused after the upload", async () => {
    const inactive = await createClient(admin, "Closed Bucket Hotel");
    await api().post(`/api/clients/${inactive}/deactivate`).set(admin.headers);
    const before = { contracts: await contractCount(), objects: s3.objects.size };

    const refused = await api().post("/api/amc/contracts").set(admin.headers).send(await newContractBody(inactive));

    expect(refused.status).toBe(400);
    expect({ contracts: await contractCount(), objects: s3.objects.size }).toEqual(before);
    expect(s3.requests.some((request) => request.method === "DELETE")).toBe(true);
  });

  it("reports an unreachable bucket as such when opening a document, not as a lost file", async () => {
    const row = (await pool.query<{ id: string }>("SELECT id FROM attachments WHERE entity_type = 'amc_contracts' ORDER BY id LIMIT 1")).rows[0] as { id: string };
    s3.mode = "down";

    const response = await api().get(`/api/attachments/${row.id}/download`).set(admin.headers);
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("STORAGE_ERROR");
  });

  it("stores and serves a visit's service report through the bucket", async () => {
    const contractId = await activeContract(admin, clientId, { maintenanceFrequency: "MONTHLY", contractValue: "1200.000", defaultVisitAmount: "100.000" });
    const visitId = (await visitsOf(contractId))[0]?.id as string;
    const report = Buffer.from("%PDF-1.4\n% service report in the bucket\n%%EOF\n");

    const uploaded = await api()
      .post(`/api/amc/service-status/${visitId}/report`)
      .set(admin.headers)
      .set("Content-Type", "application/octet-stream")
      .set("X-File-Name", "report.pdf")
      .send(report);
    expect(uploaded.status).toBe(201);
    expect([...s3.objects.values()].some((object) => object.equals(report))).toBe(true);

    const file = await download(`/api/amc/service-status/${visitId}/report/download`, admin);
    expect(file.status).toBe(200);
    expect(file.body).toEqual(report);
    expect((await download(`/api/amc/service-status/${visitId}/report/download`, procurement)).status).toBe(403);
  });
});

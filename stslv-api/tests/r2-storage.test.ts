import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { describeStorage, resolveStorageConfig, type R2StorageConfig } from "../src/config/storage-config";
import { setStorageForTests } from "../src/modules/attachments/attachments.service";
import { R2_KEY_PREFIX, R2Storage } from "../src/shared/r2-storage";
import { StoredFileNotFoundError } from "../src/shared/storage";
import { activeContract, createClient, newContractBody, TEST_PDF, visitsOf, type Session } from "./amc-helpers";
import { FakeS3 } from "./fake-s3";
import { api, closePool, resetData, signedIn } from "./helpers";

// Cloudflare R2 document storage (2026-11-04). The adapter is exercised against an in-process S3 stand-in
// (tests/fake-s3.ts), so no real bucket, key or network is involved. Every record here is invented.

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const KEY_ID = "test-access-key-id";
const vars = (extra: Record<string, string> = {}) => ({
  R2_ACCOUNT_ID: ACCOUNT,
  R2_BUCKET: "stslv-amc-documents",
  R2_ACCESS_KEY_ID: KEY_ID,
  R2_SECRET_ACCESS_KEY: "test-secret-access-key-not-real",
  ...extra,
});

describe("choosing the document storage (resolveStorageConfig)", () => {
  it("uses R2 when all four R2 values are set, with the account's default endpoint", () => {
    expect(resolveStorageConfig(vars(), "production", "/app")).toEqual({
      driver: "r2",
      accountId: ACCOUNT,
      bucket: "stslv-amc-documents",
      endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
      accessKeyId: KEY_ID,
      secretAccessKey: "test-secret-access-key-not-real",
    });
  });

  it("accepts a jurisdiction endpoint, https only in production", () => {
    const eu = `https://${ACCOUNT}.eu.r2.cloudflarestorage.com`;
    expect((resolveStorageConfig(vars({ R2_ENDPOINT: `${eu}/` }), "production", "/app") as R2StorageConfig).endpoint).toBe(eu);
    expect(() => resolveStorageConfig(vars({ R2_ENDPOINT: "http://127.0.0.1:9000" }), "production", "/app")).toThrow(/https/);
    expect((resolveStorageConfig(vars({ R2_ENDPOINT: "http://127.0.0.1:9000" }), "development", "/app") as R2StorageConfig).endpoint).toBe("http://127.0.0.1:9000");
    expect(() => resolveStorageConfig(vars({ R2_ENDPOINT: "not a url" }), "production", "/app")).toThrow(/R2_ENDPOINT/);
  });

  it("refuses to start with a half-made R2 configuration, naming what is missing but never a value", () => {
    const partial = { R2_ACCOUNT_ID: ACCOUNT, R2_SECRET_ACCESS_KEY: "secret-value-123" };
    expect(() => resolveStorageConfig(partial, "production", "/app")).toThrow("R2_BUCKET, R2_ACCESS_KEY_ID are missing");
    try {
      resolveStorageConfig(partial, "production", "/app");
    } catch (error) {
      expect((error as Error).message).not.toContain("secret-value-123");
    }
  });

  it("refuses R2 together with ATTACHMENTS_DIR, and malformed account IDs or bucket names", () => {
    expect(() => resolveStorageConfig(vars({ ATTACHMENTS_DIR: "/data" }), "production", "/app")).toThrow(/Choose one/);
    expect(() => resolveStorageConfig(vars({ R2_ACCOUNT_ID: "not-an-account" }), "production", "/app")).toThrow(/R2_ACCOUNT_ID/);
    expect(() => resolveStorageConfig(vars({ R2_BUCKET: "Bad_Bucket" }), "production", "/app")).toThrow(/R2_BUCKET/);
  });

  it("keeps the earlier behaviour without R2: ATTACHMENTS_DIR, the local default in development, nothing in production", () => {
    expect(resolveStorageConfig({ ATTACHMENTS_DIR: "/data/files" }, "production", "/app")).toMatchObject({ driver: "local" });
    expect(resolveStorageConfig({}, "development", "/app")).toMatchObject({ driver: "local" });
    expect(resolveStorageConfig({}, "production", "/app")).toBeNull();
  });

  it("describes the store for the Security page without any secret, account or bucket name", () => {
    const text = JSON.stringify(describeStorage(resolveStorageConfig(vars(), "production", "/app")));
    expect(text).toContain("R2");
    for (const secret of [ACCOUNT, KEY_ID, "test-secret-access-key-not-real", "stslv-amc-documents"]) expect(text).not.toContain(secret);
    expect(describeStorage(null).kind).toBe("NONE");
  });
});

describe("R2Storage against an S3-compatible endpoint", () => {
  const s3 = new FakeS3("stslv-amc-documents", KEY_ID);
  let store: R2Storage;
  const config = (): R2StorageConfig => ({ ...(resolveStorageConfig(vars({ R2_ENDPOINT: s3.endpoint }), "test", "/app") as R2StorageConfig) });
  const KEY = "11111111-2222-3333-4444-555555555555.pdf";

  beforeAll(async () => {
    await s3.start();
    store = new R2Storage(config());
  });
  afterAll(() => s3.stop());
  beforeEach(() => {
    s3.mode = "ok";
  });

  it("stores, reads and removes a file under the attachments/ prefix, signed with the access key", async () => {
    await store.put(KEY, TEST_PDF);
    expect([...s3.objects.keys()]).toContain(`${R2_KEY_PREFIX}${KEY}`);
    expect(await store.get(KEY)).toEqual(TEST_PDF);
    // A new client, as after an API restart, reads the same file.
    expect(await new R2Storage(config()).get(KEY)).toEqual(TEST_PDF);

    await store.remove(KEY);
    await expect(store.get(KEY)).rejects.toBeInstanceOf(StoredFileNotFoundError);
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

describe("the document workflows on R2 storage", () => {
  const s3 = new FakeS3("stslv-amc-documents", KEY_ID);
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
  const useR2 = () => setStorageForTests(new R2Storage(resolveStorageConfig(vars({ R2_ENDPOINT: s3.endpoint }), "test", "/app") as R2StorageConfig));

  beforeAll(async () => {
    await s3.start();
    useR2();
    await resetData();
    admin = await signedIn("admin@example.com", ["ADMIN"]);
    procurement = await signedIn("procurement@example.com", ["PROCUREMENT"]);
    clientId = await createClient(admin, "R2 Storage Hotel");
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
    expect(s3.objects.get(`${R2_KEY_PREFIX}${row.storage_key}`)).toEqual(TEST_PDF);

    const file = await download(`/api/attachments/${row.id}/download`, admin);
    expect(file.status).toBe(200);
    expect(file.body).toEqual(TEST_PDF);
    expect(file.headers["content-type"]).toBe("application/pdf");
    expect(file.headers["cache-control"]).toBe("no-store");

    // After a restart the API builds a new client; the file is still there because it lives in the bucket.
    useR2();
    expect((await download(`/api/attachments/${row.id}/download`, admin)).body).toEqual(TEST_PDF);
    const listed = await api().get("/api/attachments").query({ entityType: "amc_contracts", entityId: created.body.data.id }).set(admin.headers);
    expect(listed.body.data[0].integrity).toBe("VERIFIED");
    expect(JSON.stringify(listed.body)).not.toMatch(/storage_?key|r2\.cloudflarestorage|attachments\//i);

    expect((await download(`/api/attachments/${row.id}/download`, procurement)).status).toBe(403);
    expect((await download(`/api/attachments/${row.id}/download`)).status).toBe(401);
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
    const inactive = await createClient(admin, "Closed R2 Hotel");
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
    const report = Buffer.from("%PDF-1.4\n% service report on R2\n%%EOF\n");

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

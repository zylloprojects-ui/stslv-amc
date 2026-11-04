import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeS3 } from "./fake-s3";

// npm run storage:check (src/scripts/storage-check.ts), run as its own process exactly as the PowerShell launcher runs
// it: with Supabase settings only, and no database or session settings at all (2026-11-04: it used to load the
// database configuration and failed with "Missing required database environment variable(s)").

const run = promisify(execFile);
const root = path.resolve(__dirname, "..");
const REF = "abcdefghijklmnopqrst";
const REGION = "eu-central-1";
const BUCKET = "stslv-amc-documents";
const KEY_ID = "check-access-key-id";
const SECRET = "check-secret-access-key-not-real";

/** Only what a bare process needs to start, plus the given settings: no DB_*, no JWT_SECRET, and no .env file read. */
function bareEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const keep = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"];
  const env: NodeJS.ProcessEnv = {};
  for (const name of keep) if (process.env[name]) env[name] = process.env[name];

  return { ...env, NODE_ENV: "test", DOTENV_CONFIG_PATH: process.platform === "win32" ? "NUL" : "/dev/null", ...extra };
}

async function check(extra: Record<string, string>): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), "src/scripts/storage-check.ts"], {
      cwd: root,
      env: bareEnv(extra),
      timeout: 60_000,
    });
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
  }
}

describe("the standalone storage check (npm run storage:check)", () => {
  const s3 = new FakeS3(BUCKET, KEY_ID, REGION, "/storage/v1/s3");
  const settings = () => ({
    SUPABASE_PROJECT_REF: REF,
    SUPABASE_S3_REGION: REGION,
    SUPABASE_S3_BUCKET: BUCKET,
    SUPABASE_S3_ACCESS_KEY_ID: KEY_ID,
    SUPABASE_S3_SECRET_ACCESS_KEY: SECRET,
    SUPABASE_S3_ENDPOINT: s3.endpoint,
  });
  const neverPrinted = (output: string) => {
    for (const secret of [KEY_ID, SECRET, REF, REGION, BUCKET, "127.0.0.1"]) expect(output).not.toContain(secret);
  };

  beforeAll(() => s3.start());
  afterAll(() => s3.stop());

  it("uploads, downloads, compares the SHA-256 and deletes a probe file, with no database settings, leaving nothing behind", async () => {
    s3.mode = "ok";
    s3.requests.length = 0;

    const { code, output } = await check(settings());

    expect(output).not.toMatch(/database|DB_HOST|JWT_SECRET/i);
    expect(output).toContain("Document storage: SUPABASE");
    expect(output).toMatch(/OK {3}upload a \d+-byte probe file/);
    expect(output).toContain("OK   download it");
    expect(output).toContain("OK   SHA-256 of the download matches the upload");
    expect(output).toContain("OK   delete it");
    expect(output).toContain("OK   confirm it is gone");
    expect(output).toContain("Storage check passed.");
    expect(code).toBe(0);
    expect(s3.objects.size).toBe(0);
    expect(s3.requests.map((request) => request.method)).toEqual(["PUT", "GET", "DELETE", "GET"]);
    expect(s3.requests.every((request) => /^attachments\/[0-9a-f-]{36}\.pdf$/.test(request.key))).toBe(true);
    neverPrinted(output);
  });

  it("fails with the error's name and status only, when the keys are refused", async () => {
    s3.mode = "denied";

    const { code, output } = await check(settings());

    expect(code).toBe(1);
    expect(output).toContain("FAIL upload a");
    expect(output).toContain("(HTTP 403)");
    expect(output).toContain("Storage check FAILED.");
    expect(output).not.toContain("Access Denied");
    neverPrinted(output);
  });

  it("reports a half-made configuration by variable name, never by value", async () => {
    const { code, output } = await check({ SUPABASE_PROJECT_REF: REF, SUPABASE_S3_SECRET_ACCESS_KEY: SECRET });

    expect(code).toBe(1);
    expect(output).toContain("FAIL configuration");
    expect(output).toContain("SUPABASE_S3_REGION");
    neverPrinted(output);
  });
});

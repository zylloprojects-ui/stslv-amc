import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { setStorageForTests } from "../src/modules/attachments/attachments.service";
import { LocalDiskStorage } from "../src/shared/storage";

// Every new AMC contract carries its contract document (2026-11-03), so every test file that adds one stores a
// file. Each file gets its own temporary folder, removed afterwards, so nothing is written under stslv-api/storage.
// A test file may still set its own storage (attachments.test.ts does).
const folder = mkdtempSync(path.join(tmpdir(), "stslv-test-storage-"));

setStorageForTests(new LocalDiskStorage(folder));

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

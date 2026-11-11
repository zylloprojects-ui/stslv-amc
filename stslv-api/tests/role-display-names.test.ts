import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ExcelJS from "exceljs";
import type request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { loadMigrationFiles } from "../src/db/migrate";
import { FIXED_ACCESS, PERMISSION_CATALOG } from "../src/shared/permission-catalog";
import { BUILT_IN_ROLE_NAMES, LEGACY_ROLE_NAMES, PRIVILEGED_ROLES_LABEL } from "../src/shared/role-names";
import { api, closePool, insertUser, resetData, signedIn } from "./helpers";

// Client role names (2026-11-11, migration 0117): Admin -> Service Dept, Finance Executive -> Accounts,
// Master Data Executive -> AMC Sales. Only names change; codes, ids, grants and assignments do not.

type Session = Awaited<ReturnType<typeof signedIn>>;

const RENAMES = [
  { code: "ADMINISTRATOR", from: "Admin", to: "Service Dept" },
  { code: "FINANCE_EXECUTIVE", from: "Finance Executive", to: "Accounts" },
  { code: "MASTER_DATA_EXECUTIVE", from: "Master Data Executive", to: "AMC Sales" },
] as const;

const SUPER_ADMIN_BEFORE = "Full access to every module, including Admin accounts and all role permissions. Cannot be changed.";
const SUPER_ADMIN_AFTER = "Full access to every module, including Service Dept accounts and all role permissions. Cannot be changed.";

const migration0117 =loadMigrationFiles().find((migration) => migration.name === "client_role_display_names")?.sql ?? "";

let superAdmin: Session;

beforeEach(async () => {
  await resetData();
  superAdmin = await signedIn("super@example.com", ["ADMIN"]);
});

afterAll(closePool);

/** Everything that decides access, by role code: ids, active flags, grants and who holds each role. */
async function accessSnapshot(client: { query: typeof pool.query }) {
  const roles = await client.query("SELECT id, code, is_active FROM roles ORDER BY id");
  const grants = await client.query(
    "SELECT r.code, rp.module, rp.action FROM role_permissions rp JOIN roles r ON r.id = rp.role_id ORDER BY r.code, rp.module, rp.action"
  );
  const holders = await client.query("SELECT ur.user_id, r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id ORDER BY ur.user_id, r.code");

  return { roles: roles.rows, grants: grants.rows, holders: holders.rows };
}

describe("one set of role names", () => {
  it("the API constants rename exactly the three approved roles and keep the others", () => {
    expect(BUILT_IN_ROLE_NAMES).toEqual({
      ADMIN: "Super Admin",
      ADMINISTRATOR: "Service Dept",
      FINANCE_EXECUTIVE: "Accounts",
      MASTER_DATA_EXECUTIVE: "AMC Sales",
      AMC_OPERATIONS_EXECUTIVE: "AMC Operations Executive",
      VIEWER: "Viewer",
    });
    expect(LEGACY_ROLE_NAMES).toEqual({ ACCOUNTANT: "Accountant", PROCUREMENT: "Procurement", EXECUTION: "Execution", INVOICING: "Invoicing" });
    expect(PRIVILEGED_ROLES_LABEL).toBe("Super Admin and Service Dept");
  });

  it("the web app holds the same names (stslv-web/src/auth/roleNames.ts)", () => {
    const web = readFileSync(resolve(__dirname, "../../stslv-web/src/auth/roleNames.ts"), "utf8");
    const block = web.match(/BUILT_IN_ROLE_NAMES = \{([\s\S]*?)\} as const/)?.[1] ?? "";
    const names = Object.fromEntries([...block.matchAll(/(\w+): '([^']+)'/g)].map((match) => [match[1], match[2]]));

    expect(names).toEqual(BUILT_IN_ROLE_NAMES);
  });

  it("the migrated database uses them, by code", async () => {
    const rows = await pool.query<{ code: string; name: string }>("SELECT code, name FROM roles");
    const byCode = Object.fromEntries(rows.rows.map((row) => [row.code, row.name]));

    expect(byCode).toMatchObject({ ...BUILT_IN_ROLE_NAMES, ...LEGACY_ROLE_NAMES });
  });

  it("no role description names an old role", async () => {
    const rows = await pool.query<{ code: string; description: string | null }>("SELECT code, description FROM roles WHERE is_active");

    for (const row of rows.rows) {
      expect(row.description ?? "", row.code).not.toMatch(/(?<!Super )\bAdmin\b|Finance Executive|Master Data Executive/);
    }
    expect(rows.rows.find((row) => row.code === "ADMIN")?.description).toBe(SUPER_ADMIN_AFTER);
  });
});

describe("migration 0117", () => {
  it("renames only the three roles and leaves ids, codes, grants and assignments exactly as they were", async () => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      for (const rename of RENAMES) {
        await client.query("UPDATE roles SET name = $2 WHERE code = $1", [rename.code, rename.from]);
      }
      for (const [index, code] of ["ADMINISTRATOR", "FINANCE_EXECUTIVE", "MASTER_DATA_EXECUTIVE", "VIEWER"].entries()) {
        const user = await client.query<{ id: string }>("INSERT INTO users (email, full_name, password_hash) VALUES ($1, $1, 'x') RETURNING id", [`holder${index}@example.com`]);
        await client.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2", [user.rows[0]?.id, code]);
      }
      await client.query("UPDATE roles SET description = $1 WHERE code = 'ADMIN'", [SUPER_ADMIN_BEFORE]);
      const otherNames = await client.query("SELECT code, name FROM roles WHERE code <> ALL($1::text[]) ORDER BY id", [RENAMES.map((rename) => rename.code)]);
      const descriptions = async () => (await client.query("SELECT code, description FROM roles WHERE code <> 'ADMIN' ORDER BY id")).rows;
      const otherDescriptions = await descriptions();
      const before = await accessSnapshot(client);

      await client.query(migration0117);

      expect(await accessSnapshot(client)).toEqual(before);
      expect(await descriptions()).toEqual(otherDescriptions);
      expect((await client.query("SELECT description FROM roles WHERE code = 'ADMIN'")).rows[0].description).toBe(SUPER_ADMIN_AFTER);
      const names = await client.query<{ code: string; name: string }>("SELECT code, name FROM roles WHERE code = ANY($1::text[])", [RENAMES.map((rename) => rename.code)]);
      expect(Object.fromEntries(names.rows.map((row) => [row.code, row.name]))).toEqual(Object.fromEntries(RENAMES.map((rename) => [rename.code, rename.to])));
      expect((await client.query("SELECT code, name FROM roles WHERE code <> ALL($1::text[]) ORDER BY id", [RENAMES.map((rename) => rename.code)])).rows).toEqual(otherNames.rows);

      // Applying it again changes nothing.
      await client.query(migration0117);
      expect(await accessSnapshot(client)).toEqual(before);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("keeps a name Super Admin has already changed", async () => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await client.query("UPDATE roles SET name = 'Admin' WHERE code = 'ADMINISTRATOR'");
      await client.query("UPDATE roles SET name = 'Finance Team' WHERE code = 'FINANCE_EXECUTIVE'");
      await client.query(migration0117);

      const names = await client.query<{ code: string; name: string }>("SELECT code, name FROM roles WHERE code IN ('ADMINISTRATOR', 'FINANCE_EXECUTIVE')");
      expect(Object.fromEntries(names.rows.map((row) => [row.code, row.name]))).toEqual({ ADMINISTRATOR: "Service Dept", FINANCE_EXECUTIVE: "Finance Team" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("stops, changing nothing, when another role already uses a new name", async () => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await client.query("UPDATE roles SET name = 'Finance Executive' WHERE code = 'FINANCE_EXECUTIVE'");
      await client.query("INSERT INTO roles (code, name) VALUES ('ACCOUNTS_TEAM', 'accounts')");
      await client.query("SAVEPOINT before_0117");

      await expect(client.query(migration0117)).rejects.toThrow(/0117: another role already uses a new name: accounts \(ACCOUNTS_TEAM\)/);
      await client.query("ROLLBACK TO SAVEPOINT before_0117");
      expect((await client.query("SELECT name FROM roles WHERE code = 'FINANCE_EXECUTIVE'")).rows[0].name).toBe("Finance Executive");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("does not touch the audit history", () => {
    const statements = migration0117.replace(/^--.*$/gm, "");

    expect(statements).not.toMatch(/activity_logs|user_roles|role_permissions/i);
    expect(statements).not.toMatch(/\b(DELETE|INSERT|TRUNCATE|DROP|ALTER)\b/i);
  });
});

describe("the new names everywhere the API shows a role", () => {
  it("Roles & Permissions lists them, with the same codes", async () => {
    const response = await api().get("/api/roles").set(superAdmin.headers);
    expect(response.status).toBe(200);

    const roles = response.body.data.roles as { code: string; name: string }[];
    for (const rename of RENAMES) {
      expect(roles.find((role) => role.code === rename.code)?.name).toBe(rename.to);
    }
    expect(roles.map((role) => role.name)).not.toEqual(expect.arrayContaining(["Admin"]));
    expect(roles.map((role) => role.name)).not.toEqual(expect.arrayContaining(["Finance Executive"]));
    expect(roles.map((role) => role.name)).not.toEqual(expect.arrayContaining(["Master Data Executive"]));
  });

  it("the fixed-access text and the Users & Access description name Service Dept", () => {
    const text = JSON.stringify({ FIXED_ACCESS, users: PERMISSION_CATALOG.flatMap((section) => section.modules).find((entry) => entry.module === "USERS") });

    expect(text).toContain("Managing Super Admin and Service Dept accounts");
    expect(text).toContain("Service Dept also needs Users & Access Edit");
    expect(text).not.toMatch(/(?<!Super )\bAdmin\b/);
  });

  it("users list, sign-in, role assignment messages and the users export use them", async () => {
    await insertUser({ email: "sd@example.com", fullName: "Sam Service", roles: ["ADMINISTRATOR"] });
    await insertUser({ email: "acc@example.com", fullName: "Ann Accounts", roles: ["FINANCE_EXECUTIVE"] });
    await insertUser({ email: "sales@example.com", fullName: "Sal Sales", roles: ["MASTER_DATA_EXECUTIVE"] });

    const list = await api().get("/api/users").query({ pageSize: 100 }).set(superAdmin.headers);
    expect(list.status).toBe(200);
    const roleOf = (email: string) => (list.body.data.items as { email: string; roles: { code: string; name: string }[] }[]).find((user) => user.email === email)?.roles[0];
    expect(roleOf("sd@example.com")).toEqual(expect.objectContaining({ code: "ADMINISTRATOR", name: "Service Dept" }));
    expect(roleOf("acc@example.com")).toEqual(expect.objectContaining({ code: "FINANCE_EXECUTIVE", name: "Accounts" }));
    expect(roleOf("sales@example.com")).toEqual(expect.objectContaining({ code: "MASTER_DATA_EXECUTIVE", name: "AMC Sales" }));

    // Sign-in: the session names the role by its new name, and filtering users by the new name finds them.
    const accounts = await signedIn("accounts.user@example.com", ["FINANCE_EXECUTIVE"]);
    const me = await api().get("/api/auth/me").set(accounts.headers);
    expect(me.status).toBe(200);
    expect(JSON.stringify(me.body)).toContain('"name":"Accounts"');
    const search = await api().get("/api/users").query({ search: "AMC Sales" }).set(superAdmin.headers);
    expect((search.body.data.items as { email: string }[]).map((user) => user.email)).toEqual(["sales@example.com"]);

    // Service Dept may not assign Service Dept: the message uses the new name.
    const serviceDept = await signedIn("sd2@example.com", ["ADMINISTRATOR"]);
    const viewer = await insertUser({ email: "v@example.com", roles: ["VIEWER"] });
    const administratorId = (await pool.query<{ id: string }>("SELECT id FROM roles WHERE code = 'ADMINISTRATOR'")).rows[0]?.id;
    const refused = await api().put(`/api/users/${viewer}/roles`).set(serviceDept.headers).send({ roleIds: [administratorId] });
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toBe("Only Super Admin can assign the Service Dept role.");

    const binary = (res: request.Response, done: (error: Error | null, body: Buffer) => void) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => done(null, Buffer.concat(chunks)));
    };
    const file = await api().get("/api/users/export").query({ format: "xlsx" }).set(superAdmin.headers).buffer(true).parse(binary as never);
    expect(file.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.body as ExcelJS.Buffer);
    const cells: string[] = [];
    workbook.eachSheet((sheet) => sheet.eachRow((row) => cells.push(...(row.values as unknown[]).slice(1).map((value) => String(value ?? "")))));
    expect(cells).toEqual(expect.arrayContaining(["Service Dept", "Accounts", "AMC Sales"]));
    expect(cells).not.toEqual(expect.arrayContaining(["Admin"]));
    expect(cells).not.toEqual(expect.arrayContaining(["Finance Executive"]));
    expect(cells).not.toEqual(expect.arrayContaining(["Master Data Executive"]));
  });
});

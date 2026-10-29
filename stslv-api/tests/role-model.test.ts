import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { loadMigrationFiles } from "../src/db/migrate";
import { isGrantable, PERMISSION_CATALOG } from "../src/shared/permission-catalog";
import { ACTIONS } from "../src/shared/permissions";
import { defaultGrants, dependencyProblem, isInRoleScope, LEGACY_ROLE_CODES, roleScope, SIX_ROLE_CODES } from "../src/shared/role-model";
import { api, closePool, insertUser, permissionsVersion, resetData, roleId, signedIn } from "./helpers";

// The six-role model (approved 2026-10-29): migrations 0087/0088, scopes, dependencies and
// the rule that only Super Admin manages Super Admin and Admin.

type Session = Awaited<ReturnType<typeof signedIn>>;

let superAdmin: Session;
let admin: Session;

const grantsOf = async (code: string) =>
  (
    await pool.query<{ key: string }>(
      "SELECT rp.module || ':' || rp.action AS key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.code = $1",
      [code]
    )
  ).rows
    .map((row) => row.key)
    .sort();

const permissionsOf = (keys: string[]) => keys.map((key) => ({ module: key.split(":")[0], action: key.split(":")[1] }));

const setPermissions = async (session: Session, id: string, keys: string[], expectedVersion?: string) =>
  api()
    .put(`/api/roles/${id}/permissions`)
    .set(session.headers)
    .send({ expectedVersion: expectedVersion ?? (await permissionsVersion(id)), permissions: permissionsOf(keys) });

const MODULE_COUNT = () => PERMISSION_CATALOG.flatMap((section) => section.modules).length;

const migrationSql = (name: string) => loadMigrationFiles().find((migration) => migration.name === name)?.sql ?? "";

beforeEach(async () => {
  await resetData();
  superAdmin = await signedIn("super@example.com", ["ADMIN"]);
  admin = await signedIn("admin@example.com", ["ADMINISTRATOR"]);
});

afterAll(closePool);

describe("migration 0087: the six roles", () => {
  it("renames ADMIN to Super Admin and adds the five roles, keeping the ADMIN code", async () => {
    const roles = await pool.query<{ code: string; name: string; is_active: boolean }>(
      "SELECT code, name, is_active FROM roles WHERE code = ANY($1::text[]) ORDER BY id",
      [[...SIX_ROLE_CODES]]
    );

    expect(roles.rows.map((row) => [row.code, row.name])).toEqual([
      ["ADMIN", "Super Admin"],
      ["ADMINISTRATOR", "Admin"],
      ["FINANCE_EXECUTIVE", "Finance Executive"],
      ["MASTER_DATA_EXECUTIVE", "Master Data Executive"],
      ["AMC_OPERATIONS_EXECUTIVE", "AMC Operations Executive"],
      ["VIEWER", "Viewer"],
    ]);
  });

  it("seeds exactly the starting grants of the role model (0087, revised by 0090)", async () => {
    for (const code of SIX_ROLE_CODES.filter((code) => code !== "ADMIN")) {
      expect(await grantsOf(code), code).toEqual([...defaultGrants(code)].sort());
    }
  });

  it("replaces the Executive roles' cross-section View with data-only Read (0090)", async () => {
    expect(await grantsOf("FINANCE_EXECUTIVE")).toEqual(["AMC_SCHEDULE:READ", "DASHBOARD:VIEW", "INVOICES:CREATE", "INVOICES:EDIT", "INVOICES:EXPORT", "INVOICES:VIEW"]);
    const operations = await grantsOf("AMC_OPERATIONS_EXECUTIVE");
    expect(operations).toEqual(expect.arrayContaining(["CLIENTS:READ", "INVOICES:READ"]));
    expect(operations).not.toContain("CLIENTS:VIEW");
    expect(operations).not.toContain("INVOICES:VIEW");
    expect(await grantsOf("ADMINISTRATOR")).not.toContain("USERS:DELETE");
  });

  it("keeps Super Admin's full access and gives nobody a new role", async () => {
    expect(await grantsOf("ADMIN")).toHaveLength(MODULE_COUNT() * ACTIONS.length);
    const assigned = await pool.query("SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.code = 'FINANCE_EXECUTIVE'");
    expect(assigned.rowCount).toBe(0);
  });

  it("is idempotent: 0087 then 0090 again changes nothing", async () => {
    const before = await pool.query("SELECT r.code || ':' || rp.module || ':' || rp.action AS key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id ORDER BY 1");
    await pool.query(migrationSql("six_role_model"));
    await pool.query(migrationSql("role_model_refinements"));
    const after = await pool.query("SELECT r.code || ':' || rp.module || ':' || rp.action AS key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id ORDER BY 1");
    expect(after.rows).toEqual(before.rows);
  });
});

describe("migration 0088: legacy roles made inactive", () => {
  it("stops and changes nothing while a user holds a legacy role", async () => {
    await insertUser({ email: "legacy@example.com", roles: ["ACCOUNTANT"] });
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await expect(client.query(migrationSql("deactivate_legacy_roles"))).rejects.toThrow(/0088: 1 user\(s\) still hold a legacy role/);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    const active = await pool.query("SELECT count(*)::int AS n FROM roles WHERE code = ANY($1::text[]) AND is_active", [[...LEGACY_ROLE_CODES]]);
    expect(active.rows[0].n).toBe(4);
  });

  it("makes them inactive, keeping every grant, when nobody holds one", async () => {
    const grantsBefore = await Promise.all(LEGACY_ROLE_CODES.map(grantsOf));
    await pool.query(migrationSql("deactivate_legacy_roles"));

    const roles = await pool.query<{ is_active: boolean }>("SELECT is_active FROM roles WHERE code = ANY($1::text[])", [[...LEGACY_ROLE_CODES]]);
    expect(roles.rows.map((row) => row.is_active)).toEqual([false, false, false, false]);
    expect(await Promise.all(LEGACY_ROLE_CODES.map(grantsOf))).toEqual(grantsBefore);

    // An inactive role cannot be assigned.
    const target = await insertUser({ email: "target@example.com", roles: ["VIEWER"] });
    const assign = await api().put(`/api/users/${target}/roles`).set(superAdmin.headers).send({ roleIds: [await roleId("ACCOUNTANT")] });
    expect(assign.status).toBe(400);
  });
});

describe("role scopes", () => {
  it("limits each Executive role to its section's pages, plus Dashboard and data-only reads", () => {
    expect(isInRoleScope("FINANCE_EXECUTIVE", "INVOICES", "CREATE")).toBe(true);
    expect(isInRoleScope("FINANCE_EXECUTIVE", "AMC_SCHEDULE", "READ")).toBe(true);
    expect(isInRoleScope("FINANCE_EXECUTIVE", "AMC_SCHEDULE", "VIEW")).toBe(false);
    expect(isInRoleScope("FINANCE_EXECUTIVE", "AMC_SCHEDULE", "EDIT")).toBe(false);
    expect(isInRoleScope("FINANCE_EXECUTIVE", "CLIENTS", "EDIT")).toBe(false);
    expect(isInRoleScope("MASTER_DATA_EXECUTIVE", "SYSTEM_TYPES", "DELETE")).toBe(true);
    expect(isInRoleScope("MASTER_DATA_EXECUTIVE", "AMC_CONTRACTS", "VIEW")).toBe(false);
    expect(isInRoleScope("AMC_OPERATIONS_EXECUTIVE", "AMC_EXECUTION", "APPROVE")).toBe(true);
    expect(isInRoleScope("AMC_OPERATIONS_EXECUTIVE", "INVOICES", "READ")).toBe(true);
    expect(isInRoleScope("AMC_OPERATIONS_EXECUTIVE", "CLIENTS", "READ")).toBe(true);
    expect(isInRoleScope("AMC_OPERATIONS_EXECUTIVE", "INVOICES", "VIEW")).toBe(false);
    expect(isInRoleScope("AMC_OPERATIONS_EXECUTIVE", "CLIENTS", "VIEW")).toBe(false);
    expect(isInRoleScope("AMC_OPERATIONS_EXECUTIVE", "USERS", "VIEW")).toBe(false);
  });

  it("gives each Executive role View only on the pages of its own section (and the Dashboard)", () => {
    const sectionOf = new Map(PERMISSION_CATALOG.flatMap((section) => section.modules.map((entry) => [entry.module, section.title] as const)));
    const own: Record<string, string> = { FINANCE_EXECUTIVE: "Finance", MASTER_DATA_EXECUTIVE: "Master Data Center", AMC_OPERATIONS_EXECUTIVE: "AMC Operations" };

    for (const [code, section] of Object.entries(own)) {
      const views = (roleScope(code) ?? []).filter((key) => key.endsWith(":VIEW")).map((key) => key.split(":")[0]);
      expect(views.filter((module) => module !== "DASHBOARD" && sectionOf.get(module as never) !== section), code).toEqual([]);
    }
  });

  it("gives Viewer only View and Export, never Administration or data-only Read", () => {
    const scope = roleScope("VIEWER") ?? [];
    expect(scope.every((key) => key.endsWith(":VIEW") || key.endsWith(":EXPORT"))).toBe(true);
    expect(scope.some((key) => key.startsWith("USERS:") || key.startsWith("SETTINGS:"))).toBe(false);
    expect(scope).toContain("CLIENTS:EXPORT");
  });

  it("never puts an unused or retired permission in scope", () => {
    for (const code of SIX_ROLE_CODES) {
      for (const section of PERMISSION_CATALOG) {
        for (const entry of section.modules) {
          for (const action of ACTIONS) {
            if (isInRoleScope(code, entry.module, action)) {
              expect(isGrantable(entry.module, action), `${code} ${entry.module}:${action}`).toBe(true);
            }
          }
        }
      }
    }
  });

  it("refuses a grant outside the role's scope, through the API", async () => {
    const id = await roleId("FINANCE_EXECUTIVE");
    const current = await grantsOf("FINANCE_EXECUTIVE");

    for (const key of ["CLIENTS:VIEW", "AMC_SCHEDULE:VIEW"]) {
      const outside = await setPermissions(superAdmin, id, [...current, key]);
      expect(outside.status, key).toBe(400);
      expect(outside.body.error.message).toContain("outside the access this role is limited to");
    }

    const viewerCreate = await setPermissions(superAdmin, await roleId("VIEWER"), [...(await grantsOf("VIEWER")), "CLIENTS:CREATE"]);
    expect(viewerCreate.status).toBe(400);
    const viewerRead = await setPermissions(superAdmin, await roleId("VIEWER"), [...(await grantsOf("VIEWER")), "AMC_SCHEDULE:READ"]);
    expect(viewerRead.status).toBe(400);

    const viewerExport = await setPermissions(superAdmin, await roleId("VIEWER"), [...(await grantsOf("VIEWER")), "CLIENTS:EXPORT"]);
    expect(viewerExport.status).toBe(200);
    expect(await grantsOf("FINANCE_EXECUTIVE")).toEqual(current);
  });

  it("offers data-only Read only where another section's page shows the module's data", () => {
    const reads = PERMISSION_CATALOG.flatMap((section) => section.modules.filter((entry) => entry.actions.READ !== undefined).map((entry) => entry.module)).sort();
    expect(reads).toEqual(["AMC_SCHEDULE", "CLIENTS", "INVOICES"]);
  });
});

describe("permission dependencies", () => {
  it("needs View for every other action and Edit for cancelling a contract; data-only Read stands alone", () => {
    expect(dependencyProblem(new Set(["CLIENTS:EDIT"]))).toEqual({ key: "CLIENTS:EDIT", missing: "CLIENTS:VIEW" });
    expect(dependencyProblem(new Set(["AMC_CONTRACTS:VIEW", "AMC_CONTRACTS:DELETE"]))).toEqual({ key: "AMC_CONTRACTS:DELETE", missing: "AMC_CONTRACTS:EDIT" });
    expect(dependencyProblem(new Set(["CLIENTS:VIEW", "CLIENTS:EDIT"]))).toBeNull();
    expect(dependencyProblem(new Set(["INVOICES:READ"]))).toBeNull();
    // A retired grant held without View is left as it is.
    expect(dependencyProblem(new Set(["EXPENSES:EDIT"]))).toBeNull();
  });

  it("refuses a set with a missing dependency, through the API, and changes nothing", async () => {
    const id = await roleId("MASTER_DATA_EXECUTIVE");
    const before = await grantsOf("MASTER_DATA_EXECUTIVE");

    const response = await setPermissions(superAdmin, id, before.filter((key) => key !== "CLIENTS:VIEW"));
    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe("CLIENTS:CREATE also needs CLIENTS:VIEW. Grant both, or neither.");
    expect(await grantsOf("MASTER_DATA_EXECUTIVE")).toEqual(before);
  });

  it("every starting grant set is consistent", () => {
    for (const code of SIX_ROLE_CODES.filter((code) => code !== "ADMIN")) {
      expect(dependencyProblem(new Set(defaultGrants(code))), code).toBeNull();
    }
  });
});

describe("only Super Admin changes roles and permissions", () => {
  it("Super Admin's permissions are fixed for everyone", async () => {
    const response = await setPermissions(superAdmin, await roleId("ADMIN"), []);
    expect(response.status).toBe(403);
  });

  it("Admin changes no role's permissions, not even of the Executive roles or Viewer", async () => {
    for (const code of ["ADMINISTRATOR", "FINANCE_EXECUTIVE", "MASTER_DATA_EXECUTIVE", "AMC_OPERATIONS_EXECUTIVE", "VIEWER"]) {
      const id = await roleId(code);
      const before = await grantsOf(code);
      const response = await setPermissions(admin, id, before.filter((key) => key !== "DASHBOARD:VIEW"));

      expect(response.status, code).toBe(403);
      expect(response.body.error.message).toBe("Only Super Admin can change roles and their permissions.");
      expect(await grantsOf(code)).toEqual(before);
    }
  });

  it("Super Admin changes any other role's permissions", async () => {
    const id = await roleId("VIEWER");
    const response = await setPermissions(superAdmin, id, [...(await grantsOf("VIEWER")), "INVOICES:EXPORT"]);

    expect(response.status).toBe(200);
    expect(await grantsOf("VIEWER")).toContain("INVOICES:EXPORT");
    expect((await setPermissions(superAdmin, await roleId("ADMINISTRATOR"), (await grantsOf("ADMINISTRATOR")).filter((key) => key !== "CLIENTS:EXPORT"))).status).toBe(200);
  });

  it("Admin cannot add, rename, deactivate, reactivate or delete any role", async () => {
    const custom = await api().post("/api/roles").set(admin.headers).send({ code: "CUSTOM_ROLE", name: "Custom" });
    expect(custom.status).toBe(403);

    for (const code of ["ADMIN", "ADMINISTRATOR", "FINANCE_EXECUTIVE", "VIEWER", "ACCOUNTANT"]) {
      const id = await roleId(code);
      expect((await api().patch(`/api/roles/${id}`).set(admin.headers).send({ name: "Renamed" })).status, code).toBe(403);
      expect((await api().patch(`/api/roles/${id}`).set(admin.headers).send({ isActive: false })).status, code).toBe(403);
      expect((await api().delete(`/api/roles/${id}`).set(admin.headers)).status, code).toBe(403);
    }

    // Reactivating a legacy role made inactive by 0088.
    await pool.query("UPDATE roles SET is_active = false WHERE code = 'ACCOUNTANT'");
    expect((await api().patch(`/api/roles/${await roleId("ACCOUNTANT")}`).set(admin.headers).send({ isActive: true })).status).toBe(403);
    expect((await pool.query("SELECT is_active FROM roles WHERE code = 'ACCOUNTANT'")).rows[0].is_active).toBe(false);
    expect((await pool.query("SELECT name FROM roles WHERE code = 'FINANCE_EXECUTIVE'")).rows[0].name).toBe("Finance Executive");
  });

  it("no built-in role is ever deleted, even by Super Admin; a custom one may be", async () => {
    for (const code of ["ADMIN", "ADMINISTRATOR", "FINANCE_EXECUTIVE", "MASTER_DATA_EXECUTIVE", "AMC_OPERATIONS_EXECUTIVE", "VIEWER", "ACCOUNTANT", "PROCUREMENT", "EXECUTION", "INVOICING"]) {
      const response = await api().delete(`/api/roles/${await roleId(code)}`).set(superAdmin.headers);
      expect(response.status, code).toBe(403);
    }
    expect((await pool.query("SELECT count(*)::int AS n FROM roles")).rows[0].n).toBe(10);

    const custom = await api().post("/api/roles").set(superAdmin.headers).send({ code: "CUSTOM_ROLE", name: "Custom" });
    expect(custom.status).toBe(201);
    expect((await api().delete(`/api/roles/${custom.body.data.id}`).set(superAdmin.headers)).status).toBe(200);
  });

  it("Super Admin may rename or reactivate a built-in role", async () => {
    await pool.query("UPDATE roles SET is_active = false WHERE code = 'ACCOUNTANT'");
    const id = await roleId("ACCOUNTANT");

    expect((await api().patch(`/api/roles/${id}`).set(superAdmin.headers).send({ isActive: true })).status).toBe(200);
    expect((await api().patch(`/api/roles/${id}`).set(superAdmin.headers).send({ name: "Accounts (legacy)" })).status).toBe(200);
  });

  it("shows each viewer what they may change and assign", async () => {
    const asAdmin = (await api().get("/api/roles").set(admin.headers)).body.data.roles as {
      code: string;
      permissionsEditable: boolean;
      lockedReason: string | null;
      assignable: boolean;
      builtIn: boolean;
      permissionsVersion: string;
      scope: string[] | null;
    }[];
    const byCode = (code: string) => asAdmin.find((role) => role.code === code);

    expect(byCode("ADMIN")).toMatchObject({ permissionsEditable: false, assignable: false, scope: null, builtIn: true });
    expect(byCode("ADMINISTRATOR")).toMatchObject({ permissionsEditable: false, assignable: false, lockedReason: "Only Super Admin can change role permissions." });
    // Admin may assign the operational roles, but change none of them.
    expect(byCode("FINANCE_EXECUTIVE")).toMatchObject({ permissionsEditable: false, assignable: true });
    expect(byCode("AMC_OPERATIONS_EXECUTIVE")).toMatchObject({ permissionsEditable: false, assignable: true });
    expect(byCode("FINANCE_EXECUTIVE")?.scope).toContain("AMC_SCHEDULE:READ");
    expect(byCode("FINANCE_EXECUTIVE")?.permissionsVersion).toMatch(/^[0-9a-f]{16}$/);

    const asSuper = (await api().get("/api/roles").set(superAdmin.headers)).body.data.roles as { code: string; permissionsEditable: boolean; assignable: boolean }[];
    expect(asSuper.find((role) => role.code === "ADMINISTRATOR")).toMatchObject({ permissionsEditable: true, assignable: true });
    expect(asSuper.find((role) => role.code === "VIEWER")).toMatchObject({ permissionsEditable: true });
  });
});

describe("concurrent permission changes", () => {
  it("refuses a save that started from an older permission set, and keeps the other change", async () => {
    const id = await roleId("VIEWER");
    const opened = await permissionsVersion(id);
    const base = await grantsOf("VIEWER");

    // First administrator saves.
    expect((await setPermissions(superAdmin, id, [...base, "CLIENTS:EXPORT"], opened)).status).toBe(200);

    // Second administrator saves from the same starting point.
    const stale = await setPermissions(superAdmin, id, [...base, "INVOICES:EXPORT"], opened);
    expect(stale.status).toBe(409);
    expect(stale.body.error.message).toContain("changed by someone else");

    const after = await grantsOf("VIEWER");
    expect(after).toContain("CLIENTS:EXPORT");
    expect(after).not.toContain("INVOICES:EXPORT");
  });

  it("needs the version it started from", async () => {
    const response = await api()
      .put(`/api/roles/${await roleId("VIEWER")}/permissions`)
      .set(superAdmin.headers)
      .send({ permissions: [] });
    expect(response.status).toBe(400);
  });
});

describe("only Super Admin manages Super Admin and Admin accounts", () => {
  it("Admin cannot assign the Super Admin or Admin role", async () => {
    const target = await insertUser({ email: "target@example.com", roles: ["VIEWER"] });

    for (const code of ["ADMIN", "ADMINISTRATOR"]) {
      const response = await api().put(`/api/users/${target}/roles`).set(admin.headers).send({ roleIds: [await roleId(code)] });
      expect(response.status, code).toBe(403);
    }

    const create = await api()
      .post("/api/users")
      .set(admin.headers)
      .send({ email: "new-admin@example.com", fullName: "New Admin", password: "Correct-Horse-42", roleIds: [await roleId("ADMINISTRATOR")] });
    expect(create.status).toBe(403);
  });

  it("Admin cannot edit, deactivate, change or reset the password of a Super Admin or another Admin", async () => {
    const other = await insertUser({ email: "other-admin@example.com", roles: ["ADMINISTRATOR"] });

    for (const id of [superAdmin.id, other]) {
      expect((await api().patch(`/api/users/${id}`).set(admin.headers).send({ fullName: "Changed" })).status).toBe(403);
      expect((await api().post(`/api/users/${id}/deactivate`).set(admin.headers)).status).toBe(403);
      expect((await api().put(`/api/users/${id}/roles`).set(admin.headers).send({ roleIds: [await roleId("VIEWER")] })).status).toBe(403);
      expect((await api().post(`/api/users/${id}/temporary-password`).set(admin.headers).send({ identityVerified: true })).status).toBe(403);
    }
  });

  it("Admin manages the users of the other roles", async () => {
    const create = await api()
      .post("/api/users")
      .set(admin.headers)
      .send({ email: "finance@example.com", fullName: "Finance", password: "Correct-Horse-42", roleIds: [await roleId("FINANCE_EXECUTIVE")] });
    expect(create.status).toBe(201);

    const id = create.body.data.id as string;
    expect((await api().put(`/api/users/${id}/roles`).set(admin.headers).send({ roleIds: [await roleId("VIEWER")] })).status).toBe(200);
    expect((await api().post(`/api/users/${id}/temporary-password`).set(admin.headers).send({ identityVerified: true })).status).toBe(200);
    expect((await api().post(`/api/users/${id}/deactivate`).set(admin.headers)).status).toBe(200);
  });

  it("Super Admin assigns the Admin role", async () => {
    const target = await insertUser({ email: "target@example.com", roles: ["VIEWER"] });
    const response = await api().put(`/api/users/${target}/roles`).set(superAdmin.headers).send({ roleIds: [await roleId("ADMINISTRATOR")] });

    expect(response.status).toBe(200);
    expect(response.body.data.roles.map((role: { code: string }) => role.code)).toEqual(["ADMINISTRATOR"]);
  });

  it("Admin keeps the administrator pages: Audit Log and Suggestions Review", async () => {
    expect((await api().get("/api/audit/activity").set(admin.headers)).status).toBe(200);
    expect((await api().get("/api/suggestions/review").set(admin.headers)).status).toBe(200);

    const viewer = await signedIn("viewer@example.com", ["VIEWER"]);
    expect((await api().get("/api/audit/activity").set(viewer.headers)).status).toBe(403);
    expect((await api().get("/api/suggestions/review").set(viewer.headers)).status).toBe(403);
  });
});

describe("each role's starting access, called directly", () => {
  const status = async (session: Session, method: "get" | "post", path: string, body: object = {}) =>
    (method === "get" ? await api().get(path).set(session.headers) : await api().post(path).set(session.headers).send(body)).status;

  const client = { name: "Direct Call", clientType: "COMPANY" };

  it("Finance Executive: Finance pages only, with visit details as data-only read", async () => {
    const finance = await signedIn("finance@example.com", ["FINANCE_EXECUTIVE"]);

    expect(await status(finance, "get", "/api/invoices")).toBe(200);
    expect(await status(finance, "get", "/api/invoices/export")).not.toBe(403);
    expect(await status(finance, "get", "/api/accounts")).toBe(200);
    expect(await status(finance, "get", "/api/accounts/export?format=xlsx")).not.toBe(403);
    // Invoice Tracking still lists the completed visits waiting for an invoice.
    const billable = await api().get("/api/invoices/billable").set(finance.headers);
    expect(billable.status).toBe(200);
    expect(billable.body.data.amcVisits).not.toBeNull();

    // None of the AMC schedule's own pages or lists.
    expect(await status(finance, "get", "/api/amc/visits")).toBe(403);
    expect(await status(finance, "get", "/api/amc/visits/export?format=xlsx")).toBe(403);
    expect(await status(finance, "get", "/api/amc/master-status")).toBe(403);
    expect(await status(finance, "get", "/api/amc/contracts")).toBe(403);
    expect(await status(finance, "get", "/api/clients")).toBe(403);
    expect(await status(finance, "get", "/api/users")).toBe(403);
  });

  it("Master Data Executive: Master Data Center only", async () => {
    const master = await signedIn("master@example.com", ["MASTER_DATA_EXECUTIVE"]);

    expect(await status(master, "get", "/api/clients")).toBe(200);
    expect(await status(master, "post", "/api/clients", client)).toBe(201);
    expect(await status(master, "get", "/api/masters/sales-engineers")).toBe(200);
    expect(await status(master, "get", "/api/invoices")).toBe(403);
    expect(await status(master, "get", "/api/amc/contracts")).toBe(403);
  });

  it("AMC Operations Executive: AMC pages only, with clients and invoice numbers as data-only read", async () => {
    const operations = await signedIn("operations@example.com", ["AMC_OPERATIONS_EXECUTIVE"]);
    const created = await api().post("/api/clients").set(superAdmin.headers).send({ name: "Ops Client", clientType: "COMPANY" });
    const clientId = created.body.data.id as string;

    expect(await status(operations, "get", "/api/amc/contracts")).toBe(200);
    expect(await status(operations, "get", "/api/amc/visits")).toBe(200);
    // Master AMC Status and AMC Management keep their invoice numbers.
    expect(await status(operations, "get", "/api/amc/master-status")).toBe(200);
    const management = await api().get("/api/amc/management/summary").set(operations.headers);
    expect(management.status).toBe(200);
    expect(management.body.data.invoices).not.toBeNull();
    // The invoices of one contract or visit (contract and visit details), and the client list (pickers).
    expect(await status(operations, "get", "/api/invoices?amcContractId=1")).toBe(200);
    expect(await status(operations, "get", "/api/invoices?amcVisitId=1")).toBe(200);
    expect(await status(operations, "get", "/api/clients")).toBe(200);

    // But no Clients or Finance page: not a client's details, not Invoice Tracking, not Accounts.
    expect(await status(operations, "get", `/api/clients/${clientId}`)).toBe(403);
    expect(await status(operations, "get", `/api/clients/${clientId}/summary`)).toBe(403);
    expect(await status(operations, "get", "/api/clients/export?format=xlsx")).toBe(403);
    expect(await status(operations, "post", "/api/clients", client)).toBe(403);
    expect(await status(operations, "get", "/api/invoices")).toBe(403);
    expect(await status(operations, "get", "/api/invoices/summary")).toBe(403);
    expect(await status(operations, "get", "/api/invoices/billable")).toBe(403);
    expect(await status(operations, "get", "/api/accounts")).toBe(403);
    expect(await status(operations, "post", "/api/invoices", {})).toBe(403);
  });

  it("Viewer: reads, no changes, no export until granted, no administration", async () => {
    const viewer = await signedIn("viewer@example.com", ["VIEWER"]);

    expect(await status(viewer, "get", "/api/clients")).toBe(200);
    expect(await status(viewer, "get", "/api/amc/contracts")).toBe(200);
    expect(await status(viewer, "get", "/api/invoices")).toBe(200);
    expect(await status(viewer, "post", "/api/clients", client)).toBe(403);
    expect(await status(viewer, "get", "/api/clients/export")).toBe(403);
    expect(await status(viewer, "get", "/api/users")).toBe(403);
    expect(await status(viewer, "get", "/api/roles")).toBe(403);
  });

  it("a role change applies to the user's next request", async () => {
    const person = await signedIn("person@example.com", ["VIEWER"]);
    expect(await status(person, "post", "/api/clients", client)).toBe(403);

    expect((await api().put(`/api/users/${person.id}/roles`).set(superAdmin.headers).send({ roleIds: [await roleId("MASTER_DATA_EXECUTIVE")] })).status).toBe(200);
    expect(await status(person, "post", "/api/clients", client)).toBe(201);
    expect(await status(person, "get", "/api/amc/contracts")).toBe(403);
  });
});


import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { loadMigrationFiles } from "../src/db/migrate";
import { PERMISSION_CATALOG } from "../src/shared/permission-catalog";
import { defaultGrants, isInRoleScope, SECURITY_MODULES } from "../src/shared/role-model";
import { activeContract, createClient, visitsOf } from "./amc-helpers";
import { api, closePool, permissionsVersion, resetData, roleId, signedIn } from "./helpers";

// Cross-module permissions (2026-10-31): Super Admin may give any configurable role any supported
// permission of any module, and the saved matrix alone decides access. Every step goes through the
// real save endpoint and the real guards.

type Session = Awaited<ReturnType<typeof signedIn>>;

const CONFIGURABLE = ["ADMINISTRATOR", "FINANCE_EXECUTIVE", "MASTER_DATA_EXECUTIVE", "AMC_OPERATIONS_EXECUTIVE", "VIEWER"];
const OPERATIONAL = CONFIGURABLE.filter((code) => code !== "ADMINISTRATOR");

let superAdmin: Session;

const grantsOf = async (code: string) =>
  (
    await pool.query<{ key: string }>(
      "SELECT rp.module || ':' || rp.action AS key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.code = $1",
      [code]
    )
  ).rows
    .map((row) => row.key)
    .sort();

/** Saves the role's whole set through the API, as the matrix does. */
async function save(session: Session, code: string, keys: string[]) {
  const id = await roleId(code);

  return api()
    .put(`/api/roles/${id}/permissions`)
    .set(session.headers)
    .send({
      expectedVersion: await permissionsVersion(id),
      permissions: keys.map((key) => ({ module: key.split(":")[0], action: key.split(":")[1] })),
    });
}

async function add(code: string, ...keys: string[]) {
  const response = await save(superAdmin, code, [...(await grantsOf(code)), ...keys]);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

async function remove(code: string, ...keys: string[]) {
  const response = await save(superAdmin, code, (await grantsOf(code)).filter((key) => !keys.includes(key)));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

const status = async (session: Session, path: string) => (await api().get(path).set(session.headers)).status;

beforeEach(async () => {
  await resetData();
  superAdmin = await signedIn("super@example.com", ["ADMIN"]);
});

afterAll(closePool);

describe("Finance Executive and AMC Schedule, from no access to edit and back", () => {
  it("follows the saved permissions at every step, on the same session", async () => {
    const finance = await signedIn("finance@example.com", ["FINANCE_EXECUTIVE"]);
    const clientId = await createClient(superAdmin, "Cross Client");
    const contractId = await activeContract(superAdmin, clientId);
    const visit = (await visitsOf(contractId))[0];
    const edit = () => api().patch(`/api/amc/visits/${visit?.id}`).set(finance.headers).send({ visitAmount: "410.000" });

    // 1. No View: refused, although Data read is held.
    expect(await grantsOf("FINANCE_EXECUTIVE")).toContain("AMC_SCHEDULE:READ");
    expect(await status(finance, "/api/amc/visits")).toBe(403);

    // 2-3. View granted: opens.
    await add("FINANCE_EXECUTIVE", "AMC_SCHEDULE:VIEW");
    expect(await status(finance, "/api/amc/visits")).toBe(200);

    // 4. No Edit: refused, and nothing changed.
    expect((await edit()).status).toBe(403);
    expect((await visitsOf(contractId))[0]?.visit_amount).toBe(visit?.visit_amount);

    // 5. Edit granted: the edit works.
    await add("FINANCE_EXECUTIVE", "AMC_SCHEDULE:EDIT");
    expect((await edit()).status).toBe(200);
    expect((await visitsOf(contractId))[0]?.visit_amount).toBe("410.000");

    // 6. Both revoked: refused again at once, on the session that was already open.
    await remove("FINANCE_EXECUTIVE", "AMC_SCHEDULE:VIEW", "AMC_SCHEDULE:EDIT");
    expect(await status(finance, "/api/amc/visits")).toBe(403);
    expect((await edit()).status).toBe(403);

    // Data read survives, so the Finance workflows keep working.
    expect(await grantsOf("FINANCE_EXECUTIVE")).toContain("AMC_SCHEDULE:READ");
    expect(await status(finance, "/api/accounts")).toBe(200);
  });

  it("reports the new access in the session the web app reads", async () => {
    const finance = await signedIn("finance@example.com", ["FINANCE_EXECUTIVE"]);
    const permissions = async () => (await api().get("/api/auth/me").set(finance.headers)).body.data.user.permissions as string[];

    expect(await permissions()).not.toContain("AMC_SCHEDULE:VIEW");
    await add("FINANCE_EXECUTIVE", "AMC_SCHEDULE:VIEW");
    expect(await permissions()).toContain("AMC_SCHEDULE:VIEW");
    await remove("FINANCE_EXECUTIVE", "AMC_SCHEDULE:VIEW");
    expect(await permissions()).not.toContain("AMC_SCHEDULE:VIEW");
  });
});

describe("selected permissions on other roles", () => {
  it("Master Data Executive receives selected AMC permissions, and only those", async () => {
    const master = await signedIn("master@example.com", ["MASTER_DATA_EXECUTIVE"]);
    expect(await status(master, "/api/amc/contracts")).toBe(403);

    await add("MASTER_DATA_EXECUTIVE", "AMC_CONTRACTS:VIEW", "MONTHLY_CALENDAR:VIEW");

    expect(await status(master, "/api/amc/contracts")).toBe(200);
    expect(await status(master, "/api/amc/visits")).toBe(200); // serves the Monthly Calendar
    expect(await status(master, "/api/amc/service-status")).toBe(403);
    expect((await api().post("/api/amc/contracts").set(master.headers).send({})).status).toBe(403);
    expect((await api().get("/api/amc/visits/export?format=xlsx").set(master.headers)).status).toBe(403);
  });

  it("AMC Operations Executive receives selected Finance permissions", async () => {
    const operations = await signedIn("operations@example.com", ["AMC_OPERATIONS_EXECUTIVE"]);
    expect(await status(operations, "/api/invoices")).toBe(403);
    expect(await status(operations, "/api/accounts")).toBe(403);

    await add("AMC_OPERATIONS_EXECUTIVE", "INVOICES:VIEW", "ACCOUNTS:VIEW");

    expect(await status(operations, "/api/invoices")).toBe(200);
    expect(await status(operations, "/api/accounts")).toBe(200);
    expect((await api().post("/api/invoices").set(operations.headers).send({})).status).toBe(403);
    expect((await api().get("/api/invoices/export?format=xlsx").set(operations.headers)).status).toBe(403);
  });

  it("Viewer holds only what was explicitly granted, including a change action", async () => {
    const viewer = await signedIn("viewer@example.com", ["VIEWER"]);
    const body = { name: "Viewer Client", clientType: "COMPANY" };
    expect((await api().post("/api/clients").set(viewer.headers).send(body)).status).toBe(403);

    await add("VIEWER", "CLIENTS:CREATE");
    expect((await api().post("/api/clients").set(viewer.headers).send(body)).status).toBe(201);
    expect((await api().get("/api/clients/export?format=xlsx").set(viewer.headers)).status).toBe(403);

    await remove("VIEWER", "AMC_CONTRACTS:VIEW");
    expect(await status(viewer, "/api/amc/contracts")).toBe(403);
  });

  it("every configurable role may be given every supported permission of a current module, except security administration", () => {
    for (const code of OPERATIONAL) {
      for (const section of PERMISSION_CATALOG.filter((candidate) => !candidate.retired)) {
        for (const entry of section.modules) {
          for (const action of Object.keys(entry.actions) as never[]) {
            expect(isInRoleScope(code, entry.module, action), `${code} ${entry.module}:${action}`).toBe(!SECURITY_MODULES.includes(entry.module));
          }
        }
      }
    }
  });
});

describe("what does not change", () => {
  it("leaves every role's seeded grants as they were", async () => {
    for (const code of CONFIGURABLE) {
      expect(await grantsOf(code), code).toEqual([...defaultGrants(code)].sort());
    }
  });

  it("a saved grant changes one role only", async () => {
    const others = await Promise.all(["MASTER_DATA_EXECUTIVE", "VIEWER"].map(grantsOf));
    await add("FINANCE_EXECUTIVE", "AMC_SCHEDULE:VIEW");
    expect(await Promise.all(["MASTER_DATA_EXECUTIVE", "VIEWER"].map(grantsOf))).toEqual(others);
  });

  it("never lets a role be given an action the module does not support", async () => {
    for (const key of ["AMC_SCHEDULE:DELETE", "MONTHLY_CALENDAR:EDIT", "DASHBOARD:EDIT", "PROJECTS:VIEW"]) {
      const response = await save(superAdmin, "FINANCE_EXECUTIVE", [...(await grantsOf("FINANCE_EXECUTIVE")), key]);
      expect(response.status, key).toBe(400);
    }
  });

  it("still needs View with any other action, and leaves Data read independent", async () => {
    const response = await save(superAdmin, "FINANCE_EXECUTIVE", [...(await grantsOf("FINANCE_EXECUTIVE")), "AMC_SCHEDULE:EDIT"]);
    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe("AMC_SCHEDULE:EDIT also needs AMC_SCHEDULE:VIEW. Grant both, or neither.");
  });

  it("Super Admin keeps full access, whatever other roles are given", async () => {
    await add("FINANCE_EXECUTIVE", "AMC_SCHEDULE:VIEW");
    for (const path of ["/api/amc/visits", "/api/invoices", "/api/accounts", "/api/clients", "/api/users", "/api/roles", "/api/audit/activity"]) {
      expect(await status(superAdmin, path), path).toBe(200);
    }
    expect((await save(superAdmin, "ADMIN", [])).status).toBe(403);
  });

  it("Data read workflows of Invoice Tracking and Accounts keep working", async () => {
    const finance = await signedIn("finance@example.com", ["FINANCE_EXECUTIVE"]);
    const billable = await api().get("/api/invoices/billable").set(finance.headers);

    expect(billable.status).toBe(200);
    expect(billable.body.data.amcVisits).not.toBeNull();
    expect(await status(finance, "/api/accounts")).toBe(200);

    // Data read decides the visits inside Invoice Tracking. Accounts now has its own permission.
    await remove("FINANCE_EXECUTIVE", "AMC_SCHEDULE:READ");
    expect((await api().get("/api/invoices/billable").set(finance.headers)).body.data.amcVisits).toBeNull();
    expect(await status(finance, "/api/invoices")).toBe(200);
    expect(await status(finance, "/api/accounts")).toBe(200);
  });
});

describe("security administration stays protected", () => {
  it("no operational role can be given Users & Access", async () => {
    for (const code of OPERATIONAL) {
      for (const key of ["USERS:VIEW", "USERS:EDIT"]) {
        const before = await grantsOf(code);
        const response = await save(superAdmin, code, [...before, "USERS:VIEW", key]);

        expect(response.status, `${code} ${key}`).toBe(403);
        expect(await grantsOf(code)).toEqual(before);
      }
    }
  });

  it("nobody but Super Admin changes the matrix, whatever module permissions they were given", async () => {
    await add("FINANCE_EXECUTIVE", "SETTINGS:VIEW", "SETTINGS:EDIT");
    const sessions = {
      ADMINISTRATOR: await signedIn("admin@example.com", ["ADMINISTRATOR"]),
      FINANCE_EXECUTIVE: await signedIn("finance@example.com", ["FINANCE_EXECUTIVE"]),
      MASTER_DATA_EXECUTIVE: await signedIn("master@example.com", ["MASTER_DATA_EXECUTIVE"]),
      AMC_OPERATIONS_EXECUTIVE: await signedIn("operations@example.com", ["AMC_OPERATIONS_EXECUTIVE"]),
      VIEWER: await signedIn("viewer@example.com", ["VIEWER"]),
    };

    for (const [code, session] of Object.entries(sessions)) {
      // Their own role, and Finance's: refused, unchanged.
      for (const target of [code, "FINANCE_EXECUTIVE"]) {
        const before = await grantsOf(target);
        const response = await save(session, target, [...before, "CLIENTS:VIEW"]);

        expect(response.status, `${code} on ${target}`).toBe(403);
        expect(await grantsOf(target)).toEqual(before);
      }
    }
  });

  it("a role given Settings still opens none of the administrator pages", async () => {
    const finance = await signedIn("finance@example.com", ["FINANCE_EXECUTIVE"]);
    await add("FINANCE_EXECUTIVE", "SETTINGS:VIEW");

    expect(await status(finance, "/api/users")).toBe(403);
    expect(await status(finance, "/api/roles")).toBe(403);
    expect(await status(finance, "/api/audit/activity")).toBe(403);
    expect(await status(finance, "/api/suggestions/review")).toBe(403);
  });

  it("Admin can still assign an operational role that gained cross-module permissions, and no role beyond its own", async () => {
    const admin = await signedIn("admin@example.com", ["ADMINISTRATOR"]);
    const viewer = await signedIn("viewer@example.com", ["VIEWER"]);
    await add("FINANCE_EXECUTIVE", "AMC_SCHEDULE:VIEW", "AMC_SCHEDULE:EDIT");

    const assign = () => api().put(`/api/users/${viewer.id}/roles`).set(admin.headers).send({ roleIds: [] }).send({ roleIds: [financeId] });
    const financeId = await roleId("FINANCE_EXECUTIVE");
    expect((await assign()).status).toBe(200);

    // Admin no longer holds a permission the role has: it may not hand it out.
    await remove("ADMINISTRATOR", "AMC_SCHEDULE:EDIT");
    await api().put(`/api/users/${viewer.id}/roles`).set(superAdmin.headers).send({ roleIds: [await roleId("VIEWER")] });
    expect((await assign()).status).toBe(403);
  });
});

describe("Master AMC Status and Accounts are configured on their own", () => {
  it("Master AMC Status opens on its own permission, without Schedule, Services Sales or Invoices", async () => {
    const master = await signedIn("master@example.com", ["MASTER_DATA_EXECUTIVE"]);
    expect(await status(master, "/api/amc/master-status")).toBe(403);

    await add("MASTER_DATA_EXECUTIVE", "MASTER_AMC_STATUS:VIEW");

    expect(await status(master, "/api/amc/master-status")).toBe(200);
    expect(await status(master, "/api/amc/master-status/options")).toBe(200);
    expect(await status(master, "/api/amc/master-status/export?format=xlsx")).toBe(403);
    // It opens nothing else.
    expect(await status(master, "/api/amc/visits")).toBe(403);
    expect(await status(master, "/api/invoices")).toBe(403);
    expect(await status(master, "/api/services-sales")).toBe(403);

    await add("MASTER_DATA_EXECUTIVE", "MASTER_AMC_STATUS:EXPORT");
    expect(await status(master, "/api/amc/master-status/export?format=xlsx")).not.toBe(403);

    await remove("MASTER_DATA_EXECUTIVE", "MASTER_AMC_STATUS:EXPORT", "MASTER_AMC_STATUS:VIEW");
    expect(await status(master, "/api/amc/master-status")).toBe(403);
  });

  it("the old permissions alone no longer open Master AMC Status", async () => {
    const master = await signedIn("master@example.com", ["MASTER_DATA_EXECUTIVE"]);
    await add("MASTER_DATA_EXECUTIVE", "AMC_SCHEDULE:VIEW", "SERVICES_SALES:VIEW", "INVOICES:READ");

    expect(await status(master, "/api/amc/visits")).toBe(200);
    expect(await status(master, "/api/amc/master-status")).toBe(403);
  });

  it("Accounts opens on its own permission, without Invoice Tracking or the schedule", async () => {
    const master = await signedIn("master@example.com", ["MASTER_DATA_EXECUTIVE"]);
    expect(await status(master, "/api/accounts")).toBe(403);

    await add("MASTER_DATA_EXECUTIVE", "ACCOUNTS:VIEW");

    expect(await status(master, "/api/accounts")).toBe(200);
    expect(await status(master, "/api/accounts/options")).toBe(200);
    expect(await status(master, "/api/accounts/export?format=xlsx")).toBe(403);
    expect(await status(master, "/api/invoices")).toBe(403);
    expect(await status(master, "/api/amc/visits")).toBe(403);

    await add("MASTER_DATA_EXECUTIVE", "ACCOUNTS:EXPORT");
    expect(await status(master, "/api/accounts/export?format=xlsx")).not.toBe(403);
  });

  it("Invoice Tracking and Accounts can be revoked apart", async () => {
    const finance = await signedIn("finance@example.com", ["FINANCE_EXECUTIVE"]);

    await remove("FINANCE_EXECUTIVE", "ACCOUNTS:EXPORT", "ACCOUNTS:VIEW");
    expect(await status(finance, "/api/accounts")).toBe(403);
    expect(await status(finance, "/api/invoices")).toBe(200);
    expect((await api().get("/api/invoices/billable").set(finance.headers)).body.data.amcVisits).not.toBeNull();
  });

  it("every role that could open them still can after the migration", async () => {
    for (const [code, email, paths] of [
      ["FINANCE_EXECUTIVE", "a@example.com", ["/api/accounts"]],
      ["AMC_OPERATIONS_EXECUTIVE", "b@example.com", ["/api/amc/master-status"]],
      ["VIEWER", "c@example.com", ["/api/accounts", "/api/amc/master-status"]],
      ["ADMINISTRATOR", "d@example.com", ["/api/accounts", "/api/amc/master-status"]],
    ] as const) {
      const session = await signedIn(email, [code]);
      for (const path of paths) expect(await status(session, path), `${code} ${path}`).toBe(200);
    }
  });
});

describe("migration 0092", () => {
  const seed = () => loadMigrationFiles().find((migration) => migration.name === "seed_independent_page_permissions")?.sql ?? "";
  const all = async () => (await pool.query<{ key: string }>("SELECT r.code || ':' || rp.module || ':' || rp.action AS key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id ORDER BY 1")).rows.map((row) => row.key);

  it("is idempotent and removes nothing", async () => {
    const before = await all();
    await pool.query(seed());
    expect(await all()).toEqual(before);
  });

  it("works from a role's saved grants: nothing for a role that could not open the page", async () => {
    await pool.query("DELETE FROM role_permissions WHERE module IN ('MASTER_AMC_STATUS', 'ACCOUNTS') AND role_id = (SELECT id FROM roles WHERE code = 'VIEWER')");
    await pool.query("DELETE FROM role_permissions WHERE module = 'AMC_SCHEDULE' AND role_id = (SELECT id FROM roles WHERE code = 'VIEWER')");
    await pool.query(seed());

    const viewer = await grantsOf("VIEWER");
    expect(viewer).not.toContain("MASTER_AMC_STATUS:VIEW");
    expect(viewer).not.toContain("ACCOUNTS:VIEW");
  });

  it("keeps a role assignment and leaves an edited description alone", async () => {
    await pool.query("UPDATE roles SET description = 'Edited by Super Admin' WHERE code = 'VIEWER'");
    await pool.query("UPDATE roles SET description = 'Finance section: Invoice Tracking and Accounts.' WHERE code = 'FINANCE_EXECUTIVE'");
    const person = await signedIn("person@example.com", ["VIEWER"]);
    await pool.query(seed());

    const description = async (code: string) => (await pool.query("SELECT description FROM roles WHERE code = $1", [code])).rows[0].description;
    expect(await description("VIEWER")).toBe("Edited by Super Admin");
    expect(await description("FINANCE_EXECUTIVE")).toContain("Starts with Invoice Tracking and Accounts");
    expect((await pool.query("SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1", [person.id])).rows[0].code).toBe("VIEWER");
  });
});

describe("suggestions: submitting and reviewing are separate", () => {
  const body = { category: "IMPROVEMENT", subject: "A subject for this", description: "A description that is long enough." };
  const submit = (session: Session) => api().post("/api/suggestions").set(session.headers).send(body);

  it("every existing role can still submit and follow its own; only the two admin roles review", async () => {
    for (const code of CONFIGURABLE) {
      const session = await signedIn(`${code}@example.com`, [code]);
      expect((await submit(session)).status, code).toBe(201);
      expect(await status(session, "/api/suggestions/mine"), code).toBe(200);
      expect(await status(session, "/api/suggestions/review"), code).toBe(code === "ADMINISTRATOR" ? 200 : 403);
    }
  });

  it("without Create nothing can be submitted, commented or reopened; View keeps one's own readable", async () => {
    const finance = await signedIn("finance@example.com", ["FINANCE_EXECUTIVE"]);
    const id = (await submit(finance)).body.data.id;
    await remove("FINANCE_EXECUTIVE", "SUGGESTIONS:CREATE");

    expect((await submit(finance)).status).toBe(403);
    expect((await api().post(`/api/suggestions/${id}/comments`).set(finance.headers).send({ body: "A comment", internal: false })).status).toBe(403);
    const own = await api().get(`/api/suggestions/${id}`).set(finance.headers);
    expect(own.status).toBe(200);
    expect(own.body.data.access).toMatchObject({ canComment: false, transitions: [] });

    await remove("FINANCE_EXECUTIVE", "SUGGESTIONS:VIEW");
    expect(await status(finance, "/api/suggestions/mine")).toBe(403);
    expect(await status(finance, `/api/suggestions/${id}`)).toBe(403);
  });

  it("review View reads everything but changes nothing", async () => {
    const author = await signedIn("author@example.com", ["VIEWER"]);
    const id = (await submit(author)).body.data.id;
    const finance = await signedIn("finance@example.com", ["FINANCE_EXECUTIVE"]);
    expect(await status(finance, `/api/suggestions/${id}`)).toBe(404);

    await add("FINANCE_EXECUTIVE", "SUGGESTIONS_REVIEW:VIEW");

    expect(await status(finance, "/api/suggestions/review")).toBe(200);
    const detail = await api().get(`/api/suggestions/${id}`).set(finance.headers);
    expect(detail.status).toBe(200);
    expect(detail.body.data.access).toMatchObject({ reviewer: false, canComment: false, canAssign: false, transitions: [] });
    expect((await api().patch(`/api/suggestions/${id}/status`).set(finance.headers).send({ status: "UNDER_REVIEW", fromStatus: "SUBMITTED" })).status).toBe(403);
    expect((await api().patch(`/api/suggestions/${id}/assignment`).set(finance.headers).send({ assignedTo: null })).status).toBe(403);
    expect((await api().post(`/api/suggestions/${id}/comments`).set(finance.headers).send({ body: "A response", internal: false })).status).toBe(403);
    expect((await api().post(`/api/suggestions/${id}/comments`).set(finance.headers).send({ body: "A note here", internal: true })).status).toBe(403);
  });

  it("review Edit manages, and makes the holder assignable", async () => {
    const author = await signedIn("author@example.com", ["VIEWER"]);
    const id = (await submit(author)).body.data.id;
    const finance = await signedIn("finance@example.com", ["FINANCE_EXECUTIVE"]);
    await add("FINANCE_EXECUTIVE", "SUGGESTIONS_REVIEW:VIEW", "SUGGESTIONS_REVIEW:EDIT");

    expect((await api().post(`/api/suggestions/${id}/comments`).set(finance.headers).send({ body: "A note here", internal: true })).status).toBe(200);
    expect((await api().patch(`/api/suggestions/${id}/assignment`).set(superAdmin.headers).send({ assignedTo: finance.id })).status).toBe(200);

    // The internal note stays hidden from the submitter.
    const own = await api().get(`/api/suggestions/${id}`).set(author.headers);
    expect(own.body.data.events.some((event: { internal: boolean }) => event.internal)).toBe(false);

    // Admin can be taken off review by Super Admin, like any other permission.
    await remove("ADMINISTRATOR", "SUGGESTIONS_REVIEW:EDIT", "SUGGESTIONS_REVIEW:VIEW");
    const admin = await signedIn("admin@example.com", ["ADMINISTRATOR"]);
    expect(await status(admin, "/api/suggestions/review")).toBe(403);
    expect(await status(superAdmin, "/api/suggestions/review")).toBe(200);
  });
});

describe("the contract form's client list", () => {
  it("needs a permission to save the form, shows only id and name, and opens nothing about clients", async () => {
    await createClient(superAdmin, "Lookup Client");
    const master = await signedIn("master@example.com", ["AMC_OPERATIONS_EXECUTIVE"]);
    await remove("AMC_OPERATIONS_EXECUTIVE", "CLIENTS:READ");

    const lookup = await api().get("/api/amc/contracts/client-options").set(master.headers);
    expect(lookup.status).toBe(200);
    expect(lookup.body.data).toEqual([{ id: expect.any(String), name: "Lookup Client" }]);
    expect(await status(master, "/api/clients")).toBe(403);
    expect(await status(master, `/api/clients/${lookup.body.data[0].id}`)).toBe(403);

    // A contract can be created with it, with no client permission at all.
    const created = await api().post("/api/amc/contracts").set(master.headers).send({
      clientId: lookup.body.data[0].id, responsibleEngineer: "Engineer", validFrom: "2027-01-01", validTo: "2027-12-31",
      systemDescription: "FIRE", contractValue: "1620.000", maintenanceFrequency: "QUARTERLY", defaultVisitAmount: "405.000",
    });
    expect(created.status).toBe(201);
  });

  it("is refused to View alone, and to someone holding only client data read", async () => {
    const viewer = await signedIn("viewer@example.com", ["VIEWER"]);
    expect(await status(viewer, "/api/amc/contracts")).toBe(200);
    expect(await status(viewer, "/api/amc/contracts/client-options")).toBe(403);

    const finance = await signedIn("finance@example.com", ["FINANCE_EXECUTIVE"]);
    await add("FINANCE_EXECUTIVE", "CLIENTS:READ");
    expect(await status(finance, "/api/amc/contracts/client-options")).toBe(403);
  });

  it("leaves out inactive clients", async () => {
    const id = await createClient(superAdmin, "Gone Client");
    await pool.query("UPDATE clients SET is_active = false WHERE id = $1", [id]);
    const lookup = await api().get("/api/amc/contracts/client-options").set(superAdmin.headers);
    expect(lookup.body.data).toEqual([]);
  });
});

describe("contract status figures", () => {
  it("are open to contract users without Dashboard, and to nobody else", async () => {
    const viewer = await signedIn("viewer@example.com", ["VIEWER"]);
    await remove("VIEWER", "DASHBOARD:VIEW");

    expect(await status(viewer, "/api/dashboard/summary")).toBe(403);
    const summary = await api().get("/api/amc/contracts/status-summary").set(viewer.headers);
    expect(summary.status).toBe(200);
    expect(Object.keys(summary.body.data)).toEqual(["contracts"]);
    expect(summary.body.data.contracts.active).toBe(0);

    const finance = await signedIn("finance@example.com", ["FINANCE_EXECUTIVE"]);
    expect(await status(finance, "/api/amc/contracts/status-summary")).toBe(403);
  });
});

describe("notification links", () => {
  it("are empty when the user cannot open the page, and the alert stays", async () => {
    const clientId = await createClient(superAdmin, "Overdue Client");
    await activeContract(superAdmin, clientId, { validFrom: "2024-01-01", validTo: "2030-12-31" });
    const alert = async (session: Session) =>
      ((await api().get("/api/notifications").set(session.headers)).body.data.items as { key: string; link: string | null }[]).find((item) => item.key === "visits.overdue");

    expect((await alert(superAdmin))?.link).toBe("/amc/schedule");

    const operations = await signedIn("operations@example.com", ["AMC_OPERATIONS_EXECUTIVE"]);
    const current = await grantsOf("AMC_OPERATIONS_EXECUTIVE");
    await save(superAdmin, "AMC_OPERATIONS_EXECUTIVE", current.filter((key) => !key.startsWith("AMC_SCHEDULE:") && !key.startsWith("AMC_CONTRACTS:")));

    const hidden = await alert(operations);
    expect(hidden).toBeDefined();
    expect(hidden?.link).toBeNull();
  });
});

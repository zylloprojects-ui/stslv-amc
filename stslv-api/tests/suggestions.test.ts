import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { canTransition, idFromReference, noteRequirement, referenceOf } from "../src/modules/suggestions/suggestions.workflow";
import { api, closePool, resetData, signedIn } from "./helpers";

// Suggestions & feedback: submission, ownership, review workflow, history and alerts.
// Every record here is invented test data.

type Session = Awaited<ReturnType<typeof signedIn>>;

let admin: Session;
let secondAdmin: Session;
let alice: Session;
let bob: Session;

const submit = (session: Session, body: Record<string, unknown>) => api().post("/api/suggestions").set(session.headers).send(body);
const detail = (session: Session, id: string) => api().get(`/api/suggestions/${id}`).set(session.headers);
const setStatus = (session: Session, id: string, body: Record<string, unknown>) =>
  api().patch(`/api/suggestions/${id}/status`).set(session.headers).send(body);
const comment = (session: Session, id: string, body: Record<string, unknown>) =>
  api().post(`/api/suggestions/${id}/comments`).set(session.headers).send(body);

async function newSuggestion(session: Session, subject = "Export button is slow"): Promise<string> {
  const response = await submit(session, {
    category: "BUG",
    subject,
    description: "The schedule export takes a long time to start.",
    pagePath: "/amc/schedule",
  });

  expect(response.status).toBe(201);
  return response.body.data.id as string;
}

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  secondAdmin = await signedIn("admin2@example.com", ["ADMIN"]);
  // Non-Admin roles, including one with full user-management rights: none of them reviews suggestions.
  alice = await signedIn("alice@example.com", ["EXECUTION"]);
  bob = await signedIn("bob@example.com", ["ACCOUNTANT"]);
});
afterAll(closePool);

describe("workflow rules", () => {
  it("allows the documented reviewer path and rejects skipping back", () => {
    expect(canTransition("SUBMITTED", "UNDER_REVIEW", "REVIEWER")).toBe(true);
    expect(canTransition("UNDER_REVIEW", "IN_PROGRESS", "REVIEWER")).toBe(true);
    expect(canTransition("IN_PROGRESS", "RESOLVED", "REVIEWER")).toBe(true);
    expect(canTransition("RESOLVED", "CLOSED", "REVIEWER")).toBe(true);
    expect(canTransition("CLOSED", "REOPENED", "REVIEWER")).toBe(true);
    expect(canTransition("CLOSED", "IN_PROGRESS", "REVIEWER")).toBe(false);
    expect(canTransition("RESOLVED", "SUBMITTED", "REVIEWER")).toBe(false);
    expect(canTransition("UNDER_REVIEW", "SUBMITTED", "REVIEWER")).toBe(false);
  });

  it("lets the submitter only reopen a resolved suggestion", () => {
    expect(canTransition("RESOLVED", "REOPENED", "SUBMITTER")).toBe(true);
    expect(canTransition("CLOSED", "REOPENED", "SUBMITTER")).toBe(false);
    expect(canTransition("SUBMITTED", "CLOSED", "SUBMITTER")).toBe(false);
  });

  it("requires a resolution or a reason where the workflow says so", () => {
    expect(noteRequirement("IN_PROGRESS", "RESOLVED")).toBe("resolution");
    expect(noteRequirement("SUBMITTED", "CLOSED")).toBe("reason");
    expect(noteRequirement("RESOLVED", "CLOSED")).toBeNull();
    expect(noteRequirement("CLOSED", "REOPENED")).toBe("reason");
    expect(noteRequirement("SUBMITTED", "UNDER_REVIEW")).toBeNull();
  });

  it("derives and parses references", () => {
    expect(referenceOf("42")).toBe("SUG-00042");
    expect(idFromReference("SUG-00042")).toBe("42");
    expect(idFromReference("sug42")).toBe("42");
    expect(idFromReference("Export")).toBeNull();
  });
});

describe("submitting", () => {
  it("saves a suggestion with reference, status and a Submitted history entry", async () => {
    const response = await submit(alice, {
      category: "IMPROVEMENT",
      subject: "  Show contract number on visits  ",
      description: "It would help to see the contract number on each visit row.",
      pagePath: "/amc/schedule",
    });

    expect(response.status).toBe(201);
    const data = response.body.data;
    expect(data.reference).toBe(referenceOf(data.id));
    expect(data.subject).toBe("Show contract number on visits");
    expect(data.status).toBe("SUBMITTED");
    expect(data.submittedBy.fullName).toBe("alice@example.com");
    expect(data.events.map((event: { kind: string }) => event.kind)).toEqual(["SUBMITTED"]);
    expect(data.access).toMatchObject({ reviewer: false, isSubmitter: true, transitions: [], canComment: true });

    const log = await pool.query("SELECT action, user_id FROM activity_logs WHERE entity_type = 'suggestions' AND entity_id = $1", [data.id]);
    expect(log.rows).toEqual([{ action: "suggestion.submitted", user_id: alice.id }]);
  });

  it("validates input", async () => {
    const response = await submit(alice, { category: "OTHER", subject: "x", description: "short", pagePath: "https://evil.example" });

    expect(response.status).toBe(400);
    const fields = response.body.error.details.map((detail: { field: string }) => detail.field).sort();
    expect(fields).toEqual(["category", "description", "pagePath", "subject"]);
  });

  it("does not create a copy when the same request is sent twice", async () => {
    const requestId = randomUUID();
    const body = { category: "FEATURE", subject: "Dark mode", description: "Please add a dark theme for night shifts.", requestId };
    const first = await submit(bob, body);
    const second = await submit(bob, body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.data.id).toBe(first.body.data.id);
    const count = await pool.query("SELECT count(*)::int AS count FROM suggestions WHERE client_request_id = $1", [requestId]);
    expect(count.rows[0].count).toBe(1);
  });

  it("requires sign-in", async () => {
    const response = await api().post("/api/suggestions").send({ category: "BUG", subject: "Anon", description: "Anonymous feedback text" });

    expect(response.status).toBe(401);
  });
});

describe("ownership", () => {
  let aliceId: string;

  beforeAll(async () => {
    aliceId = await newSuggestion(alice, "Alice private note");
  });

  it("lists only the user's own suggestions under mine", async () => {
    const response = await api().get("/api/suggestions/mine").set(bob.headers);

    expect(response.status).toBe(200);
    expect(response.body.data.items.every((item: { submittedBy: { id: string } }) => item.submittedBy.id === bob.id)).toBe(true);
    expect(response.body.data.items.some((item: { id: string }) => item.id === aliceId)).toBe(false);
  });

  it("hides another user's suggestion as not found", async () => {
    expect((await detail(bob, aliceId)).status).toBe(404);
    expect((await comment(bob, aliceId, { body: "Me too" })).status).toBe(404);
    expect((await api().post(`/api/suggestions/${aliceId}/reopen`).set(bob.headers).send({ fromStatus: "RESOLVED", reason: "x" })).status).toBe(404);
  });

  it("refuses reviewer actions and the review list to non-Admin users, even with user management rights", async () => {
    await pool.query(
      "INSERT INTO role_permissions (role_id, module, action) SELECT id, 'USERS', a FROM roles, unnest(ARRAY['VIEW','EDIT','APPROVE']) a WHERE code = 'ACCOUNTANT' ON CONFLICT DO NOTHING"
    );

    expect((await api().get("/api/suggestions/review").set(bob.headers)).status).toBe(403);
    expect((await api().get("/api/suggestions/review/options").set(bob.headers)).status).toBe(403);
    expect((await setStatus(bob, aliceId, { status: "UNDER_REVIEW", fromStatus: "SUBMITTED" })).status).toBe(403);
    expect((await setStatus(alice, aliceId, { status: "CLOSED", fromStatus: "SUBMITTED", note: "Done" })).status).toBe(403);
    expect((await api().patch(`/api/suggestions/${aliceId}/assignment`).set(alice.headers).send({ assignedTo: alice.id })).status).toBe(403);
    expect((await comment(alice, aliceId, { body: "Secret", internal: true })).status).toBe(403);

    const unchanged = await detail(alice, aliceId);
    expect(unchanged.body.data.status).toBe("SUBMITTED");
  });

  it("answers 404 for an id that cannot exist", async () => {
    expect((await detail(admin, "abc")).status).toBe(404);
    expect((await detail(admin, "999999")).status).toBe(404);
  });
});

describe("full review workflow: submit → review → respond → resolve → close", () => {
  let id: string;

  beforeAll(async () => {
    id = await newSuggestion(alice, "Visit dates wrong after renewal");
  });

  it("shows the submission to the reviewer in the review list", async () => {
    const response = await api().get("/api/suggestions/review").query({ view: "OPEN" }).set(admin.headers);

    expect(response.status).toBe(200);
    const item = response.body.data.items.find((entry: { id: string }) => entry.id === id);
    expect(item).toMatchObject({ status: "SUBMITTED", subject: "Visit dates wrong after renewal", submittedBy: { id: alice.id } });
    expect(response.body.data.counts.SUBMITTED).toBeGreaterThanOrEqual(1);
  });

  it("raises a reviewer alert for new suggestions", async () => {
    const alerts = await api().get("/api/notifications").set(admin.headers);

    expect(alerts.body.data.items.find((alert: { key: string }) => alert.key === "suggestions.awaiting_review")).toMatchObject({ link: "/admin/suggestions" });
    const aliceAlerts = await api().get("/api/notifications").set(alice.headers);
    expect(aliceAlerts.body.data.items.some((alert: { key: string }) => alert.key === "suggestions.awaiting_review")).toBe(false);
  });

  it("lets the reviewer open it with full detail and the allowed transitions", async () => {
    const response = await detail(admin, id);

    expect(response.status).toBe(200);
    expect(response.body.data.description).toBe("The schedule export takes a long time to start.");
    expect(response.body.data.pagePath).toBe("/amc/schedule");
    expect(response.body.data.access).toMatchObject({ reviewer: true, canAssign: true, transitions: ["UNDER_REVIEW", "IN_PROGRESS", "RESOLVED", "CLOSED"] });
  });

  it("acknowledges (Under Review) and assigns it", async () => {
    const reviewed = await setStatus(admin, id, { status: "UNDER_REVIEW", fromStatus: "SUBMITTED" });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.data.status).toBe("UNDER_REVIEW");
    expect(reviewed.body.data.statusChangedBy.id).toBe(admin.id);

    const assigned = await api().patch(`/api/suggestions/${id}/assignment`).set(admin.headers).send({ assignedTo: secondAdmin.id });
    expect(assigned.status).toBe(200);
    expect(assigned.body.data.assignedTo).toEqual({ id: secondAdmin.id, fullName: "admin2@example.com" });

    const notReviewer = await api().patch(`/api/suggestions/${id}/assignment`).set(admin.headers).send({ assignedTo: alice.id });
    expect(notReviewer.status).toBe(400);
  });

  it("records a public response and an internal note; the submitter sees only the response", async () => {
    expect((await comment(secondAdmin, id, { body: "Thanks, we can reproduce this." })).status).toBe(200);
    expect((await comment(secondAdmin, id, { body: "Caused by the renewal copy step.", internal: true })).status).toBe(200);

    const forAlice = await detail(alice, id);
    const bodies = forAlice.body.data.events.filter((event: { kind: string }) => event.kind === "COMMENT").map((event: { body: string }) => event.body);
    expect(bodies).toEqual(["Thanks, we can reproduce this."]);
    expect(forAlice.body.data.lastResponseAt).not.toBeNull();

    const forAdmin = await detail(admin, id);
    expect(forAdmin.body.data.events.filter((event: { internal: boolean }) => event.internal)).toHaveLength(1);
  });

  it("tells the submitter about the response and lets them follow up", async () => {
    const alerts = await api().get("/api/notifications").set(alice.headers);
    expect(alerts.body.data.items.find((alert: { key: string }) => alert.key === "suggestions.responses")).toMatchObject({ link: "/suggestions" });

    const followUp = await comment(alice, id, { body: "It happens on every renewed contract." });
    expect(followUp.status).toBe(200);
    expect(followUp.body.data.events.at(-1)).toMatchObject({ kind: "COMMENT", bySubmitter: true });
  });

  it("rejects invalid transitions and stale updates", async () => {
    const backwards = await setStatus(admin, id, { status: "SUBMITTED", fromStatus: "UNDER_REVIEW" });
    expect(backwards.status).toBe(400);

    const stale = await setStatus(admin, id, { status: "IN_PROGRESS", fromStatus: "SUBMITTED" });
    expect(stale.status).toBe(409);

    const noResolution = await setStatus(admin, id, { status: "RESOLVED", fromStatus: "UNDER_REVIEW" });
    expect(noResolution.status).toBe(400);
    expect(noResolution.body.error.details[0].field).toBe("note");
  });

  it("moves to In Progress, then Resolved with resolution notes", async () => {
    expect((await setStatus(secondAdmin, id, { status: "IN_PROGRESS", fromStatus: "UNDER_REVIEW" })).status).toBe(200);

    const resolved = await setStatus(secondAdmin, id, { status: "RESOLVED", fromStatus: "IN_PROGRESS", note: "Renewal now copies visit dates correctly." });
    expect(resolved.status).toBe(200);
    expect(resolved.body.data).toMatchObject({
      status: "RESOLVED",
      resolutionNotes: "Renewal now copies visit dates correctly.",
      resolvedBy: { id: secondAdmin.id },
    });
    expect(resolved.body.data.resolvedAt).not.toBeNull();
  });

  it("shows the submitter the resolution and lets them reopen it with a reason", async () => {
    const seen = await detail(alice, id);
    expect(seen.body.data).toMatchObject({ status: "RESOLVED", resolutionNotes: "Renewal now copies visit dates correctly." });
    expect(seen.body.data.access.transitions).toEqual(["REOPENED"]);

    const noReason = await api().post(`/api/suggestions/${id}/reopen`).set(alice.headers).send({ fromStatus: "RESOLVED", reason: " " });
    expect(noReason.status).toBe(400);

    const reopened = await api().post(`/api/suggestions/${id}/reopen`).set(alice.headers).send({ fromStatus: "RESOLVED", reason: "Still wrong for quarterly contracts." });
    expect(reopened.status).toBe(200);
    expect(reopened.body.data).toMatchObject({ status: "REOPENED", resolutionNotes: null, resolvedAt: null });
  });

  it("is resolved again and closed by the reviewer; the submitter can no longer comment", async () => {
    expect((await setStatus(admin, id, { status: "RESOLVED", fromStatus: "REOPENED", note: "Quarterly contracts fixed too." })).status).toBe(200);

    const closed = await setStatus(admin, id, { status: "CLOSED", fromStatus: "RESOLVED" });
    expect(closed.status).toBe(200);
    expect(closed.body.data).toMatchObject({ status: "CLOSED", closedBy: { id: admin.id }, resolutionNotes: "Quarterly contracts fixed too." });

    const seen = await detail(alice, id);
    expect(seen.body.data.status).toBe("CLOSED");
    expect(seen.body.data.access).toMatchObject({ canComment: false, transitions: [] });
    expect((await comment(alice, id, { body: "One more thing" })).status).toBe(409);
    expect((await api().post(`/api/suggestions/${id}/reopen`).set(alice.headers).send({ fromStatus: "CLOSED", reason: "Again" })).status).toBe(400);
  });

  it("keeps the full history with who and when", async () => {
    const response = await detail(admin, id);
    const events = response.body.data.events as { kind: string; fromStatus: string | null; toStatus: string | null; actor: { id: string }; createdAt: string }[];

    expect(events.filter((event) => event.kind === "STATUS_CHANGED").map((event) => `${event.fromStatus}>${event.toStatus}`)).toEqual([
      "SUBMITTED>UNDER_REVIEW",
      "UNDER_REVIEW>IN_PROGRESS",
      "IN_PROGRESS>RESOLVED",
      "RESOLVED>REOPENED",
      "REOPENED>RESOLVED",
      "RESOLVED>CLOSED",
    ]);
    expect(events.every((event) => event.actor.id && event.createdAt)).toBe(true);

    const log = await pool.query<{ action: string }>("SELECT action FROM activity_logs WHERE entity_type = 'suggestions' AND entity_id = $1 ORDER BY id", [id]);
    expect(log.rows.map((row) => row.action)).toContain("suggestion.status_changed");
    expect(log.rows.map((row) => row.action)).toContain("suggestion.assigned");
  });

  it("can be reopened by the reviewer after closing, with a reason", async () => {
    expect((await setStatus(admin, id, { status: "REOPENED", fromStatus: "CLOSED" })).status).toBe(400);
    const reopened = await setStatus(admin, id, { status: "REOPENED", fromStatus: "CLOSED", note: "Client reported it again." });
    expect(reopened.status).toBe(200);
    expect(reopened.body.data).toMatchObject({ status: "REOPENED", closedAt: null });
  });

  it("requires a reason to close an unresolved suggestion", async () => {
    const other = await newSuggestion(bob, "Duplicate report");

    expect((await setStatus(admin, other, { status: "CLOSED", fromStatus: "SUBMITTED" })).status).toBe(400);
    expect((await setStatus(admin, other, { status: "CLOSED", fromStatus: "SUBMITTED", note: "Duplicate of an earlier report." })).status).toBe(200);
  });
});

describe("review list filters, search and paging", () => {
  beforeAll(async () => {
    for (let index = 1; index <= 7; index += 1) {
      await submit(bob, { category: "FEATURE", subject: `Paging item ${index}`, description: "Generated for the paging test." });
    }
  });

  it("filters by status, category, submitter and assignment", async () => {
    const features = await api().get("/api/suggestions/review").query({ category: "FEATURE", submittedBy: bob.id }).set(admin.headers);
    expect(features.body.data.items.every((item: { category: string; submittedBy: { id: string } }) => item.category === "FEATURE" && item.submittedBy.id === bob.id)).toBe(true);

    const closed = await api().get("/api/suggestions/review").query({ status: "CLOSED" }).set(admin.headers);
    expect(closed.body.data.items.every((item: { status: string }) => item.status === "CLOSED")).toBe(true);
    expect(closed.body.data.total).toBeGreaterThanOrEqual(1);

    const assigned = await api().get("/api/suggestions/review").query({ assignedTo: secondAdmin.id }).set(admin.headers);
    expect(assigned.body.data.total).toBe(1);
    const unassigned = await api().get("/api/suggestions/review").query({ assignedTo: "none" }).set(admin.headers);
    expect(unassigned.body.data.items.every((item: { assignedTo: unknown }) => item.assignedTo === null)).toBe(true);
  });

  it("searches by subject and by reference", async () => {
    const bySubject = await api().get("/api/suggestions/review").query({ search: "paging item 3" }).set(admin.headers);
    expect(bySubject.body.data.items.map((item: { subject: string }) => item.subject)).toEqual(["Paging item 3"]);

    const target = bySubject.body.data.items[0];
    const byReference = await api().get("/api/suggestions/review").query({ search: target.reference }).set(admin.headers);
    expect(byReference.body.data.items.map((item: { id: string }) => item.id)).toEqual([target.id]);

    const mine = await api().get("/api/suggestions/mine").query({ search: target.reference }).set(alice.headers);
    expect(mine.body.data.total).toBe(0);
  });

  it("filters by date and pages results", async () => {
    const today = (await pool.query<{ today: string }>("SELECT to_char(current_date, 'YYYY-MM-DD') AS today")).rows[0]!.today;
    const inRange = await api().get("/api/suggestions/review").query({ from: today, to: today }).set(admin.headers);
    const all = await api().get("/api/suggestions/review").set(admin.headers);
    expect(inRange.body.data.total).toBe(all.body.data.total);
    const future = await api().get("/api/suggestions/review").query({ from: "2099-01-01" }).set(admin.headers);
    expect(future.body.data.total).toBe(0);

    const first = await api().get("/api/suggestions/review").query({ pageSize: 5, page: 1 }).set(admin.headers);
    const second = await api().get("/api/suggestions/review").query({ pageSize: 5, page: 2 }).set(admin.headers);
    expect(first.body.data.items).toHaveLength(5);
    expect(second.body.data.page).toBe(2);
    const ids = new Set([...first.body.data.items, ...second.body.data.items].map((item: { id: string }) => item.id));
    expect(ids.size).toBe(first.body.data.items.length + second.body.data.items.length);
  });

  it("offers submitters and assignable reviewers as filter options", async () => {
    const options = await api().get("/api/suggestions/review/options").set(admin.headers);

    expect(options.body.data.submitters.map((user: { id: string }) => user.id).sort()).toEqual([alice.id, bob.id].sort());
    expect(options.body.data.reviewers.map((user: { id: string }) => user.id).sort()).toEqual([admin.id, secondAdmin.id].sort());
  });

  it("gives each option its email and sorts by name regardless of letter case, so equal names can be told apart", async () => {
    await pool.query("UPDATE users SET full_name = 'same name' WHERE id = $1", [alice.id]);
    await pool.query("UPDATE users SET full_name = 'Same Name' WHERE id = $1", [bob.id]);

    const { submitters } = (await api().get("/api/suggestions/review/options").set(admin.headers)).body.data as {
      submitters: { id: string; fullName: string; email: string }[];
    };
    const emails = (await pool.query<{ id: string; email: string }>("SELECT id, email FROM users WHERE id = ANY($1)", [[alice.id, bob.id]])).rows;

    expect(submitters).toEqual(
      emails
        .map((row) => ({ id: row.id, fullName: row.id === alice.id ? "same name" : "Same Name", email: row.email }))
        .sort((left, right) => left.email.toLowerCase().localeCompare(right.email.toLowerCase()))
    );
  });
});

describe("existing submissions", () => {
  it("stays readable to its submitter after their role changes", async () => {
    const id = await newSuggestion(alice, "Kept after role change");
    await pool.query("DELETE FROM user_roles WHERE user_id = $1", [alice.id]);

    const response = await detail(alice, id);
    expect(response.status).toBe(200);
    expect(response.body.data.subject).toBe("Kept after role change");
  });
});

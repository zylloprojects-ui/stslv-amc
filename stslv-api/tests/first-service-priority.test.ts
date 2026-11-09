import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays } from "../src/modules/amc/amc.schedule";
import { activeContract, createClient, today, visitsOf, withServiceReport, type Session } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";

// First Service (P2, 2026-11-09): the contract's earliest valid (not cancelled, not historical)
// visit by scheduled date. AMC Contracts' First Service date and AMC Schedule's First Service
// colour must agree, whatever was cancelled, re-dated or postponed. The five-level order is unchanged.

let admin: Session;
let clientId: string;

const get = (url: string) => api().get(`/api${url}`).set(admin.headers);
const patch = (url: string, body: Record<string, unknown>) => api().patch(`/api${url}`).set(admin.headers).send(body);
const body = (system: string) => ({ clientId, systemDescription: system, validFrom: "2027-01-01", validTo: "2027-12-31", contractValue: "1200.000", maintenanceFrequency: "QUARTERLY", defaultVisitAmount: "300.000" });
const visit = async (id: string) => (await get(`/amc/visits/${id}`)).body.data;
const firstServiceDate = async (contractId: string) => {
  const contract = (await get(`/amc/contracts/${contractId}`)).body.data;
  return contract.schedule?.firstServiceDate ?? contract.firstServiceDate;
};

/** Completed and Paid, so the colour shows First Service or Normal rather than Invoice Pending. */
async function completeAndPay(id: string, invoiceNo: string) {
  await withServiceReport(id);
  expect((await patch(`/amc/execution/visits/${id}`, { status: "COMPLETED", completedDate: await today() })).status).toBe(200);
  const updatedAt = (await visit(id)).updatedAt;
  expect((await patch(`/amc/visits/${id}/manual-invoice`, { invoiceNo, expectedUpdatedAt: updatedAt })).status).toBe(200);
}

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@first.example.com", ["ADMIN"]);
  clientId = await createClient(admin, "First Service Hotel");
});
afterAll(closePool);

describe("First Service", () => {
  it("is the earliest visit by date when nothing has moved", async () => {
    const id = await activeContract(admin, clientId, body("PLAIN"));
    const [first, second] = await visitsOf(id);
    await completeAndPay(first!.id, "FS-PLAIN-1");
    await completeAndPay(second!.id, "FS-PLAIN-2");

    expect((await visit(first!.id)).colorState).toBe("FIRST_SERVICE");
    expect((await visit(second!.id)).colorState).toBe("NORMAL");
    expect(await firstServiceDate(id)).toBe(first!.scheduled_date);
  });

  it("skips a cancelled visit: the next valid visit becomes first, on Contracts and Schedule alike", async () => {
    const id = await activeContract(admin, clientId, body("CANCELLED"));
    const [first, second, third] = await visitsOf(id);
    expect((await patch(`/amc/execution/visits/${first!.id}`, { status: "CANCELLED", statusReason: "Client closed for refurbishment" })).status).toBe(200);
    await completeAndPay(second!.id, "FS-CAN-2");
    await completeAndPay(third!.id, "FS-CAN-3");

    expect((await visit(first!.id)).colorState).toBe("CANCELLED");
    expect((await visit(second!.id)).colorState).toBe("FIRST_SERVICE");
    expect((await visit(third!.id)).colorState).toBe("NORMAL");
    expect(await firstServiceDate(id)).toBe(second!.scheduled_date);
  });

  it("follows the date, not the sequence, when a visit is postponed past the next one", async () => {
    const id = await activeContract(admin, clientId, body("POSTPONED"));
    const [first, second] = await visitsOf(id);
    const later = addDays(second!.scheduled_date, 1);
    expect((await patch(`/amc/execution/visits/${first!.id}`, { status: "POSTPONED", scheduledDate: later, statusReason: "Site not ready" })).status).toBe(200);
    await completeAndPay(second!.id, "FS-POST-2");
    await completeAndPay(first!.id, "FS-POST-1");

    expect((await visit(second!.id)).colorState).toBe("FIRST_SERVICE");
    expect((await visit(first!.id)).colorState).toBe("NORMAL");
    expect(await firstServiceDate(id)).toBe(second!.scheduled_date);
  });

  it("follows a re-dated (reordered) visit, and the Manual and Invoice Pending levels still come first", async () => {
    const id = await activeContract(admin, clientId, body("REORDERED"));
    const [first, second, third] = await visitsOf(id);
    // The third visit is moved to the start of the year: it is now the earliest.
    const earliest = addDays(first!.scheduled_date, -1);
    expect((await patch(`/amc/visits/${third!.id}`, { scheduledDate: earliest })).status).toBe(200);
    expect(await firstServiceDate(id)).toBe(earliest);

    // Not yet Paid: Invoice Pending outranks First Service.
    expect((await visit(third!.id)).colorState).toBe("INVOICE_PENDING");
    await completeAndPay(third!.id, "FS-RE-3");
    await completeAndPay(first!.id, "FS-RE-1");
    expect((await visit(third!.id)).colorState).toBe("FIRST_SERVICE");
    expect((await visit(first!.id)).colorState).toBe("NORMAL");

    // A manual colour outranks everything.
    expect((await patch(`/amc/visits/${third!.id}/color`, { color: "PURPLE" })).body.data.colorState).toBe("MANUAL");
    expect((await visit(second!.id)).colorState).toBe("INVOICE_PENDING");
  });

  it("lists exactly one first service per contract on the schedule", async () => {
    const list = (await api().get("/api/amc/visits").query({ pageSize: 200, clientId }).set(admin.headers)).body.data.items as { contract: { id: string }; colorState: string; manualInvoiceNo: string | null; status: string }[];
    const firstPaid = new Map<string, number>();
    for (const item of list.filter((row) => row.colorState === "FIRST_SERVICE")) firstPaid.set(item.contract.id, (firstPaid.get(item.contract.id) ?? 0) + 1);
    expect([...firstPaid.values()].every((count) => count === 1)).toBe(true);
  });
});

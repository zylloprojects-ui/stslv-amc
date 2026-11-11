import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { setStorageForTests } from "../src/modules/attachments/attachments.service";
import { masterStatusColumns } from "../src/modules/amc/master-status.export";
import { serviceStatusColumns } from "../src/modules/amc/service-status.export";
import { LocalDiskStorage } from "../src/shared/storage";
import { activeContract, contractBody, createClient, grant, newContractBody, renewalEngineer, TEST_PDF, visitsOf, withRenewalDocument, withServiceReport, type Session } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";
import { cancelInvoice, invoiceBody, newInvoice } from "./invoices-helpers";

// Client-approved enhancements of 2026-11-11 (synthetic records in the stslv_test schema only):
//   A1 a new contract defaults to the annual "AMC Value / Year" billing basis; an explicit choice is kept
//   A2 Final credit: validation and precision (the form copies AMC Value into it; see the web tests)
//   A3 the service-period value (visit_amount from the billing basis) on service-level views
//   A4 AMC Contracts sorting on the server, before paging
//   B  the invoice acknowledgement of each service: Yes / No / Not Applicable, from Invoice Acknowledgements

const ACK = "/api/invoice-acknowledgements";

let admin: Session;
let noAck: Session; // schedule, service status, master status and contracts, but not Invoice Acknowledgements
let ackViewer: Session; // the same, plus Invoice Acknowledgements: View
let noContracts: Session; // no AMC Contracts access at all
let clientId: string;
const folder = mkdtempSync(path.join(tmpdir(), "stslv-cak-storage-"));

const get = (url: string, query: Record<string, unknown> = {}, session: Session = admin) => api().get(`/api${url}`).query(query).set(session.headers);
const amounts = async (id: string) => (await visitsOf(id)).map((visit) => visit.visit_amount);
const contract = async (id: string) => (await get(`/amc/contracts/${id}`)).body.data;
/** A new contract through POST /api/amc/contracts with NO billing basis in the request (undefined leaves it out). */
const withDefaultBasis = (overrides: Record<string, unknown>) => activeContract(admin, clientId, { billingBasis: undefined, defaultVisitAmount: undefined, ...overrides });

async function role(code: string, permissions: [string, string][]) {
  await pool.query("INSERT INTO roles (code, name) VALUES ($1, $1) ON CONFLICT DO NOTHING", [code]);
  await grant(code, permissions);
}

beforeAll(async () => {
  setStorageForTests(new LocalDiskStorage(folder));
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  const pages: [string, string][] = [
    ["AMC_CONTRACTS", "VIEW"],
    ["AMC_SCHEDULE", "VIEW"],
    ["SERVICE_STATUS", "VIEW"],
    ["SERVICE_STATUS", "EXPORT"],
    ["MASTER_AMC_STATUS", "VIEW"],
    ["MASTER_AMC_STATUS", "EXPORT"],
  ];
  await role("CAK_NO_ACK", pages);
  await role("CAK_ACK", [...pages, ["INVOICE_ACKNOWLEDGEMENTS", "VIEW"]]);
  await role("CAK_NONE", [["SERVICE_STATUS", "VIEW"]]);
  noAck = await signedIn("noack@example.com", ["CAK_NO_ACK"]);
  ackViewer = await signedIn("ackviewer@example.com", ["CAK_ACK"]);
  noContracts = await signedIn("nocontracts@example.com", ["CAK_NONE"]);
  clientId = await createClient(admin, "Enhancement Client");
});

afterAll(async () => {
  setStorageForTests(null);
  rmSync(folder, { recursive: true, force: true });
  await closePool();
});

describe("A1 — default annual billing basis", () => {
  it("gives a new contract AMC Value / Year when the request leaves the basis out", async () => {
    const id = await withDefaultBasis({ systemDescription: "DEFAULT QUARTERLY", contractValue: "1200.000", maintenanceFrequency: "QUARTERLY" });

    expect((await contract(id)).billingBasis).toBe("CONTRACT_VALUE");
  });

  it("keeps an explicitly selected alternative, and an explicit Not set", async () => {
    const final = await activeContract(admin, clientId, { systemDescription: "EXPLICIT FINAL", billingBasis: "FINAL_CREDIT", contractValue: "1200.000", finalCredit: "1000.000" });
    const custom = await activeContract(admin, clientId, { systemDescription: "EXPLICIT CUSTOM", billingBasis: "CUSTOM", customBillingValue: "800.000" });
    const notSet = await activeContract(admin, clientId, { systemDescription: "EXPLICIT NONE", billingBasis: null, defaultVisitAmount: "77.000" });

    expect((await contract(final)).billingBasis).toBe("FINAL_CREDIT");
    expect(await amounts(final)).toEqual(["250.000", "250.000", "250.000", "250.000"]);
    expect((await contract(custom)).billingBasis).toBe("CUSTOM");
    expect(await amounts(custom)).toEqual(["200.000", "200.000", "200.000", "200.000"]);
    expect((await contract(notSet)).billingBasis).toBeNull();
    // Without a basis the manual Cost per Visit stands, exactly as before.
    expect(await amounts(notSet)).toEqual(["77.000", "77.000", "77.000", "77.000"]);
  });

  it("does not default a renewal: it keeps the basis its form sends (none here)", async () => {
    const source = await activeContract(admin, clientId, { systemDescription: "RENEW SOURCE", validFrom: "2026-01-01", validTo: "2026-12-31" });
    const renewed = await api()
      .post(`/api/amc/contracts/${source}/renewals`)
      .set(admin.headers)
      .send(withRenewalDocument(contractBody(clientId, { systemDescription: "RENEW SOURCE", validFrom: "2027-01-01", validTo: "2027-12-31", status: "DRAFT", salesEngineerId: await renewalEngineer() })));

    expect(renewed.status).toBe(201);
    expect(renewed.body.data.billingBasis).toBeNull();
  });

  it("never changes the basis or the visits of a saved contract on edit", async () => {
    const id = await activeContract(admin, clientId, { systemDescription: "SAVED NONE", billingBasis: null, defaultVisitAmount: "50.000" });
    const before = await amounts(id);
    const edited = await api().patch(`/api/amc/contracts/${id}`).set(admin.headers).send({ notes: "edited after the default was introduced" });

    expect(edited.status).toBe(200);
    expect(edited.body.data.billingBasis).toBeNull();
    expect(await amounts(id)).toEqual(before);
  });
});

describe("A2 — Final credit (Final Value) validation and precision", () => {
  it("stores the entered amount with three decimals, and keeps a value different from AMC Value", async () => {
    const same = await activeContract(admin, clientId, { systemDescription: "FINAL SAME", contractValue: "1200.000", finalCredit: "1200" });
    const edited = await activeContract(admin, clientId, { systemDescription: "FINAL EDITED", contractValue: "1200.000", finalCredit: "1100.5" });

    expect((await contract(same)).finalCredit).toBe("1200.000");
    expect((await contract(edited)).finalCredit).toBe("1100.500");
    expect((await contract(edited)).contractValue).toBe("1200.000");
  });

  it("refuses a missing, negative or over-precise Final credit on a new contract", async () => {
    for (const finalCredit of ["", "-1", "1.2345", "abc"]) {
      const response = await api()
        .post("/api/amc/contracts")
        .set(admin.headers)
        .send({ ...(await newContractBody(clientId, { systemDescription: `BAD ${finalCredit}` })), finalCredit });

      expect(response.status, finalCredit).toBe(400);
      expect(JSON.stringify(response.body.error.details)).toContain("finalCredit");
    }
  });
});

describe("A3 — service-period values from the billing basis", () => {
  it("AMC Value 1,200.000 quarterly gives 300.000 per quarter", async () => {
    const id = await withDefaultBasis({ systemDescription: "QUARTERLY 1200", contractValue: "1200.000", maintenanceFrequency: "QUARTERLY" });

    expect(await amounts(id)).toEqual(["300.000", "300.000", "300.000", "300.000"]);
    expect((await contract(id)).schedule).toMatchObject({ annualAmount: "1200.000", servicesPerCycle: 4, perServiceAmount: "300.000" });
  });

  it("AMC Value 1,200.000 monthly gives 100.000 per month", async () => {
    const id = await withDefaultBasis({ systemDescription: "MONTHLY 1200", contractValue: "1200.000", maintenanceFrequency: "MONTHLY" });

    expect(await amounts(id)).toEqual(Array(12).fill("100.000"));
  });

  it("an uneven division rounds half up, and the last service of the year takes the remainder", async () => {
    const id = await withDefaultBasis({ systemDescription: "MONTHLY 1000", contractValue: "1000.000", maintenanceFrequency: "MONTHLY" });
    const values = await amounts(id);

    expect(values.slice(0, 11)).toEqual(Array(11).fill("83.333"));
    expect(values[11]).toBe("83.337");
  });

  it("AMC Value is annual: a two-year monthly contract has 24 services of 100.000, not 50.000", async () => {
    const id = await withDefaultBasis({ systemDescription: "TWO YEARS", contractValue: "1200.000", maintenanceFrequency: "MONTHLY", validFrom: "2027-01-01", validTo: "2028-12-31" });

    expect(await amounts(id)).toEqual(Array(24).fill("100.000"));
  });

  it("shows each service's own value on Service Status and Service Sales, beside the contract's annual value", async () => {
    const id = await withDefaultBasis({ systemDescription: "SERVICE VALUE", contractValue: "1200.000", maintenanceFrequency: "QUARTERLY" });
    const reference = (await contract(id)).amcReference;
    const status = (await get("/amc/service-status", { search: reference, pageSize: 50 })).body.data.items;
    const sales = (await get("/services-sales", { search: reference, pageSize: 50 })).body.data.items;

    expect(status).toHaveLength(4);
    expect(status.every((row: { serviceValue: string; amcValue: string }) => row.serviceValue === "300.000" && row.amcValue === "1200.000")).toBe(true);
    expect(sales.every((row: { serviceValue: string; amcValue: string }) => row.serviceValue === "300.000" && row.amcValue === "1200.000")).toBe(true);
  });

  it("never invents a value: a service without one reads null, not 0.000", async () => {
    const id = await activeContract(admin, clientId, { systemDescription: "NO VALUE", billingBasis: null, defaultVisitAmount: undefined });
    const reference = (await contract(id)).amcReference;
    const status = (await get("/amc/service-status", { search: reference })).body.data.items;

    expect(status.length).toBeGreaterThan(0);
    expect(status.every((row: { serviceValue: string | null }) => row.serviceValue === null)).toBe(true);
    // Explained the way Master AMC Status explains it: the contract has no Billing Basis and no Cost per Visit.
    expect(status.every((row: { valueSourceMissing: boolean }) => row.valueSourceMissing === true)).toBe(true);
    const master = (await get("/amc/master-status", { search: reference })).body.data.items;
    expect(master.every((row: { valueSourceMissing: boolean }) => row.valueSourceMissing === true)).toBe(true);
  });

  it("Service Status shows exactly the value Master AMC Status shows (monthly, quarterly, half-yearly, annual, uneven, two years)", async () => {
    const cases: { body: Record<string, string>; count: number; first: string; yearTotal: string }[] = [
      { body: { systemDescription: "SAME MONTHLY", contractValue: "1200.000", maintenanceFrequency: "MONTHLY" }, count: 12, first: "100.000", yearTotal: "1200.000" },
      { body: { systemDescription: "SAME QUARTERLY", contractValue: "1200.000", maintenanceFrequency: "QUARTERLY" }, count: 4, first: "300.000", yearTotal: "1200.000" },
      { body: { systemDescription: "SAME HALF", contractValue: "1200.000", maintenanceFrequency: "HALF_YEARLY" }, count: 2, first: "600.000", yearTotal: "1200.000" },
      { body: { systemDescription: "SAME ANNUAL", contractValue: "1200.000", maintenanceFrequency: "ANNUALLY" }, count: 1, first: "1200.000", yearTotal: "1200.000" },
      { body: { systemDescription: "SAME UNEVEN", contractValue: "1000.000", maintenanceFrequency: "MONTHLY" }, count: 12, first: "83.333", yearTotal: "1000.000" },
      { body: { systemDescription: "SAME TWO YEARS", contractValue: "1000.000", maintenanceFrequency: "QUARTERLY", validFrom: "2027-01-01", validTo: "2028-12-31" }, count: 8, first: "250.000", yearTotal: "1000.000" },
    ];
    const thousandths = (value: string) => Math.round(Number(value) * 1000);

    for (const { body, count, first, yearTotal } of cases) {
      const name = body.systemDescription;
      const id = await withDefaultBasis(body);
      const reference = (await contract(id)).amcReference;
      const status = (await get("/amc/service-status", { search: reference, pageSize: 100 })).body.data.items as { id: string; scheduledDate: string; serviceValue: string; amcValue: string }[];
      const master = (await get("/amc/master-status", { search: reference, pageSize: 100 })).body.data.items as { id: string; visitValue: string }[];
      const masterValue = new Map(master.map((row) => [row.id, row.visitValue]));

      expect(status, name).toHaveLength(count);
      expect(master, name).toHaveLength(count);
      expect(status.every((row) => row.serviceValue === masterValue.get(row.id)), name).toBe(true);
      expect(status[0].serviceValue, name).toBe(first);
      // The contract value itself is unchanged and still sent, but never as the service's value.
      expect(status.every((row) => row.amcValue === body.contractValue), name).toBe(true);
      // Each annual cycle adds up to the annual amount exactly (the rounding remainder sits on the cycle's last service).
      const byCycle = new Map<string, number>();
      for (const row of status) {
        const cycle = row.scheduledDate.slice(0, 4);
        byCycle.set(cycle, (byCycle.get(cycle) ?? 0) + thousandths(row.serviceValue));
      }
      for (const [cycle, total] of byCycle) expect(total, `${name} ${cycle}`).toBe(thousandths(yearTotal));
    }
  });

  it("the Service Status download keeps AMC Value / Year and adds Service Value (OMR) after it, each hidden on its own", async () => {
    const id = await withDefaultBasis({ systemDescription: "EXPORT VALUE", contractValue: "1200.000", maintenanceFrequency: "QUARTERLY" });
    const reference = (await contract(id)).amcReference;
    const headers = serviceStatusColumns({ reportNumber: true, amcValue: true }).map((column) => column.header);

    // Owner decision 2026-11-11: both columns, the contract column unchanged.
    expect(headers.indexOf("Service Value (OMR)")).toBe(headers.indexOf("AMC Value / Year (OMR)") + 1);
    expect(serviceStatusColumns({ reportNumber: true, amcValue: false }).map((column) => column.header)).not.toContain("Service Value (OMR)");

    const sheet = async (query: Record<string, string>) => {
      const file = await api().get("/api/amc/service-status/export").query({ search: reference, format: "xlsx", ...query }).responseType("blob").set(admin.headers);
      expect(file.status).toBe(200);
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(file.body as unknown as ExcelJS.Buffer);
      return JSON.stringify(book.worksheets[0]?.getSheetValues());
    };
    const shown = await sheet({});
    expect(shown).toContain("Service Value (OMR)");
    expect(shown).toContain("AMC Value / Year (OMR)");
    expect(shown).toContain("300");
    const withoutService = await sheet({ hidden: "serviceValue" });
    expect(withoutService).not.toContain("Service Value (OMR)");
    expect(withoutService).toContain("AMC Value / Year (OMR)");
    const withoutContract = await sheet({ hidden: "amcValue" });
    expect(withoutContract).toContain("Service Value (OMR)");
    expect(withoutContract).not.toContain("AMC Value / Year (OMR)");
  });

  it("shows service values only to users who may see contract values", async () => {
    const data = (await get("/amc/service-status", {}, noContracts)).body.data;

    expect(data.amcValueVisible).toBe(false);
    expect(data.items.every((row: { serviceValue: unknown; amcValue: unknown }) => row.serviceValue === null && row.amcValue === null)).toBe(true);
  });
});

describe("A4 — AMC Contracts sorting on the server", () => {
  const sortClient = { id: "" };
  const list = async (query: Record<string, unknown>, session: Session = admin) =>
    get("/amc/contracts", { clientId: sortClient.id, pageSize: 100, ...query }, session);
  const refs = (items: { amcReference: string }[]) => items.map((item) => item.amcReference);

  beforeAll(async () => {
    sortClient.id = await createClient(admin, "Sorting Client");
    const rows: [string, string, string | null, string, string, string | null][] = [
      // reference, value, final, from, to, engineer
      ["SORT-B", "900.000", "100.000", "2027-02-01", "2027-12-31", "Zaid"],
      ["SORT-A", "1000.000", null, "2027-01-01", "2028-06-30", "amal"],
      ["SORT-D", "50.500", "5.000", "2026-06-01", "2027-05-31", null],
      ["SORT-C", "12000.000", "0.000", "2027-03-01", "2027-09-30", "Basma"],
    ];
    for (const [amcReference, contractValue, finalCredit, validFrom, validTo, responsibleEngineer] of rows) {
      await activeContract(admin, sortClient.id, { amcReference, systemDescription: amcReference, contractValue, finalCredit: finalCredit ?? "0.000", validFrom, validTo, responsibleEngineer: responsibleEngineer ?? undefined });
      if (finalCredit === null) await pool.query("UPDATE amc_contracts_all SET final_credit = NULL WHERE amc_reference = $1", [amcReference]);
    }
    // A draft, for the status order.
    await pool.query("UPDATE amc_contracts_all SET status = 'DRAFT' WHERE amc_reference = 'SORT-C'");
  });

  it("keeps the usual order when no sort is asked for", async () => {
    const response = await list({});
    expect(response.status).toBe(200);
    // One client: newest validity first.
    expect(refs(response.body.data.items)).toEqual(["SORT-C", "SORT-B", "SORT-A", "SORT-D"]);
  });

  it("sorts amounts as numbers, both ways", async () => {
    expect(refs((await list({ sort: "contractValue" })).body.data.items)).toEqual(["SORT-D", "SORT-B", "SORT-A", "SORT-C"]);
    expect(refs((await list({ sort: "contractValue", direction: "desc" })).body.data.items)).toEqual(["SORT-C", "SORT-A", "SORT-B", "SORT-D"]);
    // No Final credit comes last in either direction.
    expect(refs((await list({ sort: "finalCredit" })).body.data.items)).toEqual(["SORT-C", "SORT-D", "SORT-B", "SORT-A"]);
    expect(refs((await list({ sort: "finalCredit", direction: "desc" })).body.data.items)).toEqual(["SORT-B", "SORT-D", "SORT-C", "SORT-A"]);
  });

  it("sorts dates as dates, text without regard to case, status in workflow order, empty engineer last", async () => {
    expect(refs((await list({ sort: "validFrom" })).body.data.items)).toEqual(["SORT-D", "SORT-A", "SORT-B", "SORT-C"]);
    expect(refs((await list({ sort: "validTo", direction: "desc" })).body.data.items)).toEqual(["SORT-A", "SORT-B", "SORT-C", "SORT-D"]);
    expect(refs((await list({ sort: "reference" })).body.data.items)).toEqual(["SORT-A", "SORT-B", "SORT-C", "SORT-D"]);
    expect(refs((await list({ sort: "engineer" })).body.data.items)).toEqual(["SORT-A", "SORT-C", "SORT-B", "SORT-D"]);
    expect(refs((await list({ sort: "status" })).body.data.items)[0]).toBe("SORT-C");
  });

  it("sorts the whole filtered list before paging: pages join up in order", async () => {
    const page1 = (await list({ sort: "contractValue", direction: "desc", pageSize: 2, page: 1 })).body.data;
    const page2 = (await list({ sort: "contractValue", direction: "desc", pageSize: 2, page: 2 })).body.data;

    expect(page1.total).toBe(4);
    expect([...refs(page1.items), ...refs(page2.items)]).toEqual(["SORT-C", "SORT-A", "SORT-B", "SORT-D"]);
  });

  it("works with search and filters, and keeps the filtered totals", async () => {
    const data = (await list({ search: "SORT-", status: "ACTIVE", sort: "validTo" })).body.data;

    expect(refs(data.items)).toEqual(["SORT-D", "SORT-B", "SORT-A"]);
    expect(data.totals.contractValue).toBe("1950.500");
  });

  it("refuses an unknown column or direction, and still needs AMC Contracts: View", async () => {
    expect((await list({ sort: "c.id; DROP TABLE x" })).status).toBe(400);
    expect((await list({ sort: "client", direction: "sideways" })).status).toBe(400);
    expect((await list({ sort: "client" }, noContracts)).status).toBe(403);
  });

  it("orders the export the same way", async () => {
    const response = await api()
      .get("/api/amc/contracts/export")
      .query({ clientId: sortClient.id, sort: "contractValue", direction: "desc", format: "xlsx" })
      .set(admin.headers);

    expect(response.status).toBe(200);
  });
});

describe("B — invoice acknowledgement of each service", () => {
  const visits: string[] = [];
  let reference = "";

  const complete = async (visitId: string) => {
    await withServiceReport(visitId);
    const row = (await get(`/amc/service-status/${visitId}`)).body.data;
    expect((await api().patch(`/api/amc/service-status/${visitId}`).set(admin.headers).send({ status: "COMPLETED", expectedUpdatedAt: row.updatedAt })).status).toBe(200);
  };
  const setInvoiceNo = async (visitId: string, invoiceNo: string | null) => {
    const updatedAt = (await get(`/amc/visits/${visitId}`)).body.data.updatedAt;
    expect((await api().patch(`/api/amc/visits/${visitId}/manual-invoice`).set(admin.headers).send({ invoiceNo, expectedUpdatedAt: updatedAt })).status).toBe(200);
  };
  type Ack = { state: string; acknowledged: string; invoiceId: string | null; documentAvailable: boolean; acknowledgedAt: string | null } | null;
  const master = async (session: Session = ackViewer) => (await get("/amc/master-status", { search: reference, pageSize: 50, sort: "scheduledDate" }, session)).body.data;
  const masterAcks = async (session: Session = ackViewer): Promise<Ack[]> => {
    const items = (await master(session)).items as { id: string; acknowledgement: Ack }[];
    return visits.map((id) => items.find((item) => item.id === id)?.acknowledgement ?? null);
  };
  const ackInvoice = async (number: string) =>
    ((await api().get(ACK).query({ pageSize: 200 }).set(admin.headers)).body.data.items as { invoiceId: string; invoiceNo: string; client: { id: string } }[]).find(
      (item) => item.invoiceNo === number && item.client.id === clientId
    )!;
  const snapshot = async () =>
    (
      await pool.query(
        `SELECT (SELECT count(*) FROM invoice_acknowledgements)::int AS acks,
                (SELECT count(*) FROM ack_invoices)::int AS invoices,
                (SELECT count(*) FROM ack_invoice_services)::int AS links,
                (SELECT count(*) FROM activity_logs)::int AS logs,
                (SELECT string_agg(id || ':' || COALESCE(manual_invoice_no, '-') || ':' || status, ',' ORDER BY id) FROM amc_visits_all) AS visits`
      )
    ).rows[0];

  beforeAll(async () => {
    const id = await withDefaultBasis({ amcReference: "STS-CAK-ACK", systemDescription: "ACK VIEWS", contractValue: "1200.000", maintenanceFrequency: "QUARTERLY", validFrom: "2026-01-01", validTo: "2026-12-31" });
    reference = "STS-CAK-ACK";
    visits.push(...(await visitsOf(id)).map((visit) => visit.id));
    for (const visit of visits.slice(0, 3)) await complete(visit);
    // v0: its own invoice; v1 + v2: ONE shared invoice number; v3: not completed, no invoice.
    await setInvoiceNo(visits[0]!, "CAK-1");
    await setInvoiceNo(visits[1]!, "CAK-SHARED");
    await setInvoiceNo(visits[2]!, "CAK-SHARED");
    // One invoice for both: the Invoice Tracking record allocated to the two services is what makes the shared number
    // ONE invoice (equal numbers alone are never merged; they are flagged for reconciliation instead).
    await newInvoice(admin, invoiceBody(clientId, [{ amcVisitId: visits[1]!, amount: "300.000" }, { amcVisitId: visits[2]!, amount: "300.000" }], { invoiceNumber: "CAK-SHARED", amountExclVat: "600.000", vatAmount: "0.000", invoiceDate: "2026-09-30" }));
  });

  it("an Invoice No. alone is never acknowledged; no invoice is Not Applicable", async () => {
    const acks = await masterAcks();

    expect(acks.map((ack) => ack?.acknowledged)).toEqual(["NO", "NO", "NO", "NOT_APPLICABLE"]);
    expect(acks.slice(0, 3).every((ack) => ack?.state === "PENDING" && !ack.documentAvailable)).toBe(true);
    expect(acks[3]).toMatchObject({ state: "NOT_APPLICABLE", invoiceId: null });
    expect((await master()).acknowledgementsVisible).toBe(true);
  });

  it("is not sent at all to a user without Invoice Acknowledgements: View", async () => {
    const data = await master(noAck);

    expect(data.acknowledgementsVisible).toBe(false);
    expect(data.items.every((item: { acknowledgement: unknown }) => item.acknowledgement === null)).toBe(true);
    const status = (await get("/amc/service-status", { search: reference }, noAck)).body.data;
    expect(status.acknowledgementsVisible).toBe(false);
    expect(status.items.every((item: { acknowledgement: unknown }) => item.acknowledgement === null)).toBe(true);
    const schedule = (await get("/amc/visits", { contractId: (await master()).items[0].contract.id }, noAck)).body.data;
    expect(schedule.acknowledgementsVisible).toBe(false);
    expect(schedule.items.every((item: object) => !("acknowledgement" in item))).toBe(true);
  });

  it("an uploaded but unconfirmed document is still No, for every service sharing the invoice", async () => {
    const shared = await ackInvoice("CAK-SHARED");
    const uploaded = await api()
      .post(`${ACK}/${shared.invoiceId}/document`)
      .set(admin.headers)
      .set("Content-Type", "application/octet-stream")
      .set("X-File-Name", "ack.pdf")
      .send(TEST_PDF);
    expect(uploaded.status).toBe(201);

    const acks = await masterAcks();
    expect(acks[1]).toMatchObject({ state: "AWAITING_CONFIRMATION", acknowledged: "NO", documentAvailable: true, invoiceId: shared.invoiceId });
    expect(acks[2]).toMatchObject({ state: "AWAITING_CONFIRMATION", acknowledged: "NO", invoiceId: shared.invoiceId });
    expect(acks[0]).toMatchObject({ state: "PENDING", acknowledged: "NO" });
  });

  it("confirmed: Yes on both services of the shared invoice, and only on them", async () => {
    const shared = await ackInvoice("CAK-SHARED");
    const detail = (await api().get(`${ACK}/${shared.invoiceId}`).set(admin.headers)).body.data;
    expect((await api().post(`${ACK}/${shared.invoiceId}/confirm`).set(admin.headers).send({ attachmentId: detail.document.attachmentId })).status).toBe(200);

    const acks = await masterAcks();
    expect(acks.map((ack) => ack?.acknowledged)).toEqual(["NO", "YES", "YES", "NOT_APPLICABLE"]);
    expect(acks[1]?.acknowledgedAt).toBeTruthy();
  });

  it("Service Status and Contract 360 read exactly the same state as Master AMC Status", async () => {
    const fromMaster = await masterAcks();
    const status = (await get("/amc/service-status", { search: reference, pageSize: 50 }, ackViewer)).body.data.items as { id: string; acknowledgement: Ack; serviceStatus: string }[];
    const contractId = (await master()).items[0].contract.id;
    const schedule = (await get("/amc/visits", { contractId, pageSize: 50 }, ackViewer)).body.data.items as { id: string; acknowledgement: Ack }[];

    expect(visits.map((id) => status.find((row) => row.id === id)?.acknowledgement)).toEqual(fromMaster);
    expect(visits.map((id) => schedule.find((row) => row.id === id)?.acknowledgement)).toEqual(fromMaster);
    // Execution status is kept apart: a completed service with an unacknowledged invoice is still Completed.
    expect(status.find((row) => row.id === visits[0])?.serviceStatus).toBe("COMPLETED");
  });

  it("serves the document privately: the Invoice Acknowledgements permission, never a public URL", async () => {
    const [, ack] = await masterAcks();
    const allowed = await api().get(`${ACK}/${ack!.invoiceId}/document`).set(ackViewer.headers);
    const refused = await api().get(`${ACK}/${ack!.invoiceId}/document`).set(noAck.headers);

    expect(allowed.status).toBe(200);
    expect(allowed.headers["cache-control"]).toBe("no-store");
    expect(refused.status).toBe(403);
    expect(JSON.stringify(await master())).not.toMatch(/storage_?key|https?:\/\//i);
  });

  it("a cancelled Invoice Tracking record changes nothing and acknowledges nothing", async () => {
    const zoho = await newInvoice(admin, invoiceBody(clientId, [{ amcVisitId: visits[0]!, amount: "300.000" }], { invoiceNumber: "CAK-1", amountExclVat: "300.000", vatAmount: "0.000", invoiceDate: "2026-03-31" }));
    expect((await cancelInvoice(admin, zoho.id)).status).toBe(200);

    expect((await masterAcks())[0]).toMatchObject({ state: "PENDING", acknowledged: "NO" });
  });

  it("only reads: listing writes no acknowledgement, link, audit entry or service change", async () => {
    // Let the module link everything first (its own reads do), then compare the service-level reads.
    await api().get(ACK).set(admin.headers);
    const before = await snapshot();

    await master();
    await get("/amc/service-status", { search: reference }, ackViewer);
    await get("/amc/visits", { contractId: (await master()).items[0].contract.id }, ackViewer);

    expect(await snapshot()).toEqual(before);
  });

  it("adds the column to the exports only for users who may see it", async () => {
    expect(masterStatusColumns([], { acknowledgements: true }).map((column) => column.header)).toContain("Invoice Acknowledged");
    expect(masterStatusColumns([]).map((column) => column.header)).not.toContain("Invoice Acknowledged");
    const headers = masterStatusColumns([], { acknowledgements: true }).map((column) => column.header);
    expect(headers.indexOf("Invoice Acknowledged")).toBe(headers.indexOf("Quote No.") + 1);
    expect(serviceStatusColumns({ reportNumber: true, amcValue: true, acknowledgements: true }).map((column) => column.header)).toEqual(
      expect.arrayContaining(["Service Value (OMR)", "Invoice Acknowledged"])
    );
    expect(serviceStatusColumns({ reportNumber: true }).map((column) => column.header)).not.toContain("Invoice Acknowledged");

    for (const session of [ackViewer, noAck]) {
      expect((await api().get("/api/amc/master-status/export").query({ search: reference, format: "xlsx" }).set(session.headers)).status).toBe(200);
      expect((await api().get("/api/amc/service-status/export").query({ search: reference, format: "pdf" }).set(session.headers)).status).toBe(200);
    }
  });
});

describe("Dashboard YTD regression", () => {
  it("still returns the Current Year (YTD) figures beside the unchanged KPIs", async () => {
    const data = (await get("/dashboard/operations")).body.data;

    expect(Object.keys(data.kpis).sort()).toEqual(["contracts", "payments", "services"]);
    expect(data.yearToDate).toMatchObject({ from: expect.stringMatching(/-01-01$/), due: expect.any(Number), completed: expect.any(Number) });
    expect(data.yearToDate.pending).toBe(data.yearToDate.due - data.yearToDate.completed);
  });
});

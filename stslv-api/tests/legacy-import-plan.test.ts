import { describe, expect, it } from "vitest";
import { planClients } from "../src/legacy-import/clients";
import { equalsProduct, readMoney, vatAmount } from "../src/legacy-import/money";
import { buildPlan, monthNumber, type ImportPlan, type PlanRow } from "../src/legacy-import/plan";
import type { Cell } from "../src/legacy-import/xlsx";
import { contract, database, job, period, sourceData } from "./legacy-import-fixtures";

// The plan of a historical import: what would be created, what is held, and
// why. Pure logic: no workbook, no database. Every name, number and amount in
// this file is invented.

const cell = (value: string, type: Cell["type"] = "number"): Cell => ({ ref: "G5", column: "G", row: 5, type, value, formula: null, fontColor: null });
const plan = (parts: Parameters<typeof sourceData>[0], options: Parameters<typeof buildPlan>[2] = { approvedClientAliases: [] }, state = database()) =>
  buildPlan(sourceData(parts), state, options);
const project = (result: ImportPlan, row: number) => result.projects.find((item) => item.source.row === row) as ImportPlan["projects"][number];
const visit = (result: ImportPlan, cellRef: string) => result.visits.find((item) => item.source.cell === cellRef) as ImportPlan["visits"][number];
const codes = (row: PlanRow<unknown>) => row.holdReasons.map((reason) => reason.code);

/** An ordinary quarterly contract (July to June, 4 x 400) with the four rows the 2026 schedule lists for it. */
const ALPHA = contract(5);
const ALPHA_ROWS = [
  period("B6", "2026-01-01", "ALPHA HOTEL FIRE Q3", "400.000", 9101),
  period("B16", "2026-04-01", "ALPHA HOTEL FIRE Q4", "400.000"),
  period("B26", "2026-07-01", "ALPHA HOTEL FIRE Q1 ", "400.000"),
  period("B36", "2026-10-01", "ALPHA HOTEL FIRE Q2", "400.000"),
];

describe("money read from a workbook", () => {
  it("tells an empty cell, an entered zero, an amount and something that is not an amount apart", () => {
    expect(readMoney(undefined)).toEqual({ kind: "BLANK" });
    expect(readMoney(cell("0"))).toEqual({ kind: "VALUE", amount: "0.000", isZero: true });
    expect(readMoney(cell("576"))).toEqual({ kind: "VALUE", amount: "576.000", isZero: false });
    expect(readMoney(cell("TBC", "text"))).toEqual({ kind: "INVALID", raw: "TBC", reason: "not a number" });
    expect(readMoney(cell("  ", "text"))).toEqual({ kind: "BLANK" });
    expect(readMoney(cell("-5"))).toMatchObject({ kind: "INVALID", reason: "negative" });
    expect(readMoney(cell("1.23456"))).toMatchObject({ kind: "INVALID", reason: "more than three decimal places" });
  });

  it("reads a three-decimal amount exactly, however the spreadsheet stored it", () => {
    expect(readMoney(cell("1577.2760000000001"))).toMatchObject({ amount: "1577.276" });
    expect(readMoney(cell("33.332999999999998"))).toMatchObject({ amount: "33.333" });
    expect(readMoney(cell("9840.0220000000008"))).toMatchObject({ amount: "9840.022" });
    expect(readMoney(cell("99999999999.999"))).toMatchObject({ amount: "99999999999.999" });
    expect(readMoney(cell("1.5E3"))).toMatchObject({ amount: "1500.000" });
  });

  it("calculates VAT as PostgreSQL will, to three decimals, without floating point", () => {
    expect(vatAmount("1000.000", "5.000")).toBe("50.000");
    expect(vatAmount("33.333", "5.000")).toBe("1.667");
    expect(vatAmount("1577.276", "5.000")).toBe("78.864");
    expect(vatAmount("0.000", "5.000")).toBe("0.000");
  });

  it("confirms that a VAT cell is five percent of the job value, unrounded", () => {
    expect(equalsProduct(cell("78.863800000000012"), "1577.276", "0.05")).toBe(true);
    expect(equalsProduct(cell("1.66665"), "33.333", "0.05")).toBe(true);
    expect(equalsProduct(cell("0"), "0.000", "0.05")).toBe(true);
    expect(equalsProduct(cell("78.86"), "1577.276", "0.05")).toBe(false);
    expect(equalsProduct(undefined, "100.000", "0.05")).toBe(false);
  });
});

describe("client names", () => {
  const names = (raws: string[], contractNames: string[] = [], approved: { alias: string; master: string }[] = [], existing: { id: string; name: string }[] = []) =>
    planClients(raws.map((raw) => ({ raw, source: "jobs" as const })), contractNames, [], approved, existing);
  const find = (result: ReturnType<typeof names>, raw: string) => result.names.find((name) => name.raw === raw) as ReturnType<typeof names>["names"][number];

  it("removes outer and repeated spaces and ignores letter case, and nothing else", () => {
    const result = names(["ECHO ", "ECHO", " Echo", "PAPA  LIMA", "PAPA LIMA"]);

    expect(result.masters.map((master) => master.name)).toEqual(["ECHO", "PAPA LIMA"]);
    expect(find(result, "ECHO ").classification).toBe("SAFE_NORMALIZATION");
    expect(find(result, "ECHO ").normalized).toBe("ECHO");
    expect(find(result, "PAPA  LIMA")).toMatchObject({ normalized: "PAPA LIMA", masterName: "PAPA LIMA", outcome: "PROPOSED_NEW_CLIENT" });
    // The raw name is kept exactly as it was read.
    expect(result.names.map((name) => name.raw)).toContain("ECHO ");
  });

  it("does not merge names that only look alike", () => {
    const result = names(["QBG", "SBG", "JASPER HOTEL", "JASPER COMPLEX", "NPH", "NPI", "MPH"]);

    expect(result.masters).toHaveLength(7);
    expect(result.names.every((name) => name.outcome === "PROPOSED_NEW_CLIENT" && name.classification === "KEEP_SEPARATE")).toBe(true);
    // They are listed for review, and that is all.
    expect(find(result, "QBG").lookAlikes).toEqual(["SBG (one character apart)"]);
    expect(find(result, "JASPER HOTEL").lookAlikes).toEqual(['JASPER COMPLEX (shared name "JASPER")']);
  });

  it("proposes an alias for a spacing-only difference and holds it until it is approved", () => {
    const result = names(["DELTAHOUSE", "DELTA HOUSE", "DELTA HOUSE"]);

    expect(result.masters.map((master) => master.name)).toEqual(["DELTA HOUSE"]);
    expect(find(result, "DELTAHOUSE")).toMatchObject({ classification: "PROPOSED_ALIAS", outcome: "HELD_ALIAS_NOT_APPROVED", masterName: "DELTA HOUSE" });
    expect(find(result, "DELTA HOUSE")).toMatchObject({ outcome: "PROPOSED_NEW_CLIENT" });
  });

  it("applies an alias only once it is approved, and refuses an approval it did not propose", () => {
    const approved = names(["DELTAHOUSE", "DELTA HOUSE"], [], [{ alias: "DELTAHOUSE", master: "DELTA HOUSE" }]);

    expect(find(approved, "DELTAHOUSE").outcome).toBe("ALIAS_OF_PROPOSED_CLIENT");
    expect(() => names(["QBG", "SBG"], [], [{ alias: "QBG", master: "SBG" }])).toThrow(/not an alias this import proposes/);
  });

  it("takes the spelling of the contract register as the master of a spacing pair", () => {
    const result = names(["HOTELINN", "HOTELINN", "HOTELINN", "HOTEL INN"], ["HOTEL INN"]);

    expect(find(result, "HOTELINN")).toMatchObject({ masterName: "HOTEL INN", outcome: "HELD_ALIAS_NOT_APPROVED" });
  });

  it("holds a short name and the longer names that begin with it: the workbooks cannot say who is who", () => {
    const result = names(["GAMMA ", "GAMMA HOLDINGS", "OTHER"]);

    expect(find(result, "GAMMA ")).toMatchObject({ classification: "CLIENT_CONFIRMATION_REQUIRED", outcome: "HELD_IDENTITY_UNCONFIRMED" });
    expect(find(result, "GAMMA HOLDINGS")).toMatchObject({ outcome: "HELD_IDENTITY_UNCONFIRMED" });
    expect(find(result, "OTHER").outcome).toBe("PROPOSED_NEW_CLIENT");
    expect(result.masters.filter((master) => master.held).map((master) => master.name)).toEqual(["GAMMA", "GAMMA HOLDINGS"]);
  });

  it("matches a client already in the database by name, ignoring case and spaces, and never by resemblance", () => {
    const result = names(["ECHO ", "QBG"], [], [], [{ id: "7", name: "echo" }, { id: "8", name: "SBG" }]);

    expect(find(result, "ECHO ")).toMatchObject({ outcome: "EXISTING_CLIENT", existingClientId: "7" });
    expect(find(result, "QBG")).toMatchObject({ outcome: "PROPOSED_NEW_CLIENT", existingClientId: null });
  });
});

describe("month names", () => {
  it("reads full and shortened month names, and nothing else", () => {
    expect([monthNumber("JAN"), monthNumber("FEB"), monthNumber("JUNE"), monthNumber("JULY"), monthNumber("Sept"), monthNumber(" dec ")]).toEqual([1, 2, 6, 7, 9, 12]);
    expect([monthNumber("JU"), monthNumber("Q1"), monthNumber("13"), monthNumber("")]).toEqual([null, null, null, null]);
  });
});

describe("historical projects", () => {
  it("keeps the source status verbatim and proposes status HISTORICAL with no completion date", () => {
    const result = plan({ jobs: [job(5, { status: "Completed" }), job(6, { status: " Not Completed " })] });

    expect(project(result, 5).proposed).toMatchObject({ status: "HISTORICAL", legacyStatus: "Completed", completedDate: null });
    expect(project(result, 6).proposed).toMatchObject({ status: "HISTORICAL", legacyStatus: "Not Completed", completedDate: null });
    expect(result.projects.every((row) => row.disposition === "IMPORTABLE" && row.destination === "projects (status HISTORICAL)")).toBe(true);
  });

  it("stores a month-only date as the first of the month, marked MONTH, and never invents a day", () => {
    const result = plan({ jobs: [job(5, { month: "FEB" }), job(6, { month: "JUNE" }), job(7, { month: "JULY" })] });

    expect(result.projects.map((row) => [row.proposed.sourceJobDate, row.proposed.jobDate, row.proposed.jobDatePrecision])).toEqual([
      ["FEB 2025", "2025-02-01", "MONTH"],
      ["JUNE 2025", "2025-06-01", "MONTH"],
      ["JULY 2025", "2025-07-01", "MONTH"],
    ]);
  });

  it("holds a job whose month or year cannot be read", () => {
    const unknown = plan({ jobs: [job(5, { month: "Q1" }), job(6, { month: null })] });
    const noYear = plan({ jobs: [job(5)], jobsYear: null });

    expect(codes(project(unknown, 5))).toEqual(["MONTH_NOT_UNDERSTOOD"]);
    expect(codes(project(unknown, 6))).toEqual(["MONTH_MISSING"]);
    expect(project(unknown, 5).proposed.jobDate).toBeNull();
    expect(codes(project(noYear, 5))).toEqual(["YEAR_MISSING"]);
  });

  it("preserves an explicit zero as 0.000: it is not missing", () => {
    const result = plan({ jobs: [job(78, { amount: "0.000" }), job(79, { amount: "0.000" })] });

    for (const row of result.projects) {
      expect(row.disposition).toBe("IMPORTABLE");
      expect(row.proposed).toMatchObject({ jobValue: "0.000", vatRate: "5.000", vatAmount: "0.000", grandValue: "0.000" });
      expect(row.warnings).toContain("The job value is an explicit zero in the source and is kept as 0.000.");
    }
  });

  it("holds a job with an empty job value and does not give it one", () => {
    const result = plan({ jobs: [job(99, { amount: null })] });
    const row = project(result, 99);

    expect(row.disposition).toBe("HELD");
    expect(codes(row)).toEqual(["JOB_VALUE_BLANK"]);
    expect(row.proposed).toMatchObject({ jobValue: null, vatAmount: null, grandValue: null });
    expect(JSON.stringify(row.proposed)).not.toContain("0.000");
    expect(result.totals.projects).toMatchObject({ importable: 0, held: 1, sourceValue: "0.000" });
  });

  it("holds a job value that is not an amount", () => {
    const invalid = job(5);

    invalid.value = { kind: "INVALID", raw: "TBC", reason: "not a number" };

    expect(codes(project(plan({ jobs: [invalid] }), 5))).toEqual(["JOB_VALUE_INVALID"]);
  });

  it("calculates VAT and grand value from the confirmed five percent, to three decimals", () => {
    const result = plan({ jobs: [job(5, { amount: "1577.276" }), job(6, { amount: "33.333" })] });

    expect(project(result, 5).proposed).toMatchObject({ jobValue: "1577.276", vatRate: "5.000", vatAmount: "78.864", grandValue: "1656.140" });
    expect(project(result, 6).proposed).toMatchObject({ vatAmount: "1.667", grandValue: "35.000" });
  });

  it("holds a job whose VAT cell is not five percent of its value", () => {
    const row = project(plan({ jobs: [job(5, { amount: "100.000", vat: "10" })] }), 5);

    expect(codes(row)).toEqual(["VAT_NOT_CONFIRMED"]);
    expect(row.proposed.vatRate).toBeNull();
  });

  it("holds both rows of a duplicated job number and changes neither number", () => {
    // Row 53 carries the serial of the one missing number, as in the source register.
    const result = plan({
      jobs: [job(52, { jobNumber: "JOB0568", serial: "568" }), job(53, { jobNumber: "JOB0573", serial: "569", client: "LIMA MALL" }), job(54, { jobNumber: "JOB0570", serial: "570" }), job(57, { jobNumber: "JOB0573", serial: "573" })],
    });

    expect(codes(project(result, 53))).toEqual(["DUPLICATE_JOB_NUMBER"]);
    expect(codes(project(result, 57))).toEqual(["DUPLICATE_JOB_NUMBER"]);
    expect(project(result, 53).holdReasons[0]?.message).toContain("rows 53, 57");
    // Nothing is corrected: both keep the number the register gives, and the missing number is given to no one.
    expect(project(result, 53).proposed.jobNumber).toBe("JOB0573");
    expect(project(result, 57).proposed.jobNumber).toBe("JOB0573");
    expect(result.projects.map((row) => row.proposed.jobNumber)).not.toContain("JOB0569");
    // The mismatch that suggests a correction is reported, not acted on.
    expect(project(result, 53).warnings).toContain("S. No 569 does not match the digits of job number JOB0573.");
    expect(result.projects.filter((row) => row.disposition === "IMPORTABLE").map((row) => row.source.row)).toEqual([52, 54]);
  });

  it("holds a job with no job number, client, description or status", () => {
    const result = plan({ jobs: [job(5, { jobNumber: null }), job(6, { client: null }), job(7, { description: null }), job(8, { status: null })] });

    expect(result.projects.map(codes)).toEqual([["JOB_NUMBER_MISSING"], ["CLIENT_MISSING"], ["DESCRIPTION_MISSING"], ["STATUS_MISSING"]]);
  });

  it("holds a job whose number is already in the database", () => {
    const result = plan({ jobs: [job(5, { jobNumber: "JOB0001" }), job(6, { jobNumber: "JOB0002" })] }, undefined, database({ jobNumbers: ["JOB0001"] }));

    expect(codes(project(result, 5))).toEqual(["JOB_NUMBER_ALREADY_IN_DATABASE"]);
    expect(project(result, 6).disposition).toBe("IMPORTABLE");
  });

  it("keeps the legacy profit for audit only", () => {
    const row = project(plan({ jobs: [job(5, { amount: "504.000", profit: "50.000" })] }), 5);

    expect(row.proposed.legacyProfit).toBe("50.000");
    // It is not a margin and feeds nothing: the proposal has no margin field at all.
    expect(Object.keys(row.proposed).filter((key) => /margin/i.test(key))).toEqual([]);
    expect(row.disposition).toBe("IMPORTABLE");
  });

  it("holds the jobs of an unapproved alias and of an unconfirmed client, and releases the alias once approved", () => {
    const jobs = [job(5, { client: "DELTAHOUSE" }), job(6, { client: "DELTA HOUSE" }), job(7, { client: "DELTA HOUSE" }), job(8, { client: "GAMMA HOLDINGS" }), job(9, { client: "GAMMA" })];
    const held = plan({ jobs });
    const approved = plan({ jobs }, { approvedClientAliases: [{ alias: "DELTAHOUSE", master: "DELTA HOUSE" }] });

    expect(codes(project(held, 5))).toEqual(["CLIENT_ALIAS_NOT_APPROVED"]);
    expect(project(held, 6).disposition).toBe("IMPORTABLE");
    expect(codes(project(held, 8))).toEqual(["CLIENT_IDENTITY_UNCONFIRMED"]);
    expect(codes(project(held, 9))).toEqual(["CLIENT_IDENTITY_UNCONFIRMED"]);
    expect(project(approved, 5)).toMatchObject({ disposition: "IMPORTABLE", proposed: { clientRaw: "DELTAHOUSE", clientName: "DELTA HOUSE" } });
  });
});

describe("invoice references", () => {
  const jobs = [
    job(5, { invoice: 9001 }),
    job(6, { invoice: "9002, 9003" }),
    job(7, { invoice: "9004 & 9005" }),
    job(8, { invoice: "9006 &9007" }),
    job(9, { invoice: 9010 }),
    job(10, { invoice: 9010 }),
    job(11, { invoice: 9020, client: "ALPHA HOTEL" }),
    job(12, { invoice: 9020, client: "BRAVO TOWER" }),
    job(13, { invoice: null }),
    job(14, { invoice: "DONE" }),
  ];
  const result = plan({ jobs });
  const reference = (row: number) => project(result, row).invoice;

  it("classifies one job with one invoice, several invoices on a job, and a blank cell", () => {
    expect(reference(5)).toMatchObject({ classification: "ONE_JOB_ONE_INVOICE", numbers: ["9001"], rawCell: "9001" });
    expect(reference(6)).toMatchObject({ classification: "JOB_HAS_MULTIPLE_INVOICES", numbers: ["9002", "9003"], rawCell: "9002, 9003" });
    expect(reference(7)?.numbers).toEqual(["9004", "9005"]);
    expect(reference(8)?.numbers).toEqual(["9006", "9007"]);
    expect(reference(13)).toMatchObject({ classification: "NO_INVOICE_REFERENCE", numbers: [], rawCell: null });
  });

  it("flags an invoice shared by jobs, and separately one shared across different clients", () => {
    expect(reference(9)?.classification).toBe("INVOICE_ON_MULTIPLE_JOBS_SAME_CLIENT");
    expect(reference(10)?.classification).toBe("INVOICE_ON_MULTIPLE_JOBS_SAME_CLIENT");
    expect(reference(11)?.classification).toBe("INVOICE_ON_MULTIPLE_JOBS_CROSS_CLIENT");
    expect(reference(12)?.classification).toBe("INVOICE_ON_MULTIPLE_JOBS_CROSS_CLIENT");
    expect(reference(12)?.notes.join(" ")).toContain("different clients");
  });

  it("does not read a word in the invoice cell as an invoice number", () => {
    expect(reference(14)).toEqual({
      rawCell: "DONE",
      numbers: [],
      classification: "NON_NUMERIC_MARKER",
      notes: ['"DONE" is not an invoice number and is not read as one.'],
    });
  });

  it("never holds a job because of its invoice cell, and counts every reference", () => {
    expect(result.projects.every((row) => row.disposition === "IMPORTABLE")).toBe(true);
    expect(result.totals.invoices).toMatchObject({ jobMentions: 11, distinctJobNumbers: 9 });
    expect(result.totals.invoices.jobs).toEqual({
      INVOICE_ON_MULTIPLE_JOBS_CROSS_CLIENT: 2,
      INVOICE_ON_MULTIPLE_JOBS_SAME_CLIENT: 2,
      JOB_HAS_MULTIPLE_INVOICES: 3,
      NON_NUMERIC_MARKER: 1,
      NO_INVOICE_REFERENCE: 1,
      ONE_JOB_ONE_INVOICE: 1,
    });
  });

  it("puts no invoice value into what a project or visit would store", () => {
    const withSchedule = plan({ contracts: [ALPHA], schedule: ALPHA_ROWS, jobs });

    for (const row of [...withSchedule.projects, ...withSchedule.visits]) {
      expect(Object.keys(row.proposed).filter((key) => /invoice/i.test(key))).toEqual([]);
    }
  });

  it("classifies the schedule's invoice cells: a number, a word, and blank", () => {
    const rows = [period("B6", "2026-01-01", "ALPHA HOTEL FIRE Q3", "400.000", 9101), period("B16", "2026-04-01", "ALPHA HOTEL FIRE Q4", "400.000", "DONE"), period("B26", "2026-07-01", "ALPHA HOTEL FIRE Q1", "400.000")];
    const schedule = plan({ contracts: [ALPHA], schedule: rows });

    expect(visit(schedule, "B6").invoice).toMatchObject({ classification: "AMC_PERIOD_ONE_INVOICE", numbers: ["9101"] });
    expect(visit(schedule, "B16").invoice).toMatchObject({ classification: "NON_NUMERIC_MARKER", numbers: [], rawCell: "DONE" });
    expect(visit(schedule, "B26").invoice).toMatchObject({ classification: "NO_INVOICE_REFERENCE", numbers: [] });
    // A word in the invoice cell does not hold the visit and is not turned into a number.
    expect(visit(schedule, "B16").disposition).toBe("IMPORTABLE");
  });
});

describe("AMC contracts", () => {
  it("proposes a quarterly draft with the cutover date, from a schedule of equal amounts every three months", () => {
    const result = plan({ contracts: [ALPHA], schedule: ALPHA_ROWS });

    expect(result.contracts[0]).toMatchObject({
      disposition: "IMPORTABLE",
      proposed: {
        clientName: "ALPHA HOTEL",
        systemDescription: "FIRE",
        validFrom: "2025-07-01",
        validTo: "2026-06-30",
        maintenanceFrequency: "QUARTERLY",
        defaultVisitAmount: "400.000",
        contractValue: "1600.000",
        status: "DRAFT",
        scheduleCutoverDate: "2026-10-01",
        sourceVisitCount: 4,
        historicalVisitCount: 2,
      },
    });
    expect(result.contracts[0]?.proposed.sourceFrequency).toContain("every 3 month(s)");
  });

  it("recognises a half-yearly contract the same way", () => {
    const result = plan({
      contracts: [contract(5, { validFrom: "2026-01-01", validTo: "2026-12-31", amount: "1000.000" })],
      schedule: [period("B6", "2026-01-01", "ALPHA HOTEL FIRE Q1", "500.000"), period("B16", "2026-07-01", "ALPHA HOTEL FIRE Q2", "500.000")],
    });

    expect(result.contracts[0]?.proposed).toMatchObject({ maintenanceFrequency: "HALF_YEARLY", defaultVisitAmount: "500.000" });
  });

  it("holds a contract whose periods carry uneven amounts: its maintenance frequency is not decided here", () => {
    const result = plan({
      contracts: [contract(10, { clientRaw: "OSCAR", system: "Automation", validFrom: "2026-03-01", validTo: "2027-02-28", amount: "12000.000", credit: "10000.000" })],
      schedule: [
        period("N7", "2026-03-01", "OSCAR AUTOMATION Q1", "6000.000", "DONE"),
        period("N17", "2026-06-01", "OSCAR AUTOMATION Q2", "0.000", "DONE"),
        period("N27", "2026-09-01", "OSCAR AUTOMATION Q3", "6000.000"),
        period("N37", "2026-12-01", "OSCAR AUTOMATION Q2", "0.000"),
      ],
    });
    const held = result.contracts[0] as ImportPlan["contracts"][number];

    expect(held.disposition).toBe("HELD");
    expect(codes(held)).toEqual(["MAINTENANCE_FREQUENCY_UNRESOLVED"]);
    expect(held.proposed).toMatchObject({ maintenanceFrequency: null, defaultVisitAmount: null, finalCredit: "10000.000", historicalVisitCount: 0 });
    expect(held.holdReasons[0]?.message).toContain("6000.000 / 0.000 / 6000.000 / 0.000");
    // Its rows wait with it; none becomes a visit, and the zero amounts stay zero.
    expect(result.visits.map(codes)).toEqual([["CONTRACT_HELD"], ["CONTRACT_HELD"], ["CONTRACT_HELD"], ["CONTRACT_HELD"]]);
    expect(result.visits.map((row) => row.proposed.visitAmount)).toEqual(["6000.000", "0.000", "6000.000", "0.000"]);
    // The mislabelled last period is noticed, not corrected.
    expect(visit(result, "N37").warnings.join(" ")).toContain("labels this period Q2; by its position it is period 4");
  });

  it("attaches schedule rows named differently when exactly one contract fits, and proposes the alias without applying it", () => {
    const result = plan({
      contracts: [ALPHA, contract(8, { clientRaw: "BETA TOWER", system: "CCTV", validFrom: "2026-02-01", validTo: "2027-01-31", amount: "3100.000" })],
      schedule: [
        ...ALPHA_ROWS,
        period("H6", "2026-02-01", "BT CCTV Q1", "775.000", 9102),
        period("H16", "2026-05-01", "BT CCTV Q2", "775.000"),
        period("H26", "2026-08-01", "BT CCTV Q3", "775.000"),
        period("H36", "2026-11-01", "BT CCTV Q4", "775.000"),
      ],
      jobs: [job(5, { client: "BT" })],
    });

    expect(visit(result, "H6")).toMatchObject({ disposition: "IMPORTABLE", proposed: { contractSourceRow: 8, clientName: "BETA TOWER", sequenceNo: 1 } });
    expect(visit(result, "H6").warnings.join(" ")).toContain('The schedule names the client "BT"; the contract register names it "BETA TOWER"');
    expect(result.clients.names.find((name) => name.raw === "BT")).toMatchObject({ classification: "PROPOSED_ALIAS", outcome: "HELD_ALIAS_NOT_APPROVED", masterName: "BETA TOWER" });
    // The job under the short name is not attached to the contract's client without approval.
    expect(codes(project(result, 5))).toEqual(["CLIENT_ALIAS_NOT_APPROVED"]);
  });

  it("holds a schedule row whose label or contract cannot be found", () => {
    const result = plan({ contracts: [ALPHA], schedule: [...ALPHA_ROWS, period("N6", "2026-03-01", "SOMETHING ELSE", "10.000"), period("N16", "2026-06-01", "ZULU FIRE Q1", "10.000")] });

    expect(codes(visit(result, "N6"))).toEqual(["SCHEDULE_LABEL_NOT_UNDERSTOOD"]);
    expect(codes(visit(result, "N16"))).toEqual(["NO_MATCHING_CONTRACT"]);
  });

  it("holds a contract with no client, no dates or no value", () => {
    const result = plan({ contracts: [contract(5, { clientRaw: null }), contract(6, { validFrom: null }), contract(7, { amount: null, credit: null })] });

    expect(result.contracts.map(codes)).toEqual([["CLIENT_MISSING"], ["VALIDITY_INVALID"], ["CONTRACT_VALUE_BLANK", "MAINTENANCE_FREQUENCY_UNRESOLVED"]]);
    expect(result.contracts[2]?.proposed.contractValue).toBeNull();
  });
});

describe("historical AMC visits", () => {
  const result = plan({ contracts: [ALPHA], schedule: ALPHA_ROWS });

  it("proposes a HISTORICAL visit for a source row inside the validity and before the cutover", () => {
    expect(visit(result, "B6")).toMatchObject({
      disposition: "IMPORTABLE",
      destination: "amc_visits (status HISTORICAL)",
      proposed: {
        contractSourceRow: 5,
        sequenceNo: 3,
        sourceLabel: "Q3",
        periodStart: "2026-01-01",
        periodEnd: "2026-03-31",
        visitAmount: "400.000",
        status: "HISTORICAL",
        completedDate: null,
        plannedDateInSource: false,
      },
    });
  });

  it("holds the rows after the validity as possible renewals, without extending the contract or creating one", () => {
    const july = visit(result, "B26");

    expect(codes(july)).toEqual(["POSSIBLE_RENEWAL"]);
    expect(codes(visit(result, "B36"))).toEqual(["POSSIBLE_RENEWAL"]);
    expect(july.holdReasons[0]?.message).toContain("1 day(s) after the contract's validity ended on 2026-06-30");
    expect(july.holdReasons[0]?.message).toContain("labelled Q1");
    expect(result.contracts).toHaveLength(1);
    expect(result.contracts[0]?.proposed).toMatchObject({ validFrom: "2025-07-01", validTo: "2026-06-30" });
  });

  it("creates no visit the source does not list: two rows, two visits, for a contract of four periods", () => {
    const proposed = result.visits.filter((row) => row.disposition === "IMPORTABLE");

    // The contract's first two periods (July and October 2025) are not in the source: nothing is made up for them.
    expect(proposed.map((row) => row.proposed.periodStart)).toEqual(["2026-01-01", "2026-04-01"]);
    expect(result.visits).toHaveLength(ALPHA_ROWS.length);
    expect(result.totals.visits).toMatchObject({ source: 4, importable: 2, held: 2, generatedWithoutSource: 0, importableAmount: "800.000", heldAmount: "800.000" });
    expect(proposed.every((row) => ALPHA_ROWS.some((source) => source.ref === row.source))).toBe(true);
    expect(result.checks.find((check) => check.name === "No visit is proposed without a source row")?.passed).toBe(true);
    expect(result.checks.find((check) => check.name === "Proposed historical visits = schedule rows - held rows")?.passed).toBe(true);
  });

  it("does not treat a period that starts on or after the cutover as history", () => {
    const later = contract(8, { clientRaw: "BETA TOWER", system: "CCTV", validFrom: "2026-02-01", validTo: "2027-01-31", amount: "3100.000" });
    const rows = [
      period("H6", "2026-02-01", "BETA TOWER CCTV Q1", "775.000"),
      period("H16", "2026-05-01", "BETA TOWER CCTV Q2", "775.000"),
      period("H26", "2026-08-01", "BETA TOWER CCTV Q3", "775.000"),
      period("H36", "2026-11-01", "BETA TOWER CCTV Q4", "775.000"),
    ];
    const atOctober = plan({ contracts: [later], schedule: rows });
    const atJune = plan({ contracts: [later], schedule: rows }, undefined, database({ asOf: "2026-06-15" }));

    expect(atOctober.visits.map((row) => row.disposition)).toEqual(["IMPORTABLE", "IMPORTABLE", "IMPORTABLE", "HELD"]);
    expect(codes(visit(atOctober, "H36"))).toEqual(["NOT_HISTORY_AT_CUTOVER"]);
    // The period running on the cutover date is history, with a warning that its execution is unknown.
    expect(visit(atOctober, "H26").warnings.join(" ")).toContain("still running on the cutover date 2026-10-01");
    // The cutover is the date of the run, not a fixed date.
    expect(atJune.contracts[0]?.proposed.scheduleCutoverDate).toBe("2026-06-15");
    expect(atJune.visits.map((row) => row.disposition)).toEqual(["IMPORTABLE", "IMPORTABLE", "HELD", "HELD"]);
  });

  it("holds two rows for one period of a contract", () => {
    const twice = plan({ contracts: [ALPHA], schedule: [...ALPHA_ROWS, period("H6", "2026-01-01", "ALPHA HOTEL FIRE Q3", "400.000")] });

    expect(codes(visit(twice, "B6"))).toEqual(["DUPLICATE_PERIOD"]);
    expect(codes(visit(twice, "H6"))).toEqual(["DUPLICATE_PERIOD"]);
  });

  it("keeps an empty amount empty and an entered zero zero", () => {
    const even = contract(5, { amount: "0.000", credit: "0.000" });
    const zeros = plan({ contracts: [even], schedule: [period("B6", "2026-01-01", "ALPHA HOTEL FIRE Q3", "0.000"), period("B16", "2026-04-01", "ALPHA HOTEL FIRE Q4", "0.000")] });

    expect(zeros.visits.map((row) => [row.disposition, row.proposed.visitAmount])).toEqual([["IMPORTABLE", "0.000"], ["IMPORTABLE", "0.000"]]);

    const blank = plan({ contracts: [ALPHA], schedule: [ALPHA_ROWS[0] as (typeof ALPHA_ROWS)[number], period("B16", "2026-04-01", "ALPHA HOTEL FIRE Q4", null)] });

    expect(blank.visits.map((row) => row.proposed.visitAmount)).toEqual(["400.000", null]);
  });
});

describe("the plan as a whole", () => {
  const parts = {
    contracts: [ALPHA],
    schedule: ALPHA_ROWS,
    jobs: [job(5), job(6, { amount: null }), job(7, { amount: "0.000" }), job(8, { client: "ECHO " })],
  };

  it("is deterministic: the same source and database give exactly the same plan", () => {
    expect(JSON.stringify(plan(parts))).toBe(JSON.stringify(plan(parts)));
    expect(plan(parts)).toEqual(plan(parts));
  });

  it("accounts for every source row once, and the money adds up", () => {
    const result = plan(parts);

    expect(result.projects).toHaveLength(4);
    expect(result.totals.projects).toMatchObject({ source: 4, importable: 3, held: 1, sourceValue: "2000.000", importableValue: "2000.000", heldValue: "0.000", importableVat: "100.000", importableGrandValue: "2100.000" });
    expect(result.totals.projects.heldByReason).toEqual({ JOB_VALUE_BLANK: 1 });
    // These fixtures carry no workbook totals, so only the four comparisons with a workbook total cannot pass.
    expect(result.checks.filter((check) => !check.passed).map((check) => check.name)).toEqual([
      "Job values add up to the register's total",
      "Contract values add up to the register's total",
      "Final credits add up to the register's total",
      "Schedule amounts add up to the month totals",
    ]);
  });

  it("stages one client row per name per workbook, and creates no client that nothing importable refers to", () => {
    const result = plan({ jobs: [job(5, { client: "ECHO " }), job(6, { client: "ECHO " }), job(7, { client: "LONE", amount: null })] });

    expect(result.clientRows.map((row) => [row.identifier, row.source.row, row.disposition, codes(row)])).toEqual([
      ["ECHO ", 5, "IMPORTABLE", []],
      ["LONE", 7, "HELD", ["NO_IMPORTABLE_RECORD_YET"]],
    ]);
    expect(result.totals.clients).toMatchObject({ rawNames: 2, masters: 2, proposedNew: 1, deferred: 1, existing: 0, heldMasters: 0 });
  });

  it("matches an existing client instead of proposing a duplicate", () => {
    const result = plan({ jobs: [job(5, { client: "ECHO " })] }, undefined, database({ clients: [{ id: "42", name: "Echo" }] }));

    expect(result.clientRows[0]).toMatchObject({ disposition: "IMPORTABLE", destination: "clients (existing id 42)", proposed: { outcome: "EXISTING_CLIENT", existingClientId: "42" } });
    expect(result.totals.clients).toMatchObject({ existing: 1, proposedNew: 0 });
  });
});

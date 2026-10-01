import { WATCHED_TABLES } from "./database";
import type { DryRunResult } from "./dry-run";
import type { HoldReason, PlanRow } from "./plan";

// RECONCILIATION REPORT: the dry-run result for a person to read. The report
// names clients, jobs and amounts, so it is written only to the ignored
// docs/client-source/ area and is never committed.

const cell = (value: unknown): string =>
  value === null || value === undefined || value === "" ? "—" : String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function table(headers: string[], rows: unknown[][]): string {
  if (rows.length === 0) {
    return "_None._\n";
  }

  return [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`)].join("\n") + "\n";
}

const reasons = (list: HoldReason[]): string => list.map((reason) => `**${reason.code}** — ${reason.message}`).join("<br>");
const where = (row: PlanRow<unknown>): string => `${row.source.sheet} · row ${row.source.row}${row.source.cell ? ` (${row.source.cell})` : ""}`;
const counts = (record: Record<string, number>): unknown[][] => Object.entries(record).map(([key, value]) => [key, value]);

/** The next job number after the highest in the register: a lower bound read from the file, not a decision. */
function lowerBound(jobNumbers: string[]): string | null {
  let best: { prefix: string; digits: string } | null = null;

  for (const number of jobNumbers) {
    const match = /^(.*?)(\d+)$/.exec(number);

    if (match && (best === null || (match[1] === best.prefix && BigInt(match[2] as string) > BigInt(best.digits)))) {
      best = { prefix: match[1] as string, digits: match[2] as string };
    }
  }

  return best === null ? null : `${best.prefix}${(BigInt(best.digits) + 1n).toString().padStart(best.digits.length, "0")}`;
}

export function renderReport(result: DryRunResult): string {
  const { plan, sources, source, database, after } = result;
  const { totals } = plan;
  const heldProjects = plan.projects.filter((row) => row.disposition === "HELD");
  const heldVisits = plan.visits.filter((row) => row.disposition === "HELD");
  const heldContracts = plan.contracts.filter((row) => row.disposition === "HELD");
  const importableVisits = plan.visits.filter((row) => row.disposition === "IMPORTABLE");
  const withCode = (rows: PlanRow<unknown>[], code: string) => rows.filter((row) => row.holdReasons.some((reason) => reason.code === code));
  const sourcesUnchanged = sources.every((file) => after.sources.find((other) => other.role === file.role)?.sha256 === file.sha256);
  const databaseUnchanged = WATCHED_TABLES.every((name) => database.counts[name] === after.database.counts[name]);
  const failed = plan.checks.filter((check) => !check.passed);
  const out: string[] = [];
  const add = (...lines: string[]) => out.push(...lines);

  add(
    "# STSLEV AMC HISTORICAL EXCEL IMPORT DRY-RUN REPORT",
    "",
    "**CONFIDENTIAL — contains client names, job numbers and amounts. Not for the repository.**",
    "",
    "This is a dry run. Nothing was imported. The workbooks were opened for reading and the database was read inside a read-only transaction.",
    "",
    table(
      ["Item", "Value"],
      [
        ["Database read", `${database.database} (schema ${database.schema})`],
        ["Cutover date an import run today would record", plan.asOf],
        ["Checks passed", `${plan.checks.length - failed.length} of ${plan.checks.length}`],
        ["Clients: proposed new / existing / deferred / held", `${totals.clients.proposedNew} / ${totals.clients.existing} / ${totals.clients.deferred} / ${totals.clients.heldMasters}`],
        ["AMC contracts: importable / held", `${totals.contracts.importable} / ${totals.contracts.held}`],
        ["Historical AMC visits: importable / held", `${totals.visits.importable} / ${totals.visits.held}`],
        ["Projects: importable / held", `${totals.projects.importable} / ${totals.projects.held}`],
      ]
    )
  );

  add("## 1. Source files and verified hashes", "");
  add(
    table(
      ["Workbook", "Role", "Bytes", "SHA-256", "Matches the analysed file", "Last modified"],
      sources.map((file) => [file.file, file.role, file.bytes, file.sha256, file.sha256 === file.sha256Expected ? "Yes" : "NO", file.modified])
    )
  );

  add("## 2. Sheets processed", "");
  add(table(["Workbook", "Sheet"], sources.map((file) => [file.file, file.sheet])));

  add("## 3. Source row counts", "");
  add(
    table(
      ["Source", "Rows read", "Total in the workbook", "Sum of the rows"],
      [
        ["Contract register", source.contracts.length, source.totals.contractValue?.value.kind === "VALUE" ? source.totals.contractValue.value.amount : "—", totals.contracts.sourceValue],
        ["Maintenance schedule (period rows)", source.schedule.length, `${source.totals.scheduleBlocks.length} month totals`, totals.visits.sourceAmount],
        ["Job register", source.jobs.length, source.totals.jobValue?.value.kind === "VALUE" ? source.totals.jobValue.value.amount : "—", totals.projects.sourceValue],
      ]
    )
  );
  add(`Year of the job register (from its title): **${source.jobsYear ?? "not found"}**.`, "");
  add("Cells read and deliberately left out:", "", table(["Where", "Why"], plan.ignored.map((item) => [`${item.ref.sheet} ${item.ref.cell}`, item.note])));

  add("## 4. Client normalization summary", "");
  add(
    table(
      ["Measure", "Count"],
      [
        ["Raw client names across the three workbooks", totals.clients.rawNames],
        ["Client records they lead to (masters)", totals.clients.masters],
        ...counts(plan.clients.names.reduce<Record<string, number>>((all, name) => ({ ...all, [name.classification]: (all[name.classification] ?? 0) + 1 }), {})),
      ]
    )
  );
  add("Only outer and repeated spaces are removed, and letter case is ignored when comparing. No name is merged because it looks like another.", "");
  add(
    table(
      ["Raw name", "Normalized", "Jobs", "Contracts", "Schedule", "Proposed master", "Classification", "Outcome", "Reason"],
      plan.clients.names.map((name) => [JSON.stringify(name.raw), name.normalized, name.occurrences.jobs, name.occurrences.contracts, name.occurrences.schedule, name.masterName, name.classification, name.outcome, name.reason])
    )
  );

  add("## 5. Proposed new / existing clients", "");
  add(
    table(
      ["Measure", "Count"],
      [
        ["Already in the database (matched by name)", totals.clients.existing],
        ["Would be created", totals.clients.proposedNew],
        ["Not needed yet: every source row is held", totals.clients.deferred],
      ]
    )
  );
  add(
    "Clients not needed yet:",
    "",
    table(["Client", "Why"], plan.clientRows.filter((row) => row.holdReasons.some((reason) => reason.code === "NO_IMPORTABLE_RECORD_YET")).map((row) => [row.proposed.masterName, reasons(row.holdReasons)]))
  );

  add("## 6. Ambiguous / held clients", "");
  add(
    table(
      ["Raw name", "Proposed master", "Outcome", "Reason"],
      plan.clients.names.filter((name) => name.outcome.startsWith("HELD")).map((name) => [JSON.stringify(name.raw), name.masterName, name.outcome, name.reason])
    )
  );
  add(
    "Look-alike names kept separate (for review; nothing is merged):",
    "",
    table(["Client", "Look-alikes"], plan.clients.masters.filter((master) => plan.clients.names.some((name) => name.masterKey === master.key && name.lookAlikes.length > 0)).map((master) => [master.name, plan.clients.names.find((name) => name.masterKey === master.key)?.lookAlikes.join("; ")]))
  );

  add("## 7. AMC contract summary", "");
  add(
    table(
      ["Row", "Source client", "Client", "System", "Valid from", "Valid to", "Source frequency", "Proposed frequency", "Value", "Final credit", "Default visit amount", "Status", "Cutover", "Source visits", "Historical visits", "Disposition", "Held / warnings"],
      plan.contracts.map((row) => [
        row.source.row,
        JSON.stringify(row.proposed.clientRaw),
        row.proposed.clientName,
        row.proposed.systemDescription,
        row.proposed.validFrom,
        row.proposed.validTo,
        row.proposed.sourceFrequency,
        row.proposed.maintenanceFrequency ?? "UNRESOLVED",
        row.proposed.contractValue,
        row.proposed.finalCredit,
        row.proposed.defaultVisitAmount,
        row.proposed.status,
        row.proposed.scheduleCutoverDate,
        row.proposed.sourceVisitCount,
        row.proposed.historicalVisitCount,
        row.disposition,
        [reasons(row.holdReasons), ...row.warnings].filter(Boolean).join("<br>"),
      ])
    )
  );
  add(
    table(
      ["", "Count", "Value", "Final credit"],
      [
        ["Source", totals.contracts.source, totals.contracts.sourceValue, totals.contracts.sourceFinalCredit],
        ["Importable (as DRAFT)", totals.contracts.importable, totals.contracts.importableValue, totals.contracts.importableFinalCredit],
        ["Held", totals.contracts.held, totals.contracts.heldValue, totals.contracts.heldFinalCredit],
      ]
    )
  );

  add("## 8. Historical AMC visit summary", "");
  add(
    table(
      ["", "Rows", "Amount"],
      [
        ["Source period rows", totals.visits.source, totals.visits.sourceAmount],
        ["Proposed HISTORICAL visits", totals.visits.importable, totals.visits.importableAmount],
        ["Held", totals.visits.held, totals.visits.heldAmount],
        ["Generated without a source row", totals.visits.generatedWithoutSource, "0.000"],
      ]
    )
  );
  add(`**${totals.visits.source} source rows − ${totals.visits.held} held = ${totals.visits.importable} proposed historical visits.**`, "");
  add("Every proposed visit has status HISTORICAL and no completion date. The source gives a period, not a planned day: none is supplied.", "");
  add(
    table(
      ["Source", "Label", "Client", "System", "Contract row", "Period start", "Period end", "Seq.", "Amount", "Invoice cell", "Status", "Completion date", "Disposition", "Held / warnings"],
      plan.visits.map((row) => [
        where(row),
        row.identifier,
        row.proposed.clientName,
        row.proposed.systemDescription,
        row.proposed.contractSourceRow,
        row.proposed.periodStart,
        row.proposed.periodEnd,
        row.proposed.sequenceNo,
        row.proposed.visitAmount,
        row.invoice?.rawCell ?? "(blank)",
        row.proposed.status,
        "none",
        row.disposition,
        [reasons(row.holdReasons), ...row.warnings].filter(Boolean).join("<br>"),
      ])
    )
  );

  add("## 9. Project summary", "");
  add(
    table(
      ["", "Rows", "Job value", "VAT", "Grand value"],
      [
        ["Source", totals.projects.source, totals.projects.sourceValue, "", ""],
        ["Importable (as HISTORICAL)", totals.projects.importable, totals.projects.importableValue, totals.projects.importableVat, totals.projects.importableGrandValue],
        ["Held", totals.projects.held, totals.projects.heldValue, "", ""],
      ]
    )
  );
  add("Every proposed project has status HISTORICAL, the source status kept verbatim, a month-only date and no completion date. VAT and grand value are as PostgreSQL will generate them from the job value and the confirmed 5% rate.", "");
  add(
    table(
      ["Row", "Job number", "Proposed", "Client", "Source date", "Stored date", "Precision", "Source status", "Status", "Job value", "VAT", "Grand value", "Legacy profit (audit)", "Invoice reference", "Disposition", "Held / warnings"],
      plan.projects.map((row) => [
        row.source.row,
        row.identifier,
        row.proposed.jobNumber,
        row.proposed.clientName ?? JSON.stringify(row.proposed.clientRaw),
        row.proposed.sourceJobDate,
        row.proposed.jobDate,
        row.proposed.jobDatePrecision,
        row.proposed.legacyStatus,
        row.proposed.status,
        row.proposed.jobValue ?? "(blank)",
        row.proposed.vatAmount,
        row.proposed.grandValue,
        row.proposed.legacyProfit,
        `${row.invoice?.classification}${row.invoice?.rawCell ? `: ${row.invoice.rawCell}` : ""}`,
        row.disposition,
        [reasons(row.holdReasons), ...row.warnings].filter(Boolean).join("<br>"),
      ])
    )
  );

  add("## 10. Importable project count", "", `**${totals.projects.importable}** projects, job value **${totals.projects.importableValue}**.`, "");
  add("## 11. Held project count", "", `**${totals.projects.held}** projects, job value **${totals.projects.heldValue}**.`, "", table(["Reason", "Rows"], counts(totals.projects.heldByReason)));

  add("## 12. Invoice-reference classifications", "");
  add("Kept in the staging rows only. No invoice record is created and no invoice number is stored on a project or a visit.", "");
  add("Job register:", "", table(["Classification", "Jobs"], counts(totals.invoices.jobs)));
  add(`Invoice numbers mentioned: ${totals.invoices.jobMentions}; distinct: ${totals.invoices.distinctJobNumbers}.`, "");
  add("Maintenance schedule:", "", table(["Classification", "Period rows"], counts(totals.invoices.schedule)));
  add(`Numbers appearing in both workbooks: ${totals.invoices.sharedBetweenJobsAndSchedule}.`, "");
  add(
    "References that are not one job to one invoice:",
    "",
    table(
      ["Source", "Record", "Cell", "Classification", "Notes"],
      [...plan.projects, ...plan.visits]
        .filter((row) => row.invoice && !["NO_INVOICE_REFERENCE", "ONE_JOB_ONE_INVOICE", "AMC_PERIOD_ONE_INVOICE"].includes(row.invoice.classification))
        .map((row) => [where(row), row.identifier, row.invoice?.rawCell, row.invoice?.classification, row.invoice?.notes.join(" ")])
    )
  );

  add("## 13. Explicit zero-value cases", "");
  add(
    "A zero that was typed in the source is kept as 0.000. It is not treated as missing.",
    "",
    table(
      ["Source", "Record", "Client", "Disposition"],
      [
        ...plan.projects.filter((row) => row.proposed.jobValue === "0.000").map((row) => [where(row), row.identifier, row.proposed.clientName, row.disposition]),
        ...plan.visits.filter((row) => row.proposed.visitAmount === "0.000").map((row) => [where(row), row.identifier, row.proposed.clientName, row.disposition]),
      ]
    )
  );

  add("## 14. Missing-value cases", "");
  add(
    "An empty cell stays empty. It is never turned into zero.",
    "",
    table(
      ["Source", "Record", "Missing", "Treatment"],
      [...plan.contracts, ...plan.visits, ...plan.projects]
        .filter((row: PlanRow<unknown>) => row.holdReasons.some((reason) => /BLANK|MISSING/.test(reason.code)))
        .map((row: PlanRow<unknown>) => [where(row), row.identifier, row.holdReasons.filter((reason) => /BLANK|MISSING/.test(reason.code)).map((reason) => reason.code).join(", "), "HELD"])
    )
  );

  add("## 15. Duplicate job-number cases", "");
  add(
    "No job number is changed. Both rows are held and stay traceable by their source rows.",
    "",
    table(["Row", "Job number", "Client", "Job value", "S. No", "Reason"], withCode(plan.projects, "DUPLICATE_JOB_NUMBER").map((row) => [row.source.row, row.identifier, (row as PlanRow<{ clientName: string | null }>).proposed.clientName, (row as PlanRow<{ jobValue: string | null }>).proposed.jobValue, row.raw["S. No"], reasons(row.holdReasons)]))
  );

  add("## 16. Month-precision cases", "");
  add(
    `All **${plan.projects.filter((row) => row.proposed.jobDate !== null).length}** dated projects are month-only: the register gives a month name and the year of its title, never a day. ` +
      "The stored date is the first of that month with `job_date_precision = MONTH`, which marks the day as unknown.",
    "",
    table(["Stored date", "Projects"], counts(plan.projects.reduce<Record<string, number>>((all, row) => ({ ...all, [row.proposed.jobDate ?? "(not datable)"]: (all[row.proposed.jobDate ?? "(not datable)"] ?? 0) + 1 }), {})).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
  );

  add("## 17. Possible-renewal cases", "");
  add(
    "Rows of the schedule that start after their contract's validity ended. They are held. No contract date is extended and no renewal contract is created.",
    "",
    table(["Source", "Label", "Period start", "Amount", "Invoice cell", "Reason"], withCode(plan.visits, "POSSIBLE_RENEWAL").map((row) => [where(row), row.identifier, (row as PlanRow<{ periodStart: string | null }>).proposed.periodStart, (row as PlanRow<{ visitAmount: string | null }>).proposed.visitAmount, row.invoice?.rawCell ?? "(blank)", reasons(row.holdReasons)]))
  );

  const bound = lowerBound(plan.projects.map((row) => row.proposed.jobNumber).filter((number): number is string => number !== null));
  const unresolved: string[] = [];

  for (const name of plan.clients.names.filter((item) => item.outcome === "HELD_IDENTITY_UNCONFIRMED")) {
    unresolved.push(`Client identity — ${JSON.stringify(name.raw)}: ${name.reason}.`);
  }
  for (const name of plan.clients.names.filter((item) => item.outcome === "HELD_ALIAS_NOT_APPROVED")) {
    unresolved.push(`Client alias awaiting approval — ${JSON.stringify(name.raw)} → "${name.masterName}" (${name.reason}).`);
  }
  for (const row of withCode(plan.contracts, "MAINTENANCE_FREQUENCY_UNRESOLVED")) {
    unresolved.push(`Maintenance frequency — ${row.identifier}: ${row.holdReasons.find((reason) => reason.code === "MAINTENANCE_FREQUENCY_UNRESOLVED")?.message}`);
  }
  if (withCode(plan.visits, "POSSIBLE_RENEWAL").length > 0) {
    unresolved.push(`Renewals — ${withCode(plan.visits, "POSSIBLE_RENEWAL").length} schedule rows start after their contract's validity ended. Were those contracts renewed, and on what dates and value?`);
  }
  for (const number of [...new Set(withCode(plan.projects, "DUPLICATE_JOB_NUMBER").map((row) => row.identifier))]) {
    unresolved.push(`Duplicate job number — ${number} is on rows ${withCode(plan.projects, "DUPLICATE_JOB_NUMBER").filter((row) => row.identifier === number).map((row) => row.source.row).join(" and ")}. Which row keeps it, and what is the other row's number?`);
  }
  for (const row of withCode(plan.projects, "JOB_VALUE_BLANK")) {
    unresolved.push(`Job value — ${row.identifier} (row ${row.source.row}) has no job value.`);
  }
  if (plan.contracts.some((row) => row.proposed.finalCredit !== null && row.proposed.finalCredit !== row.proposed.contractValue)) {
    unresolved.push("Final credit — it differs from the contract value on at least one contract. Its meaning is unconfirmed; it is stored as written and used in no calculation.");
  }
  if ([...plan.projects, ...plan.visits].some((row) => row.invoice?.classification === "NON_NUMERIC_MARKER")) {
    unresolved.push("Invoice markers — some invoice cells hold a word instead of a number. What it means, and the real invoice numbers, are for the client to say.");
  }
  if (plan.projects.some((row) => row.invoice?.classification === "INVOICE_ON_MULTIPLE_JOBS_CROSS_CLIENT")) {
    unresolved.push("Cross-client invoices — some invoice numbers are on jobs of different clients. Is that correct?");
  }
  unresolved.push(
    `Job-number sequence — the highest number in the register gives ${bound ?? "no"} as a lower bound only. The register covers one year and the real next number is for the client to say. ` +
      "The live sequence is not read from this file and is not changed."
  );
  if (plan.visits.some((row) => row.warnings.some((warning) => warning.includes("still running")))) {
    unresolved.push("Periods still running on the cutover date are proposed as history. If a visit of such a period is still outstanding, it will not appear as due.");
  }

  add("## 18. All unresolved decisions", "", ...unresolved.map((item, index) => `${index + 1}. ${item}`), "");

  add("## 19. Exact reasons for every held row / category", "");
  add("Projects:", "", table(["Row", "Job number", "Job value", "Reasons"], heldProjects.map((row) => [row.source.row, row.identifier, row.proposed.jobValue ?? "(blank)", reasons(row.holdReasons)])));
  add("AMC contracts:", "", table(["Row", "Contract", "Value", "Reasons"], heldContracts.map((row) => [row.source.row, row.identifier, row.proposed.contractValue, reasons(row.holdReasons)])));
  add("Schedule rows:", "", table(["Source", "Label", "Amount", "Reasons"], heldVisits.map((row) => [where(row), row.identifier, row.proposed.visitAmount, reasons(row.holdReasons)])));
  add("Held schedule rows by reason:", "", table(["Reason", "Rows"], counts(totals.visits.heldByReason)));
  add("Client names:", "", table(["Source", "Name", "Reasons"], plan.clientRows.filter((row) => row.disposition === "HELD").map((row) => [where(row), JSON.stringify(row.identifier), reasons(row.holdReasons)])));

  add("## 20. No historical AMC visits were manufactured", "");
  add(
    `Confirmed. ${importableVisits.length} historical visits are proposed and each comes from exactly one source row of the schedule. ` +
      `Visits generated for a period the source does not list: **${totals.visits.generatedWithoutSource}**. ` +
      "Periods before the cutover date that the source does not list are not created, now or when a contract is activated.",
    ""
  );

  add("## 21. No operational invoice records were created", "", "Confirmed. The import has no invoice table to write to and creates no invoice record. Invoice cells are kept verbatim in the staging rows.", "");

  add("## 22. No Excel business data was imported", "");
  add(
    `${databaseUnchanged ? "Confirmed" : "**NOT CONFIRMED**"}. Row counts of ${database.database} before and after the dry run:`,
    "",
    table(["Table", "Before", "After", "Unchanged"], WATCHED_TABLES.map((name) => [name, database.counts[name], after.database.counts[name], database.counts[name] === after.database.counts[name] ? "Yes" : "NO"]))
  );

  add("## 23. Source workbooks unchanged", "");
  add(
    `${sourcesUnchanged ? "Confirmed" : "**NOT CONFIRMED**"}. SHA-256 before and after the dry run:`,
    "",
    table(["Workbook", "Before", "After", "Unchanged"], sources.map((file) => [file.file, file.sha256, after.sources.find((other) => other.role === file.role)?.sha256, after.sources.find((other) => other.role === file.role)?.sha256 === file.sha256 ? "Yes" : "NO"]))
  );

  add("## Checks", "", table(["Check", "Result", "Detail"], plan.checks.map((check) => [check.name, check.passed ? "Passed" : "FAILED", check.detail])));

  return out.join("\n");
}

/** The whole dry-run result as data, for tools. Deterministic: the same inputs give the same text. */
export function renderJson(result: DryRunResult): string {
  return JSON.stringify(
    {
      dryRun: true,
      asOf: result.plan.asOf,
      database: { name: result.database.database, schema: result.database.schema, countsBefore: result.database.counts, countsAfter: result.after.database.counts },
      sources: result.sources,
      totals: result.plan.totals,
      checks: result.plan.checks,
      clients: result.plan.clients,
      clientRows: result.plan.clientRows,
      contracts: result.plan.contracts,
      visits: result.plan.visits,
      projects: result.plan.projects,
      ignored: result.plan.ignored,
      staging: result.staging,
    },
    null,
    2
  );
}

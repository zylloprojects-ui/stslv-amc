import { FREQUENCY_MONTHS, type MaintenanceFrequency } from "../modules/amc/amc.constants";
import { buildSchedulePeriods, type SchedulePeriod } from "../modules/amc/amc.schedule";
import { nameKey, normalizeName, planClients, type ApprovedAlias, type ClientName, type ClientPlan, type ContractEvidence } from "./clients";
import { addAmounts, equalsProduct, toThousandths, vatAmount, type Money } from "./money";
import type { ContractSource, InvoiceCell, JobSource, RawValues, ScheduleSource, SourceData, SourceRef, SourceTotal } from "./source";

// VALIDATE and CLASSIFY: decides, for every source row, what the import would
// create and what must be held, and why. It is a pure function of the source
// records, a snapshot of the database and the approved decisions: it reads no
// file, opens no connection and writes nothing.
//
// Three rules are never bent:
//   * a value the source does not give is not supplied here;
//   * a source value is never corrected, only held when it cannot be used;
//   * a maintenance visit is proposed only for a row the source lists.

export type Disposition = "IMPORTABLE" | "HELD";
export type RecordKind = "CLIENT" | "AMC_CONTRACT" | "AMC_VISIT" | "PROJECT";

export interface HoldReason {
  code: string;
  message: string;
}

export type InvoiceClassification =
  | "NO_INVOICE_REFERENCE"
  | "ONE_JOB_ONE_INVOICE"
  | "JOB_HAS_MULTIPLE_INVOICES"
  | "INVOICE_ON_MULTIPLE_JOBS_SAME_CLIENT"
  | "INVOICE_ON_MULTIPLE_JOBS_CROSS_CLIENT"
  | "JOB_HAS_MULTIPLE_INVOICES_AND_SHARED"
  | "AMC_PERIOD_ONE_INVOICE"
  | "NON_NUMERIC_MARKER";

/** A source invoice cell, kept for the Invoice Tracking module. Never an invoice record. */
export interface InvoiceReference {
  rawCell: string | null;
  /** The invoice numbers found in the cell. Empty for a blank cell or a marker that is not a number. */
  numbers: string[];
  classification: InvoiceClassification;
  notes: string[];
}

export interface PlanRow<Proposed> {
  source: SourceRef;
  kind: RecordKind;
  /** What identifies the record in the source. */
  identifier: string;
  raw: RawValues;
  /** The values the import would store. Present for held rows too, as far as they can be worked out. */
  proposed: Proposed;
  destination: string;
  disposition: Disposition;
  holdReasons: HoldReason[];
  warnings: string[];
  invoice: InvoiceReference | null;
}

export interface ClientProposal {
  rawName: string;
  normalizedName: string;
  masterName: string;
  classification: ClientName["classification"];
  outcome: ClientName["outcome"];
  existingClientId: string | null;
}

export interface ContractProposal {
  clientRaw: string | null;
  clientName: string | null;
  systemDescription: string | null;
  responsibleEngineer: string | null;
  validFrom: string | null;
  validTo: string | null;
  contractValue: string | null;
  finalCredit: string | null;
  /** What the source says about frequency, in words. The contract register has no frequency column. */
  sourceFrequency: string;
  maintenanceFrequency: MaintenanceFrequency | null;
  defaultVisitAmount: string | null;
  status: "DRAFT";
  /** The date the import would record as the boundary between history and operational scheduling. */
  scheduleCutoverDate: string;
  sourceVisitCount: number;
  historicalVisitCount: number;
}

export interface VisitProposal {
  /** Source row of the contract in the contract register, when the row could be attached to one. */
  contractSourceRow: number | null;
  clientName: string | null;
  systemDescription: string | null;
  sequenceNo: number | null;
  /** The period label written in the source, for example "Q3". */
  sourceLabel: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  visitAmount: string | null;
  status: "HISTORICAL";
  /** Never supplied: the source records no completion. */
  completedDate: null;
  /**
   * The source gives a period, not a planned day. The scheduled-date column
   * is mandatory, so it would hold the period start; it is not a planned date
   * and the application does not show it as one.
   */
  plannedDateInSource: false;
}

export interface ProjectProposal {
  jobNumber: string | null;
  clientRaw: string | null;
  clientName: string | null;
  description: string | null;
  /** Month and year as the source gives them, for example "FEB 2025". */
  sourceJobDate: string | null;
  jobDate: string | null;
  jobDatePrecision: "MONTH";
  status: "HISTORICAL";
  legacyStatus: string | null;
  jobValue: string | null;
  vatRate: string | null;
  vatAmount: string | null;
  grandValue: string | null;
  /** Never supplied: the source records no completion date. */
  completedDate: null;
  /** The source PROFIT figure. Audit only: it is not, and does not feed, the operational job margin. */
  legacyProfit: string | null;
}

export interface PlanCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface DatabaseState {
  /** The database's current date: the cutover date an import run today would record. */
  asOf: string;
  clients: { id: string; name: string }[];
  jobNumbers: string[];
}

export interface PlanOptions {
  approvedClientAliases: ApprovedAlias[];
}

export interface ImportPlan {
  asOf: string;
  clients: ClientPlan;
  clientRows: PlanRow<ClientProposal>[];
  contracts: PlanRow<ContractProposal>[];
  visits: PlanRow<VisitProposal>[];
  projects: PlanRow<ProjectProposal>[];
  ignored: SourceData["ignored"];
  totals: PlanTotals;
  checks: PlanCheck[];
}

export interface PlanTotals {
  clients: { rawNames: number; masters: number; existing: number; proposedNew: number; deferred: number; heldMasters: number; heldAliases: number };
  contracts: { source: number; importable: number; held: number; sourceValue: string; importableValue: string; heldValue: string; sourceFinalCredit: string; importableFinalCredit: string; heldFinalCredit: string };
  visits: { source: number; importable: number; held: number; generatedWithoutSource: 0; sourceAmount: string; importableAmount: string; heldAmount: string; heldByReason: Record<string, number> };
  projects: { source: number; importable: number; held: number; sourceValue: string; importableValue: string; heldValue: string; importableVat: string; importableGrandValue: string; heldByReason: Record<string, number> };
  invoices: { jobs: Record<string, number>; schedule: Record<string, number>; jobMentions: number; distinctJobNumbers: number; scheduleNumbers: number; sharedBetweenJobsAndSchedule: number };
}

const hold = (code: string, message: string): HoldReason => ({ code, message });
const amountOf = (money: Money): string | null => (money.kind === "VALUE" ? money.amount : null);

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTH_NAMES = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];

/** The month a text names (1-12): a full month name or its first three or more letters. Null otherwise. */
export function monthNumber(text: string): number | null {
  const name = text.trim().toUpperCase();

  if (name.length < 3) {
    return null;
  }

  const matches = MONTH_NAMES.map((month, index) => (month.startsWith(name) ? index + 1 : 0)).filter((month) => month > 0);

  return matches.length === 1 ? (matches[0] as number) : null;
}

const monthIndex = (date: string): number => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
const gcd = (a: number, b: number): number => (b === 0 ? Math.abs(a) : gcd(b, a % b));

const FREQUENCY_BY_MONTHS = new Map<number, MaintenanceFrequency>(
  (Object.entries(FREQUENCY_MONTHS) as [MaintenanceFrequency, number][]).map(([frequency, months]) => [months, frequency])
);

// ---------------------------------------------------------------------------
// Invoice cells
// ---------------------------------------------------------------------------

/** The numbers in an invoice cell. A cell holding anything that is not a number is a marker, not a reference. */
function invoiceNumbers(cell: InvoiceCell): { numbers: string[]; marker: boolean } {
  if (cell.kind === "BLANK") {
    return { numbers: [], marker: false };
  }
  if (cell.kind === "NUMBER") {
    return /^\d+$/.test(cell.raw) ? { numbers: [cell.raw], marker: false } : { numbers: [], marker: true };
  }

  const tokens = cell.raw.split(/[\s,;&/+]+/).filter((token) => token !== "");

  return tokens.length > 0 && tokens.every((token) => /^\d+$/.test(token)) ? { numbers: tokens, marker: false } : { numbers: [], marker: true };
}

// ---------------------------------------------------------------------------
// Contracts and their schedule rows
// ---------------------------------------------------------------------------

interface ScheduleLabel {
  clientPart: string;
  system: string;
  period: string;
}

interface ContractWork {
  source: ContractSource;
  rows: ScheduleSource[];
  frequency: MaintenanceFrequency | null;
  defaultVisitAmount: string | null;
  sourceFrequency: string;
  frequencyProblem: string | null;
  grid: SchedulePeriod[];
}

/** Splits "CLIENT SYSTEM Q3" using the systems of the contract register. */
function parseLabel(label: string, systems: string[]): ScheduleLabel | null {
  for (const system of [...systems].sort((a, b) => b.length - a.length)) {
    const pattern = new RegExp(`^(.+?)\\s+(${system.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\s+(Q\\d+)\\s*$`, "i");
    const match = pattern.exec(label);

    if (match) {
      return { clientPart: match[1] as string, system, period: (match[3] as string).toUpperCase() };
    }
  }

  return null;
}

/** True when the contract has everything a schedule row can be attached to. */
const usable = (contract: ContractSource): contract is ContractSource & { validFrom: string; validTo: string; system: string; clientRaw: string } =>
  contract.validFrom !== null && contract.validTo !== null && contract.validTo >= contract.validFrom && contract.system !== null && contract.clientRaw !== null;

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export function buildPlan(source: SourceData, database: DatabaseState, options: PlanOptions): ImportPlan {
  const asOf = database.asOf;

  // --- attach schedule rows to contracts ------------------------------------
  const systems = [...new Set(source.contracts.map((contract) => contract.system?.trim().toUpperCase()).filter((system): system is string => !!system))];
  const labels = new Map<ScheduleSource, ScheduleLabel | null>(source.schedule.map((row) => [row, parseLabel(row.label, systems)]));
  const groups = new Map<string, ScheduleSource[]>();

  for (const row of source.schedule) {
    const label = labels.get(row);

    if (label) {
      const key = `${nameKey(label.clientPart)}|${label.system}`;

      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
  }

  const attached = new Map<ScheduleSource, ContractSource>();
  const attachedByReconciliation = new Set<ScheduleSource>();
  const evidence: ContractEvidence[] = [];
  const claimed = new Set<ContractSource>();
  const sameSystem = (contract: ContractSource, system: string) => contract.system?.trim().toUpperCase() === system;

  // First by name: the schedule names the client exactly as the contract register does.
  for (const [key, rows] of groups) {
    const [clientKey, system] = key.split("|") as [string, string];
    const byName = source.contracts.filter((contract) => usable(contract) && sameSystem(contract, system) && nameKey(contract.clientRaw as string) === clientKey);

    if (byName.length === 1) {
      rows.forEach((row) => attached.set(row, byName[0] as ContractSource));
      claimed.add(byName[0] as ContractSource);
    }
  }

  // Then by reconciliation: exactly one unclaimed contract of that system whose
  // period grid the rows sit on and whose value the row amounts add up to.
  for (const [key, rows] of groups) {
    if (rows.some((row) => attached.has(row))) {
      continue;
    }

    const system = key.split("|")[1] as string;
    const amounts = rows.map((row) => amountOf(row.value));
    const months = rows.map((row) => row.month);

    if (amounts.some((amount) => amount === null) || months.some((month) => month === null)) {
      continue;
    }

    const total = addAmounts(amounts as string[]);
    const candidates = source.contracts.filter((contract) => {
      if (!usable(contract) || claimed.has(contract) || !sameSystem(contract, system) || amountOf(contract.value) !== total) {
        return false;
      }

      const offsets = (months as string[]).map((month) => monthIndex(month) - monthIndex(contract.validFrom));
      const interval = offsets.reduce((found, offset) => gcd(found, offset), 0);

      return FREQUENCY_BY_MONTHS.has(interval) && (months as string[]).every((month) => month.slice(8) === contract.validFrom.slice(8));
    });

    if (candidates.length === 1) {
      const contract = candidates[0] as ContractSource;
      const clientPart = (labels.get(rows[0] as ScheduleSource) as ScheduleLabel).clientPart;

      rows.forEach((row) => {
        attached.set(row, contract);
        attachedByReconciliation.add(row);
      });
      claimed.add(contract);
      evidence.push({
        aliasRaw: clientPart,
        masterRaw: contract.clientRaw as string,
        evidence:
          `the ${rows.length} schedule rows "${normalizeName(clientPart)} ${system}" reconcile to exactly one contract ` +
          `(${normalizeName(contract.clientRaw as string)} / ${contract.system}, register row ${contract.ref.row}): same system, ` +
          `on a period grid counted from its start date ${contract.validFrom}, and their amounts add up to its value ${total}`,
      });
    }
  }

  // --- clients ---------------------------------------------------------------
  const clients = planClients(
    [
      ...source.contracts.filter((contract) => contract.clientRaw !== null).map((contract) => ({ raw: contract.clientRaw as string, source: "contracts" as const })),
      ...source.schedule.filter((row) => labels.get(row)).map((row) => ({ raw: (labels.get(row) as ScheduleLabel).clientPart, source: "schedule" as const })),
      ...source.jobs.filter((job) => job.clientRaw !== null).map((job) => ({ raw: job.clientRaw as string, source: "jobs" as const })),
    ],
    source.contracts.filter((contract) => contract.clientRaw !== null).map((contract) => contract.clientRaw as string),
    evidence,
    options.approvedClientAliases,
    database.clients
  );
  const clientOf = (raw: string | null): ClientName | null => (raw === null ? null : (clients.names.find((name) => name.raw === raw) ?? null));

  /** Why a row cannot use its client yet, or null when it can. */
  const clientHold = (name: ClientName | null): HoldReason | null => {
    if (name === null) {
      return hold("CLIENT_MISSING", "The client cell is empty.");
    }
    if (name.outcome === "HELD_IDENTITY_UNCONFIRMED") {
      return hold("CLIENT_IDENTITY_UNCONFIRMED", `Client "${name.normalized}": ${name.reason}.`);
    }
    if (name.outcome === "HELD_ALIAS_NOT_APPROVED") {
      return hold("CLIENT_ALIAS_NOT_APPROVED", `Client "${name.normalized}" is a likely alias of "${name.masterName}" that has not been approved (${name.reason}).`);
    }

    return null;
  };

  // --- contracts ---------------------------------------------------------------
  const work = new Map<ContractSource, ContractWork>();

  for (const contract of source.contracts) {
    const rows = source.schedule.filter((row) => attached.get(row) === contract);
    const item: ContractWork = {
      source: contract,
      rows,
      frequency: null,
      defaultVisitAmount: null,
      sourceFrequency: "Not stated: the contract register has no frequency column.",
      frequencyProblem: null,
      grid: [],
    };

    work.set(contract, item);

    if (!usable(contract)) {
      continue;
    }
    if (rows.length < 2 || rows.some((row) => row.month === null)) {
      item.frequencyProblem = "The schedule has too few dated rows for this contract to show how often it is maintained.";
      continue;
    }

    const offsets = rows.map((row) => monthIndex(row.month as string) - monthIndex(contract.validFrom));
    const interval = offsets.reduce((found, offset) => gcd(found, offset), 0);
    const frequency = FREQUENCY_BY_MONTHS.get(interval) ?? null;
    const amounts = rows.map((row) => amountOf(row.value));

    item.sourceFrequency = `Not stated in the contract register. The schedule lists this contract every ${interval} month(s), with amounts ${amounts.map((amount) => amount ?? "(blank)").join(" / ")}.`;

    if (frequency === null) {
      item.frequencyProblem = `The schedule rows are ${interval} month(s) apart, which is not a frequency the system has.`;
      continue;
    }

    const grid = buildSchedulePeriods(contract.validFrom, contract.validTo, frequency);
    const uniform = amounts.every((amount) => amount !== null && amount === amounts[0]);
    const value = amountOf(contract.value);

    item.grid = grid;

    if (!uniform) {
      item.frequencyProblem =
        `The schedule lists this contract every ${interval} month(s) but with uneven amounts (${amounts.map((amount) => amount ?? "(blank)").join(" / ")}). ` +
        "The workbooks do not show whether maintenance follows the listed periods or the periods that carry an amount.";
    } else if (value === null || toThousandths(amounts[0] as string) * BigInt(grid.length) !== toThousandths(value)) {
      item.frequencyProblem = `The period amount ${amounts[0]} times ${grid.length} periods does not equal the contract value ${value ?? "(blank)"}.`;
    } else {
      item.frequency = frequency;
      item.defaultVisitAmount = amounts[0] as string;
    }
  }

  const contractHolds = new Map<ContractSource, HoldReason[]>();

  for (const contract of source.contracts) {
    const reasons: HoldReason[] = [];
    const item = work.get(contract) as ContractWork;
    const client = clientHold(clientOf(contract.clientRaw));

    if (client) reasons.push(client);
    if (contract.system === null) reasons.push(hold("SYSTEM_MISSING", "The system / description cell is empty."));
    if (contract.validFrom === null || contract.validTo === null) {
      reasons.push(hold("VALIDITY_INVALID", "The validity dates are missing or are not dates."));
    } else if (contract.validTo < contract.validFrom) {
      reasons.push(hold("VALIDITY_INVALID", "The validity ends before it starts."));
    }
    if (contract.value.kind === "BLANK") reasons.push(hold("CONTRACT_VALUE_BLANK", "The contract value is empty. It is not treated as zero."));
    if (contract.value.kind === "INVALID") reasons.push(hold("CONTRACT_VALUE_INVALID", `The contract value "${contract.value.raw}" is ${contract.value.reason}.`));
    if (contract.finalCredit.kind === "INVALID") reasons.push(hold("FINAL_CREDIT_INVALID", `The final credit "${contract.finalCredit.raw}" is ${contract.finalCredit.reason}.`));
    if (usable(contract) && item.frequency === null) {
      reasons.push(hold("MAINTENANCE_FREQUENCY_UNRESOLVED", item.frequencyProblem ?? "The maintenance frequency cannot be established from the source."));
    }

    contractHolds.set(contract, reasons);
  }

  // --- schedule rows -> historical visits ---------------------------------------
  const visits: PlanRow<VisitProposal>[] = source.schedule.map((row) => {
    const label = labels.get(row) ?? null;
    const contract = attached.get(row) ?? null;
    const item = contract ? (work.get(contract) as ContractWork) : null;
    const reasons: HoldReason[] = [];
    const warnings: string[] = [];
    const period = item && row.month !== null ? (item.grid.find((candidate) => candidate.periodStart === row.month) ?? null) : null;
    const sequenceNo = period && item ? item.grid.indexOf(period) + 1 : null;
    const { numbers, marker } = invoiceNumbers(row.invoice);

    if (label === null) {
      reasons.push(hold("SCHEDULE_LABEL_NOT_UNDERSTOOD", `The row label "${row.label}" does not name a system of the contract register and a period.`));
    } else if (contract === null) {
      reasons.push(hold("NO_MATCHING_CONTRACT", `No single contract in the register corresponds to "${normalizeName(label.clientPart)} ${label.system}".`));
    }
    if (row.month === null) {
      reasons.push(hold("PERIOD_MISSING", "The month block this row sits in has no date."));
    }
    if (row.value.kind === "INVALID") {
      reasons.push(hold("VISIT_AMOUNT_INVALID", `The value "${row.value.raw}" is ${row.value.reason}.`));
    }

    if (contract && usable(contract) && row.month !== null) {
      if (row.month > contract.validTo) {
        const sameAmount = item?.rows.filter((other) => (other.month as string) <= contract.validTo).some((other) => amountOf(other.value) === amountOf(row.value)) ?? false;

        reasons.push(
          hold(
            "POSSIBLE_RENEWAL",
            `The period starts ${daysBetween(contract.validTo, row.month)} day(s) after the contract's validity ended on ${contract.validTo}. ` +
              `It is labelled ${label?.period ?? "?"}${sameAmount ? ", with the same amount as the periods inside the validity" : ""}, which suggests a renewed term, ` +
              "but the contract register holds no renewal. No contract date is extended and no renewal is created."
          )
        );
      } else if (row.month < contract.validFrom) {
        reasons.push(hold("BEFORE_CONTRACT_START", `The period starts before the contract's validity began on ${contract.validFrom}.`));
      } else {
        const blocked = contractHolds.get(contract) as HoldReason[];

        if (blocked.length > 0) {
          reasons.push(hold("CONTRACT_HELD", `Its contract (register row ${contract.ref.row}) is held: ${blocked.map((reason) => reason.code).join(", ")}.`));
        } else if (period === null) {
          reasons.push(hold("OFF_PERIOD_GRID", `The month ${row.month} is not the start of one of the contract's ${item?.frequency?.toLowerCase()} periods.`));
        } else if (row.month >= asOf) {
          reasons.push(
            hold(
              "NOT_HISTORY_AT_CUTOVER",
              `The period starts on or after the cutover date ${asOf}. It is not history: the operational schedule generates it when the contract is activated.`
            )
          );
        }
      }
    }

    // A row attached by reconciliation names its client differently from the
    // contract register. Until that alias is approved the mapping is a
    // proposal, so the row is held exactly as the jobs under that name are.
    if (contract && label && attachedByReconciliation.has(row)) {
      const alias = clientHold(clientOf(label.clientPart));

      if (alias?.code === "CLIENT_ALIAS_NOT_APPROVED") {
        reasons.push(alias);
      }
    }

    if (contract && label && attachedByReconciliation.has(row)) {
      warnings.push(
        `The schedule names the client "${normalizeName(label.clientPart)}"; the contract register names it "${normalizeName(contract.clientRaw ?? "")}". ` +
          "The row is attached to that contract because its system, period grid and amounts match it and no other."
      );
    }
    if (period && label && sequenceNo !== null && label.period !== `Q${sequenceNo}`) {
      warnings.push(`The source labels this period ${label.period}; by its position it is period ${sequenceNo} of the contract. The label is kept in the raw values and is not used.`);
    }
    if (reasons.length === 0 && period && period.periodEnd >= asOf) {
      warnings.push(`The period (${period.periodStart} to ${period.periodEnd}) is still running on the cutover date ${asOf}. Whether the visit has taken place is not recorded: as history it will not appear as due.`);
    }
    if (row.value.kind === "BLANK") {
      warnings.push("The value is empty: the visit would carry no amount. It is not treated as zero.");
    }
    if (row.value.kind === "VALUE" && row.value.isZero) {
      warnings.push("The value is an explicit zero and is kept as 0.000.");
    }

    return {
      source: row.ref,
      kind: "AMC_VISIT",
      identifier: normalizeName(row.label),
      raw: row.raw,
      proposed: {
        contractSourceRow: contract?.ref.row ?? null,
        clientName: contract ? (clientOf(contract.clientRaw)?.masterName ?? null) : null,
        systemDescription: contract?.system ?? label?.system ?? null,
        sequenceNo,
        sourceLabel: label?.period ?? null,
        periodStart: row.month,
        periodEnd: period?.periodEnd ?? null,
        visitAmount: amountOf(row.value),
        status: "HISTORICAL",
        completedDate: null,
        plannedDateInSource: false,
      },
      destination: "amc_visits (status HISTORICAL)",
      disposition: reasons.length === 0 ? "IMPORTABLE" : "HELD",
      holdReasons: reasons,
      warnings,
      invoice: {
        rawCell: row.invoice.kind === "BLANK" ? null : row.invoice.raw,
        numbers,
        classification: row.invoice.kind === "BLANK" ? "NO_INVOICE_REFERENCE" : marker ? "NON_NUMERIC_MARKER" : "AMC_PERIOD_ONE_INVOICE",
        notes: marker ? [`"${row.invoice.kind === "BLANK" ? "" : row.invoice.raw}" is not an invoice number. Its meaning is unconfirmed and it is not read as one.`] : [],
      },
    };
  });

  // Two rows for one period of one contract cannot both be a visit.
  for (const visit of visits) {
    const twins = visits.filter(
      (other) => other !== visit && other.proposed.contractSourceRow !== null && other.proposed.contractSourceRow === visit.proposed.contractSourceRow && other.proposed.periodStart === visit.proposed.periodStart
    );

    if (twins.length > 0) {
      visit.holdReasons.push(hold("DUPLICATE_PERIOD", `The schedule lists this period of the contract more than once (also at ${twins.map((twin) => twin.source.cell).join(", ")}).`));
      visit.disposition = "HELD";
    }
  }

  const contracts: PlanRow<ContractProposal>[] = source.contracts.map((contract) => {
    const item = work.get(contract) as ContractWork;
    const reasons = contractHolds.get(contract) as HoldReason[];
    const own = visits.filter((visit) => visit.proposed.contractSourceRow === contract.ref.row);
    const warnings: string[] = [];

    if (contract.validTo !== null && contract.validTo < asOf) {
      warnings.push(`The validity ended on ${contract.validTo}, before the cutover date. No status other than DRAFT is proposed: whether the contract was renewed is not in the register.`);
    }
    if (own.some((visit) => visit.holdReasons.some((reason) => reason.code === "POSSIBLE_RENEWAL"))) {
      warnings.push("The schedule continues after the validity ended (possible renewal). Those rows are held.");
    }
    if (amountOf(contract.finalCredit) !== null && amountOf(contract.finalCredit) !== amountOf(contract.value)) {
      warnings.push("Final credit differs from the contract value. It is stored as written and used in no calculation: its meaning is unconfirmed.");
    }

    return {
      source: contract.ref,
      kind: "AMC_CONTRACT",
      identifier: `${normalizeName(contract.clientRaw ?? "(no client)")} / ${contract.system ?? "(no system)"}`,
      raw: contract.raw,
      proposed: {
        clientRaw: contract.clientRaw,
        clientName: clientOf(contract.clientRaw)?.masterName ?? null,
        systemDescription: contract.system === null ? null : normalizeName(contract.system),
        responsibleEngineer: contract.engineer === null ? null : normalizeName(contract.engineer),
        validFrom: contract.validFrom,
        validTo: contract.validTo,
        contractValue: amountOf(contract.value),
        finalCredit: amountOf(contract.finalCredit),
        sourceFrequency: item.sourceFrequency,
        maintenanceFrequency: item.frequency,
        defaultVisitAmount: item.defaultVisitAmount,
        status: "DRAFT",
        scheduleCutoverDate: asOf,
        sourceVisitCount: own.length,
        historicalVisitCount: own.filter((visit) => visit.disposition === "IMPORTABLE").length,
      },
      destination: "amc_contracts (status DRAFT, schedule_cutover_date set)",
      disposition: reasons.length === 0 ? "IMPORTABLE" : "HELD",
      holdReasons: reasons,
      warnings,
      invoice: null,
    };
  });

  // --- jobs -> historical projects ----------------------------------------------
  const jobKey = (job: JobSource) => (job.jobNumber === null ? null : job.jobNumber.trim());
  const byJobNumber = new Map<string, JobSource[]>();

  for (const job of source.jobs) {
    const key = jobKey(job);

    if (key) {
      byJobNumber.set(key, [...(byJobNumber.get(key) ?? []), job]);
    }
  }

  const existingJobNumbers = new Set(database.jobNumbers);
  const jobInvoices = new Map<JobSource, { numbers: string[]; marker: boolean }>(source.jobs.map((job) => [job, invoiceNumbers(job.invoice)]));
  const jobsByInvoice = new Map<string, JobSource[]>();

  for (const [job, { numbers }] of jobInvoices) {
    for (const number of numbers) {
      jobsByInvoice.set(number, [...(jobsByInvoice.get(number) ?? []), job]);
    }
  }

  const projects: PlanRow<ProjectProposal>[] = source.jobs.map((job) => {
    const reasons: HoldReason[] = [];
    const warnings: string[] = [];
    const number = jobKey(job);
    const client = clientOf(job.clientRaw);
    const month = job.monthText === null ? null : monthNumber(job.monthText);
    const value = amountOf(job.value);
    let vatRate: string | null = null;

    if (!number) {
      reasons.push(hold("JOB_NUMBER_MISSING", "The job number is empty."));
    } else {
      const same = byJobNumber.get(number) as JobSource[];

      if (same.length > 1) {
        reasons.push(
          hold(
            "DUPLICATE_JOB_NUMBER",
            `Job number ${number} is on ${same.length} rows of the register (rows ${same.map((other) => other.ref.row).join(", ")}). ` +
              "Which row keeps the number is for the client to say. No job number is changed."
          )
        );
      }
      if (existingJobNumbers.has(number)) {
        reasons.push(hold("JOB_NUMBER_ALREADY_IN_DATABASE", `A project with job number ${number} already exists in the database.`));
      }
    }

    const clientReason = clientHold(client);

    if (clientReason) reasons.push(clientReason);
    if (job.description === null) reasons.push(hold("DESCRIPTION_MISSING", "The job description is empty."));
    if (job.status === null) reasons.push(hold("STATUS_MISSING", "The status is empty, so there is no source status to keep."));
    if (job.monthText === null) {
      reasons.push(hold("MONTH_MISSING", "The month is empty."));
    } else if (month === null) {
      reasons.push(hold("MONTH_NOT_UNDERSTOOD", `"${job.monthText}" is not a month name.`));
    }
    if (source.jobsYear === null) {
      reasons.push(hold("YEAR_MISSING", "The register has no year in its title, so the month cannot be dated."));
    }

    if (job.value.kind === "BLANK") {
      reasons.push(hold("JOB_VALUE_BLANK", "The job value is empty and cannot be recovered from the workbooks. It is not treated as zero: the client must supply it."));
    } else if (job.value.kind === "INVALID") {
      reasons.push(hold("JOB_VALUE_INVALID", `The job value "${job.value.raw}" is ${job.value.reason}.`));
    } else {
      if (job.value.isZero) {
        warnings.push("The job value is an explicit zero in the source and is kept as 0.000.");
      }
      // The register's VAT column is 5% of the job value on every line; the rate is confirmed line by line.
      if (equalsProduct(job.vatCell, job.value.amount, "0.05")) {
        vatRate = "5.000";
      } else {
        reasons.push(hold("VAT_NOT_CONFIRMED", "The VAT cell is not 5% of the job value, so the rate this job carried cannot be confirmed from the register."));
      }
    }

    if (job.profit.kind === "INVALID") {
      warnings.push(`The PROFIT cell "${job.profit.raw}" is ${job.profit.reason}. It is kept in the raw values only.`);
    }
    if (number && job.serial !== null && /\d+$/.test(number) && Number(/\d+$/.exec(number)?.[0]) !== Number(job.serial)) {
      warnings.push(`S. No ${job.serial} does not match the digits of job number ${number}.`);
    }
    if (job.description !== null && job.description.length > 1000) {
      warnings.push("The description is longer than the 1000 characters the application's form accepts.");
    }

    // Invoice references: classified and kept for later. Never a reason to hold a job.
    const { numbers, marker } = jobInvoices.get(job) as { numbers: string[]; marker: boolean };
    const shared = numbers.flatMap((invoice) => (jobsByInvoice.get(invoice) as JobSource[]).filter((other) => other !== job));
    const crossClient = shared.some((other) => (clientOf(other.clientRaw)?.masterKey ?? "") !== (client?.masterKey ?? ""));
    const notes: string[] = [];
    let classification: InvoiceClassification = "NO_INVOICE_REFERENCE";

    if (marker) {
      classification = "NON_NUMERIC_MARKER";
      notes.push(`"${job.invoice.kind === "BLANK" ? "" : job.invoice.raw}" is not an invoice number and is not read as one.`);
    } else if (numbers.length > 0) {
      const multiple = numbers.length > 1;

      classification =
        multiple && shared.length > 0
          ? "JOB_HAS_MULTIPLE_INVOICES_AND_SHARED"
          : multiple
            ? "JOB_HAS_MULTIPLE_INVOICES"
            : shared.length > 0
              ? crossClient
                ? "INVOICE_ON_MULTIPLE_JOBS_CROSS_CLIENT"
                : "INVOICE_ON_MULTIPLE_JOBS_SAME_CLIENT"
              : "ONE_JOB_ONE_INVOICE";
      if (multiple) notes.push(`The cell lists ${numbers.length} invoices. How the job value divides between them is not in the register.`);
      if (shared.length > 0) {
        notes.push(`Also on ${[...new Set(shared)].map((other) => `${jobKey(other) ?? "(no number)"} (row ${other.ref.row}, ${normalizeName(other.clientRaw ?? "no client")})`).join(", ")}.`);
      }
      if (crossClient) notes.push("The jobs sharing this invoice belong to different clients. Whether that is correct is for the client to say.");
    }

    const jobDate = month !== null && source.jobsYear !== null ? `${source.jobsYear}-${String(month).padStart(2, "0")}-01` : null;
    const vat = value !== null && vatRate !== null ? vatAmount(value, vatRate) : null;

    return {
      source: job.ref,
      kind: "PROJECT",
      identifier: number ?? `(no job number, row ${job.ref.row})`,
      raw: job.raw,
      proposed: {
        jobNumber: number,
        clientRaw: job.clientRaw,
        clientName: client?.masterName ?? null,
        description: job.description === null ? null : normalizeName(job.description),
        sourceJobDate: job.monthText === null ? null : `${normalizeName(job.monthText)}${source.jobsYear === null ? "" : ` ${source.jobsYear}`}`,
        jobDate,
        jobDatePrecision: "MONTH",
        status: "HISTORICAL",
        legacyStatus: job.status === null ? null : normalizeName(job.status),
        jobValue: value,
        vatRate,
        vatAmount: vat,
        grandValue: value !== null && vat !== null ? addAmounts([value, vat]) : null,
        completedDate: null,
        legacyProfit: amountOf(job.profit),
      },
      destination: "projects (status HISTORICAL)",
      disposition: reasons.length === 0 ? "IMPORTABLE" : "HELD",
      holdReasons: reasons,
      warnings,
      invoice: { rawCell: job.invoice.kind === "BLANK" ? null : job.invoice.raw, numbers, classification, notes },
    };
  });

  // --- client rows: one per name per workbook, at its first occurrence -----------
  const referenced = new Set<string>();

  for (const row of contracts) {
    if (row.disposition === "IMPORTABLE") referenced.add(clientOf(row.proposed.clientRaw)?.masterKey ?? "");
  }
  for (const row of projects) {
    if (row.disposition === "IMPORTABLE") referenced.add(clientOf(row.proposed.clientRaw)?.masterKey ?? "");
  }

  const firstSeen = new Map<string, { ref: SourceRef; raw: string }>();
  const see = (ref: SourceRef, raw: string | null) => {
    if (raw !== null && !firstSeen.has(`${ref.workbook}|${raw}`)) {
      firstSeen.set(`${ref.workbook}|${raw}`, { ref, raw });
    }
  };

  source.contracts.forEach((contract) => see(contract.ref, contract.clientRaw));
  source.schedule.forEach((row) => see(row.ref, labels.get(row)?.clientPart ?? null));
  source.jobs.forEach((job) => see(job.ref, job.clientRaw));

  const clientRows: PlanRow<ClientProposal>[] = [...firstSeen.values()].map(({ ref, raw }) => {
    const name = clientOf(raw) as ClientName;
    const reason = clientHold(name);
    const reasons = reason ? [reason] : [];

    if (!reason && name.existingClientId === null && !referenced.has(name.masterKey)) {
      reasons.push(hold("NO_IMPORTABLE_RECORD_YET", `Every source row of "${name.masterName}" is held, so no client record is needed yet. It is created with the first row that is released.`));
    }

    return {
      source: ref,
      kind: "CLIENT",
      identifier: raw,
      raw: { Client: raw },
      proposed: {
        rawName: raw,
        normalizedName: name.normalized,
        masterName: name.masterName,
        classification: name.classification,
        outcome: name.outcome,
        existingClientId: name.existingClientId,
      },
      destination: name.existingClientId !== null ? `clients (existing id ${name.existingClientId})` : "clients",
      disposition: reasons.length === 0 ? "IMPORTABLE" : "HELD",
      holdReasons: reasons,
      warnings: name.lookAlikes.length > 0 ? [`Look-alike name(s), kept separate: ${name.lookAlikes.join("; ")}.`] : [],
      invoice: null,
    };
  });

  // --- totals ------------------------------------------------------------------
  const sum = (amounts: (string | null)[]) => addAmounts(amounts.filter((amount): amount is string => amount !== null));
  const importable = <P>(rows: PlanRow<P>[]) => rows.filter((row) => row.disposition === "IMPORTABLE");
  const held = <P>(rows: PlanRow<P>[]) => rows.filter((row) => row.disposition === "HELD");
  const byReason = <P>(rows: PlanRow<P>[]) => {
    const counts: Record<string, number> = {};

    for (const row of held(rows)) {
      for (const reason of row.holdReasons) {
        counts[reason.code] = (counts[reason.code] ?? 0) + 1;
      }
    }

    return Object.fromEntries(Object.entries(counts).sort());
  };
  const tally = <P>(rows: PlanRow<P>[]) => {
    const counts: Record<string, number> = {};

    for (const row of rows) {
      const key = row.invoice?.classification ?? "NO_INVOICE_REFERENCE";

      counts[key] = (counts[key] ?? 0) + 1;
    }

    return Object.fromEntries(Object.entries(counts).sort());
  };
  const safeMasters = clients.masters.filter((master) => !master.held);
  const scheduleNumbers = visits.flatMap((visit) => visit.invoice?.numbers ?? []);
  const totals: PlanTotals = {
    clients: {
      rawNames: clients.names.length,
      masters: clients.masters.length,
      existing: safeMasters.filter((master) => master.existingClientId !== null).length,
      proposedNew: safeMasters.filter((master) => master.existingClientId === null && referenced.has(master.key)).length,
      deferred: safeMasters.filter((master) => master.existingClientId === null && !referenced.has(master.key)).length,
      heldMasters: clients.masters.filter((master) => master.held).length,
      heldAliases: clients.names.filter((name) => name.outcome === "HELD_ALIAS_NOT_APPROVED").length,
    },
    contracts: {
      source: contracts.length,
      importable: importable(contracts).length,
      held: held(contracts).length,
      sourceValue: sum(contracts.map((row) => row.proposed.contractValue)),
      importableValue: sum(importable(contracts).map((row) => row.proposed.contractValue)),
      heldValue: sum(held(contracts).map((row) => row.proposed.contractValue)),
      sourceFinalCredit: sum(contracts.map((row) => row.proposed.finalCredit)),
      importableFinalCredit: sum(importable(contracts).map((row) => row.proposed.finalCredit)),
      heldFinalCredit: sum(held(contracts).map((row) => row.proposed.finalCredit)),
    },
    visits: {
      source: visits.length,
      importable: importable(visits).length,
      held: held(visits).length,
      generatedWithoutSource: 0,
      sourceAmount: sum(visits.map((row) => row.proposed.visitAmount)),
      importableAmount: sum(importable(visits).map((row) => row.proposed.visitAmount)),
      heldAmount: sum(held(visits).map((row) => row.proposed.visitAmount)),
      heldByReason: byReason(visits),
    },
    projects: {
      source: projects.length,
      importable: importable(projects).length,
      held: held(projects).length,
      sourceValue: sum(projects.map((row) => row.proposed.jobValue)),
      importableValue: sum(importable(projects).map((row) => row.proposed.jobValue)),
      heldValue: sum(held(projects).map((row) => row.proposed.jobValue)),
      importableVat: sum(importable(projects).map((row) => row.proposed.vatAmount)),
      importableGrandValue: sum(importable(projects).map((row) => row.proposed.grandValue)),
      heldByReason: byReason(projects),
    },
    invoices: {
      jobs: tally(projects),
      schedule: tally(visits),
      jobMentions: projects.reduce((count, row) => count + (row.invoice?.numbers.length ?? 0), 0),
      distinctJobNumbers: jobsByInvoice.size,
      scheduleNumbers: scheduleNumbers.length,
      sharedBetweenJobsAndSchedule: scheduleNumbers.filter((number) => jobsByInvoice.has(number)).length,
    },
  };

  // --- checks: the plan must account for the source exactly -----------------------
  const totalCheck = (name: string, total: SourceTotal | null, rows: string): PlanCheck => {
    if (total === null || total.value.kind !== "VALUE") {
      return { name, passed: false, detail: "The workbook shows no total to compare with." };
    }

    return {
      name,
      passed: total.value.amount === rows,
      detail: `rows ${rows}, workbook total ${total.value.amount} (${total.ref.cell})`,
    };
  };
  const blockTotal = sum(source.totals.scheduleBlocks.map((block) => amountOf(block.value)));
  const moneyAdds = (whole: string, parts: string[]) => toThousandths(whole) === parts.reduce((total, amount) => total + toThousandths(amount), 0n);
  const checks: PlanCheck[] = [
    {
      name: "Every schedule row is accounted for exactly once",
      passed: visits.length === source.schedule.length && new Set(visits.map((visit) => visit.source.cell)).size === source.schedule.length,
      detail: `${source.schedule.length} source rows, ${visits.length} plan rows`,
    },
    {
      name: "Proposed historical visits = schedule rows - held rows",
      passed: totals.visits.importable === source.schedule.length - totals.visits.held,
      detail: `${source.schedule.length} - ${totals.visits.held} = ${totals.visits.importable}`,
    },
    {
      name: "No visit is proposed without a source row",
      passed: importable(visits).every((visit) => source.schedule.some((row) => row.ref === visit.source)),
      detail: `${totals.visits.importable} proposed, each from one source row; 0 generated`,
    },
    {
      name: "No proposed visit has a completion date",
      passed: visits.every((visit) => visit.proposed.completedDate === null),
      detail: "completed_date is null on every proposed visit",
    },
    {
      name: "Every job row is accounted for exactly once",
      passed: projects.length === source.jobs.length && new Set(projects.map((project) => project.source.row)).size === source.jobs.length,
      detail: `${source.jobs.length} source rows, ${projects.length} plan rows`,
    },
    {
      name: "No proposed project has a completion date or an invented day",
      passed: projects.every((project) => project.proposed.completedDate === null && project.proposed.jobDatePrecision === "MONTH" && (project.proposed.jobDate === null || project.proposed.jobDate.endsWith("-01"))),
      detail: "status HISTORICAL, precision MONTH, completed_date null on every proposed project",
    },
    {
      name: "No imported job number differs from its source",
      passed: importable(projects).every((project) => project.proposed.jobNumber === (source.jobs.find((job) => job.ref === project.source)?.jobNumber ?? "").trim()),
      detail: "every proposed job number is the source job number",
    },
    {
      name: "Importable + held job value = source job value",
      passed: moneyAdds(totals.projects.sourceValue, [totals.projects.importableValue, totals.projects.heldValue]),
      detail: `${totals.projects.importableValue} + ${totals.projects.heldValue} = ${totals.projects.sourceValue}`,
    },
    totalCheck("Job values add up to the register's total", source.totals.jobValue, totals.projects.sourceValue),
    totalCheck("Contract values add up to the register's total", source.totals.contractValue, totals.contracts.sourceValue),
    totalCheck("Final credits add up to the register's total", source.totals.finalCredit, totals.contracts.sourceFinalCredit),
    {
      name: "Schedule amounts add up to the month totals",
      passed: blockTotal === totals.visits.sourceAmount,
      detail: `rows ${totals.visits.sourceAmount}, month totals ${blockTotal}`,
    },
    {
      name: "Importable + held schedule amount = source schedule amount",
      passed: moneyAdds(totals.visits.sourceAmount, [totals.visits.importableAmount, totals.visits.heldAmount]),
      detail: `${totals.visits.importableAmount} + ${totals.visits.heldAmount} = ${totals.visits.sourceAmount}`,
    },
  ];

  return { asOf, clients, clientRows, contracts, visits, projects, ignored: source.ignored, totals, checks };
}

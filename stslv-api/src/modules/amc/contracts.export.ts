import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import { assertExportSize, type ReportColumn, type ReportDefinition, type ReportRow } from "../../shared/export/report";
import type { AuthContext } from "../auth/access";
import type { ContractStatus } from "./amc.constants";
import type { ContractColumn, ExportContractsQuery } from "./amc.schemas";
import { listContracts, type Contract } from "./contracts.service";

// The AMC contract register as a report: the contracts the page lists for the
// same filters, in the same order. Every amount is as stored; nothing is calculated here.

const STATUS_LABELS: Record<ContractStatus, string> = { DRAFT: "Draft", ACTIVE: "Active", EXPIRED: "Expired", CANCELLED: "Cancelled" };

const COLUMNS: ReportColumn[] = [
  { key: "number", header: "#", kind: "count", width: 6 },
  { key: "reference", header: "AMC Reference", kind: "identifier", width: 13 },
  { key: "client", header: "Client", kind: "text", width: 28, wrap: true },
  { key: "system", header: "System", kind: "text", width: 20, wrap: true },
  { key: "frequency", header: "Frequency", kind: "text", width: 18, wrap: true },
  { key: "engineer", header: "Responsible Engineer", kind: "text", width: 20, wrap: true, excelOnly: true },
  { key: "validFrom", header: "Valid From", kind: "date", width: 12 },
  { key: "validTo", header: "Valid To", kind: "date", width: 12 },
  { key: "status", header: "Status", kind: "text", width: 13 },
  { key: "contractValue", header: "AMC Value / Year", kind: "money", width: 14 },
  { key: "finalCredit", header: "Final Credit", kind: "money", width: 14 },
  { key: "billingBasis", header: "Billing Basis", kind: "text", width: 14 },
  { key: "billingAmount", header: "Billing Amount", kind: "money", width: 14, excelOnly: true },
  { key: "visitValue", header: "Cost per Visit", kind: "money", width: 14 },
  { key: "visits", header: "Visits", kind: "count", width: 8, excelOnly: true },
  { key: "completed", header: "Completed", kind: "count", width: 10, excelOnly: true },
];

async function frequencyLabels(): Promise<Map<string, string>> {
  const rows = await pool.query<{ code: string; label: string }>("SELECT code, label FROM maintenance_frequencies");

  return new Map(rows.rows.map((row) => [row.code, row.label]));
}

/** The report columns behind each column a user can hide on the page. */
const HIDDEN_KEYS: Record<ContractColumn, string[]> = {
  reference: ["reference"],
  system: ["system"],
  engineer: ["engineer"],
  validity: ["validFrom", "validTo"],
  frequency: ["frequency"],
  contractValue: ["contractValue"],
  finalCredit: ["finalCredit"],
  visits: ["visits", "completed"],
  status: ["status"],
};

function toRow(contract: Contract, index: number, labels: Map<string, string>): ReportRow {
  return {
    number: index + 1,
    // The contract number, with its version from a renewal's second version on (0111), as on every other export.
    reference: contract.contractVersion > 1 ? `${contract.amcReference} (V${contract.contractVersion})` : contract.amcReference,
    client: contract.client.name,
    system: contract.systemDescription,
    frequency: labels.get(contract.maintenanceFrequency) ?? contract.maintenanceFrequency,
    engineer: contract.responsibleEngineer,
    validFrom: contract.validFrom,
    validTo: contract.validTo,
    status: STATUS_LABELS[contract.status],
    contractValue: contract.contractValue,
    finalCredit: contract.finalCredit,
    billingBasis: contract.billingBasis === "FINAL_CREDIT" ? "Final Credit" : contract.billingBasis === "CONTRACT_VALUE" ? "AMC Value / Year" : contract.billingBasis === "CUSTOM" ? "Custom" : null,
    billingAmount: contract.selectedBillingAmount,
    visitValue: contract.defaultVisitAmount,
    visits: contract.schedule.visitCount,
    completed: contract.schedule.completedCount,
  };
}

/** The filters in words. Names are read from the database, never taken from the request. */
async function describeFilters(query: ExportContractsQuery): Promise<ReportDefinition["filters"]> {
  const filters: ReportDefinition["filters"] = [];
  const nameOf = async (table: "clients" | "sales_engineers", id: string, unknown: string) =>
    (await pool.query<{ name: string }>(`SELECT name FROM ${table} WHERE id = $1`, [id])).rows[0]?.name ?? unknown;

  if (query.status !== "all") filters.push({ label: "Status", value: STATUS_LABELS[query.status] });
  if (query.validity === "due") filters.push({ label: "Validity", value: "Due: active, ending within 45 days" });
  if (query.validity === "expired") filters.push({ label: "Validity", value: "Expired: status Expired, or validity ended" });
  if (query.clientId) filters.push({ label: "Client", value: await nameOf("clients", query.clientId, "Unknown client") });
  if (query.salesEngineerId) filters.push({ label: "Sales Engineer", value: await nameOf("sales_engineers", query.salesEngineerId, "Unknown sales engineer") });
  if (query.system) filters.push({ label: "System", value: query.system });
  if (query.frequency) filters.push({ label: "Frequency", value: query.frequency });
  if (query.year) filters.push({ label: "Year", value: String(query.year) });
  if (query.search) filters.push({ label: "Search", value: query.search });

  return filters;
}

/** The report, and the audit entry to write once the file has been produced. */
export async function buildContractsExport(auth: AuthContext, query: ExportContractsQuery): Promise<{ report: ReportDefinition; recordExport: () => Promise<void> }> {
  const { format, hidden, ...filters } = query;
  const { total } = await listContracts({ ...filters, page: 1, pageSize: 1 });

  assertExportSize(format, total);

  const [{ items, totals }, labels] = await Promise.all([listContracts({ ...filters, page: 1, pageSize: Math.max(total, 1) }), frequencyLabels()]);
  const dropped = new Set(hidden.flatMap((column) => HIDDEN_KEYS[column]));
  const columns = COLUMNS.filter((column) => !dropped.has(column.key));
  // The figures are PostgreSQL's numeric(16,3) sums over every contract the filters select.
  const totalValues: Record<string, string> = {
    ...(dropped.has("contractValue") ? {} : { contractValue: totals.contractValue }),
    ...(dropped.has("finalCredit") ? {} : { finalCredit: totals.finalCredit }),
  };
  const report: ReportDefinition = {
    title: "AMC Contracts",
    period: null,
    filters: await describeFilters(query),
    generatedAt: new Date(),
    generatedBy: auth.user.fullName,
    orientation: "landscape",
    fileStem: "amc-contracts",
    tables: [
      {
        name: "AMC Contracts",
        columns,
        rows: items.map((contract, index) => toRow(contract, index, labels)),
        ...(Object.keys(totalValues).length > 0
          ? {
              totals: {
                label: `Filtered Total (${total} ${total === 1 ? "contract" : "contracts"})`,
                values: totalValues,
                excelFormulas: Object.fromEntries(Object.keys(totalValues).map((key) => [key, (range: (name: string) => string) => `SUM(${range(key)})`])),
              },
            }
          : {}),
        notes: ["Amounts are as entered on each contract. Cost per Visit is the amount given to each new visit; whether it includes VAT is not confirmed."],
      },
    ],
  };

  const recordExport = () =>
    logActivity(pool, {
      userId: auth.user.id,
      action: "amc_contracts.exported",
      module: "AMC_CONTRACTS",
      entityType: "amc_contracts",
      entityId: null,
      description: `Exported AMC Contracts as ${format === "xlsx" ? "Excel" : "PDF"} (${total} ${total === 1 ? "contract" : "contracts"}).`,
      metadata: { format, filters, hidden, rowCount: total },
    });

  return { report, recordExport };
}

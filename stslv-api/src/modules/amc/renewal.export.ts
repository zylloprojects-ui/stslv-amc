import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import { assertExportSize, displayDate, type ReportColumn, type ReportDefinition, type ReportRow } from "../../shared/export/report";
import type { AuthContext } from "../auth/access";
import type { ContractStatus } from "./amc.constants";
import { RENEWAL_WARNING_DAYS } from "./management.service";
import type { ExportRenewalHistoryQuery, ExportRenewalQueueQuery, RenewalQueueColumn, RenewalState } from "./renewal-queue.schemas";
import { listAllRenewalQueue, type RenewalQueueItem } from "./renewal-queue.service";
import { listAllRenewalHistory, type RenewalHistoryItem } from "./renewals.service";
import { amcReference } from "./service-status.service";

// The AMC Renewal page's two tabs as reports: the same rows, filters and card
// figures the page shows. Nothing is calculated here.

export const RENEWAL_STATE_LABELS: Record<RenewalState, string> = {
  DUE: "Due / Expired",
  UNDER_APPROVAL: "Under Client Approval",
  RENEWED: "Renewed",
  CANCELLED: "Cancelled",
};

const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = {
  DRAFT: "Draft",
  ACTIVE: "Active",
  EXPIRED: "Expired",
  CANCELLED: "Cancelled",
};

/** The renewal state a renewal contract's own status stands for (see RENEWAL_STATES). */
export function renewalStateOf(status: ContractStatus): RenewalState {
  if (status === "DRAFT") return "UNDER_APPROVAL";
  if (status === "CANCELLED") return "CANCELLED";
  return "RENEWED";
}

const exportedAs = (format: string) => (format === "xlsx" ? "Excel" : "PDF");

// --- Renewal Queue -----------------------------------------------------------

/** Every column in page order. `hideable` names the page column that hides it. */
const QUEUE_COLUMNS: (ReportColumn & { hideable?: RenewalQueueColumn })[] = [
  { key: "number", header: "#", kind: "count", width: 6 },
  { key: "reference", header: "AMC Reference", kind: "identifier", width: 13 },
  { key: "client", header: "Client", kind: "text", width: 26, wrap: true, hideable: "client" },
  { key: "system", header: "System", kind: "text", width: 20, wrap: true, hideable: "system" },
  { key: "frequency", header: "Frequency", kind: "text", width: 13, hideable: "frequency" },
  { key: "service", header: "Service", kind: "text", width: 14, hideable: "service" },
  { key: "expiry", header: "Contract Expiry Date", kind: "date", width: 14, hideable: "expiry" },
  { key: "contractStatus", header: "Contract Status", kind: "text", width: 12, hideable: "contractStatus" },
  { key: "amount", header: "Contract Amount", kind: "money", width: 15, hideable: "amount" },
  { key: "remarks", header: "Remarks", kind: "text", width: 26, wrap: true, hideable: "remarks" },
  { key: "renewalState", header: "Renewal Status", kind: "text", width: 20 },
  { key: "renewal", header: "Renewal AMC", kind: "identifier", width: 13 },
];

export function renewalQueueColumns(hidden: readonly RenewalQueueColumn[]): ReportColumn[] {
  return QUEUE_COLUMNS.filter((column) => !column.hideable || !hidden.includes(column.hideable)).map(({ hideable: _hideable, ...column }) => column);
}

function queueRow(item: RenewalQueueItem, index: number): ReportRow {
  return {
    number: index + 1,
    reference: item.reference,
    client: item.client.name,
    system: item.system.typeName ? `${item.system.typeName} · ${item.system.description}` : item.system.description,
    frequency: item.frequency.label,
    service: `${item.services.completed} of ${item.services.scheduled} completed`,
    expiry: item.validTo,
    contractStatus: CONTRACT_STATUS_LABELS[item.contractStatus],
    amount: item.contractValue,
    remarks: item.remarks,
    renewalState: RENEWAL_STATE_LABELS[item.renewalState],
    renewal: item.renewal?.reference ?? null,
  };
}

export async function buildRenewalQueueExport(
  auth: AuthContext,
  query: ExportRenewalQueueQuery
): Promise<{ report: ReportDefinition; recordExport: () => Promise<void> }> {
  const { format, hidden, ...filters } = query;
  const { items, kpis, total } = await listAllRenewalQueue(filters, (count) => assertExportSize(format, count));
  const reportFilters: ReportDefinition["filters"] = [];

  if (filters.renewalStatus) reportFilters.push({ label: "Renewal status", value: RENEWAL_STATE_LABELS[filters.renewalStatus] });
  if (filters.search) reportFilters.push({ label: "Search", value: filters.search });

  const report: ReportDefinition = {
    title: "AMC Renewal Queue",
    period: null,
    filters: reportFilters,
    generatedAt: new Date(),
    generatedBy: auth.user.fullName,
    orientation: "landscape",
    fileStem: "amc-renewal-queue",
    tables: [
      {
        name: "Renewal Queue",
        columns: renewalQueueColumns(hidden),
        rows: items.map(queueRow),
        notes: [
          `Due / Expired ${kpis.due} · Under Client Approval ${kpis.underApproval} · Renewed ${kpis.renewed} · Cancelled ${kpis.cancelled}.`,
          `Due / Expired: active or expired contracts ending within ${RENEWAL_WARNING_DAYS} days or already ended, with no renewal. A renewal is a separate contract; the contract it renews is unchanged.`,
        ],
      },
    ],
  };

  const recordExport = () =>
    logActivity(pool, {
      userId: auth.user.id,
      action: "amc_renewal_queue.exported",
      module: "AMC_CONTRACTS",
      entityType: "amc_contracts",
      entityId: null,
      description: `Exported the AMC Renewal Queue as ${exportedAs(format)} (${total} ${total === 1 ? "contract" : "contracts"}).`,
      metadata: { format, filters, hidden, rowCount: total },
    });

  return { report, recordExport };
}

// --- Renewal History ---------------------------------------------------------

const HISTORY_COLUMNS: ReportColumn[] = [
  { key: "number", header: "#", kind: "count", width: 6 },
  { key: "source", header: "Source AMC", kind: "identifier", width: 13 },
  { key: "clientSystem", header: "Client / System", kind: "text", width: 34, wrap: true },
  { key: "sourceExpiry", header: "Source Expiry", kind: "date", width: 14 },
  { key: "renewal", header: "Renewed AMC", kind: "identifier", width: 13 },
  { key: "newValidity", header: "New Validity", kind: "text", width: 26 },
  { key: "status", header: "Status", kind: "text", width: 22 },
  { key: "created", header: "Created", kind: "date", width: 14 },
];

function historyRow(item: RenewalHistoryItem, index: number): ReportRow {
  const status = item.renewal.status as ContractStatus;

  return {
    number: index + 1,
    source: amcReference(item.source.id),
    clientSystem: `${item.renewal.client.name} · ${item.renewal.systemDescription}`,
    sourceExpiry: item.source.validTo,
    renewal: amcReference(item.renewal.id),
    newValidity: `${displayDate(item.renewal.validFrom)} to ${displayDate(item.renewal.validTo)}`,
    status: `${RENEWAL_STATE_LABELS[renewalStateOf(status)]} (${CONTRACT_STATUS_LABELS[status]})`,
    created: item.createdOn,
  };
}

export async function buildRenewalHistoryExport(
  auth: AuthContext,
  query: ExportRenewalHistoryQuery
): Promise<{ report: ReportDefinition; recordExport: () => Promise<void> }> {
  const { items, total } = await listAllRenewalHistory((count) => assertExportSize(query.format, count));

  const report: ReportDefinition = {
    title: "AMC Renewal History",
    period: null,
    filters: [],
    generatedAt: new Date(),
    generatedBy: auth.user.fullName,
    orientation: "landscape",
    fileStem: "amc-renewal-history",
    tables: [
      {
        name: "Renewal History",
        columns: HISTORY_COLUMNS,
        rows: items.map(historyRow),
        notes: ["Every renewal made, newest first. Status is the renewal contract's: Draft is under client approval; a cancelled renewal is kept for the record."],
      },
    ],
  };

  const recordExport = () =>
    logActivity(pool, {
      userId: auth.user.id,
      action: "amc_renewal_history.exported",
      module: "AMC_CONTRACTS",
      entityType: "amc_contracts",
      entityId: null,
      description: `Exported the AMC Renewal History as ${exportedAs(query.format)} (${total} ${total === 1 ? "renewal" : "renewals"}).`,
      metadata: { format: query.format, rowCount: total },
    });

  return { report, recordExport };
}

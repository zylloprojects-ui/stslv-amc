import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import {
  assertExportSize,
  displayToday,
  type ReportColumn,
  type ReportDefinition,
  type ReportRow,
} from "../../shared/export/report";
import type { AuthContext } from "../auth/access";
import type { ExportClientContractsQuery, ExportClientsQuery } from "./clients.schemas";
import { CLIENT_TYPE_LABELS, CLIENT_STATUS_LABELS } from "./clients.schemas";
import { getClient, hasClientDetails, listAllClients, type Client } from "./clients.service";

// The Client Master and one client's AMC contracts as reports. Every value is
// the stored one; nothing is calculated here except the contract value total,
// which PostgreSQL sums.

type RecordExport = () => Promise<void>;
type Built = { report: ReportDefinition; recordExport: RecordExport };

const formatName = (format: "xlsx" | "pdf") => (format === "xlsx" ? "Excel" : "PDF");

// ---------------------------------------------------------------------------
// Client list
// ---------------------------------------------------------------------------

const BASE_COLUMNS: ReportColumn[] = [
  { key: "code", header: "Client code", kind: "identifier", width: 13 },
  { key: "name", header: "Client name", kind: "text", width: 32, wrap: true },
];
const DETAIL_COLUMNS: ReportColumn[] = [
  { key: "clientType", header: "Type", kind: "text", width: 12 },
  { key: "vatNumber", header: "VAT number", kind: "identifier", width: 18 },
];
const CONTACT_COLUMNS: ReportColumn[] = [
  { key: "contactPerson", header: "Contact person", kind: "text", width: 22, wrap: true },
  { key: "phone", header: "Phone", kind: "identifier", width: 16 },
  { key: "email", header: "Email", kind: "text", width: 28, wrap: true },
  { key: "status", header: "Status", kind: "text", width: 10 },
  { key: "address", header: "Address", kind: "text", width: 34, wrap: true, excelOnly: true },
  { key: "remarks", header: "Remarks", kind: "text", width: 36, wrap: true, excelOnly: true },
  { key: "createdAt", header: "Added", kind: "date", width: 13, excelOnly: true },
];

function clientRow(client: Client): ReportRow {
  return {
    code: client.code,
    name: client.name,
    clientType: client.clientType ? CLIENT_TYPE_LABELS[client.clientType] : null,
    vatNumber: client.vatNumber,
    contactPerson: client.contactPerson,
    phone: client.phone,
    email: client.email,
    status: CLIENT_STATUS_LABELS[client.isActive ? "active" : "inactive"],
    address: client.address,
    remarks: client.notes,
    createdAt: client.createdAt.slice(0, 10),
  };
}

function describeClientFilters(query: ExportClientsQuery, details: boolean): ReportDefinition["filters"] {
  const filters: ReportDefinition["filters"] = [
    { label: "Status", value: query.status === "all" ? "All" : CLIENT_STATUS_LABELS[query.status] },
  ];

  if (query.clientType && details) {
    filters.push({ label: "Type", value: CLIENT_TYPE_LABELS[query.clientType] });
  }
  if (query.search) {
    filters.push({ label: "Search", value: query.search });
  }

  return filters;
}

export async function buildClientsExport(auth: AuthContext, query: ExportClientsQuery): Promise<Built> {
  const { format, ...filters } = query;
  const details = await hasClientDetails();
  const { items, total } = await listAllClients(filters, (count) => assertExportSize(format, count));

  const report: ReportDefinition = {
    title: "Clients",
    period: null,
    filters: describeClientFilters(query, details),
    generatedAt: new Date(),
    generatedBy: auth.user.fullName,
    orientation: "landscape",
    fileStem: "clients",
    tables: [
      {
        name: "Clients",
        columns: [...BASE_COLUMNS, ...(details ? DETAIL_COLUMNS : []), ...CONTACT_COLUMNS],
        rows: items.map(clientRow),
        // An empty export already says so in the table; a count of zero would only repeat it.
        notes: total > 0 ? [`${total} ${total === 1 ? "client" : "clients"}.`] : [],
      },
    ],
  };

  const recordExport = () =>
    logActivity(pool, {
      userId: auth.user.id,
      action: "clients.exported",
      module: "CLIENTS",
      entityType: "clients",
      entityId: null,
      description: `Exported the client list as ${formatName(format)} (${total} ${total === 1 ? "client" : "clients"}).`,
      metadata: { format, filters, rowCount: total },
    });

  return { report, recordExport };
}

// ---------------------------------------------------------------------------
// One client's AMC contracts
// ---------------------------------------------------------------------------

const FREQUENCY_LABELS: Record<string, string> = {
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  HALF_YEARLY: "Half-yearly",
  ANNUALLY: "Annually",
};

const CONTRACT_STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  ACTIVE: "Active",
  EXPIRED: "Expired",
  CANCELLED: "Cancelled",
};

const CONTRACT_COLUMNS: ReportColumn[] = [
  { key: "system", header: "System", kind: "text", width: 30, wrap: true },
  { key: "engineer", header: "Responsible engineer", kind: "text", width: 20, wrap: true },
  { key: "validFrom", header: "Valid from", kind: "date", width: 13 },
  { key: "validTo", header: "Valid to", kind: "date", width: 13 },
  { key: "frequency", header: "Frequency", kind: "text", width: 12 },
  { key: "contractValue", header: "Contract value", kind: "money", width: 15 },
  { key: "status", header: "Status", kind: "text", width: 11 },
  { key: "finalCredit", header: "Final credit", kind: "money", width: 18, excelOnly: true },
  { key: "notes", header: "Notes", kind: "text", width: 36, wrap: true, excelOnly: true },
];

export async function buildClientContractsExport(auth: AuthContext, clientId: string, query: ExportClientContractsQuery): Promise<Built> {
  const { format } = query;
  const client = await getClient(clientId);
  const count = (await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM amc_contracts WHERE client_id = $1", [clientId])).rows[0]?.count ?? 0;

  assertExportSize(format, count);

  const rows = await pool.query<{
    system_description: string;
    responsible_engineer: string | null;
    valid_from: string;
    valid_to: string;
    maintenance_frequency: string;
    contract_value: string;
    status: string;
    final_credit: string | null;
    notes: string | null;
  }>(
    `SELECT system_description, responsible_engineer, valid_from::text AS valid_from, valid_to::text AS valid_to,
            maintenance_frequency, contract_value, status, final_credit, notes
     FROM amc_contracts WHERE client_id = $1
     ORDER BY valid_from DESC, id DESC`,
    [clientId]
  );
  // The total leaves out cancelled contracts, as the Client 360 figure does.
  const total = await pool.query<{ value: string }>(
    "SELECT COALESCE(sum(contract_value) FILTER (WHERE status <> 'CANCELLED'), 0)::numeric(16,3)::text AS value FROM amc_contracts WHERE client_id = $1",
    [clientId]
  );

  const report: ReportDefinition = {
    title: "Client AMC Contracts",
    period: null,
    filters: [
      { label: "Client", value: `${client.name} (${client.code})` },
      { label: "As of", value: displayToday(new Date()) },
    ],
    generatedAt: new Date(),
    generatedBy: auth.user.fullName,
    orientation: "landscape",
    fileStem: `client-contracts-${client.code.toLowerCase()}`,
    tables: [
      {
        name: "AMC Contracts",
        columns: CONTRACT_COLUMNS,
        rows: rows.rows.map((row) => ({
          system: row.system_description,
          engineer: row.responsible_engineer,
          validFrom: row.valid_from,
          validTo: row.valid_to,
          frequency: FREQUENCY_LABELS[row.maintenance_frequency] ?? row.maintenance_frequency,
          contractValue: row.contract_value,
          status: CONTRACT_STATUS_LABELS[row.status] ?? row.status,
          finalCredit: row.final_credit,
          notes: row.notes,
        })),
        totals: {
          label: `Contract value, excluding cancelled (${count} ${count === 1 ? "contract" : "contracts"})`,
          values: { contractValue: total.rows[0]?.value ?? "0.000" },
          excelFormulas: {
            contractValue: (range) => `SUMIFS(${range("contractValue")},${range("status")},"<>${CONTRACT_STATUS_LABELS.CANCELLED}")`,
          },
        },
      },
    ],
  };

  const recordExport = () =>
    logActivity(pool, {
      userId: auth.user.id,
      action: "client.contracts_exported",
      module: "CLIENTS",
      entityType: "clients",
      entityId: clientId,
      description: `Exported the AMC contracts of "${client.name}" as ${formatName(format)} (${count} ${count === 1 ? "contract" : "contracts"}).`,
      metadata: { format, rowCount: count },
    });

  return { report, recordExport };
}

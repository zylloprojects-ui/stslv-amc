import { pool } from "../../config/database";
import { escapeLike } from "../../shared/validation";
import type { ContractStatus, ServiceStatus, VisitStatus } from "../amc/amc.constants";
import type { PaymentStatus } from "../amc/manual-invoice.service";
import { getMasterStatusOptions } from "../amc/master-status.service";
import { IN_SCOPE, serviceStatusSql } from "../amc/service-status.service";
import { hasStoredReference, referenceSql } from "../amc/contract-reference";
import { readServiceReport, SERVICE_REPORT_JSON_SQL, serviceReportsAvailable, toServiceReport, type ServiceReport } from "../amc/service-reports.service";
import { notFound } from "../../shared/errors";
import { schemaHas } from "../../shared/schema-features";
import type { AccountsColour, ListAccountsQuery } from "./accounts.schemas";

// Accounts: a billing reconciliation with one row per scheduled maintenance visit
// (amc_visits), never one per contract. It reads the same visit records as Service
// Status, Master AMC Status and the AMC Schedule, the service report number entered
// on Service Status (0077), the manual Invoice No. of the visit (0100) and the Zoho
// invoices recorded in Invoice Tracking (0060). This module writes nothing: the
// manual Invoice No. is saved through its own route on the AMC visit.
//
// Paid / Unpaid is the approved reference status: a manual Invoice No. entered =
// Paid, cleared = Unpaid. It does not verify that money was received.
//
// The routes require migration 0077 (service report number). Every database
// that has it also has 0060, 0070, 0072, 0075 and 0076, all of which are read.

/** Service Status's own rule, so a visit shows the same status on both pages. */
const SERVICE_STATUS_SQL = serviceStatusSql({ renewals: true });

/** See ACCOUNTS_COLOURS. The manual Invoice No. decides; a Zoho record in Invoice Tracking does not. */
const COLOUR_SQL = `CASE
    WHEN v.status <> 'COMPLETED' THEN 'RED'
    WHEN v.manual_invoice_no IS NULL THEN 'BLUE'
    ELSE 'GREEN'
  END`;

// The active invoices of each visit, in one pass with the rows. One visit can
// be covered by more than one invoice (0060), so every number is kept.
const FROM = `
  FROM amc_visits v
  JOIN amc_contracts c ON c.id = v.amc_contract_id
  JOIN clients cl ON cl.id = c.client_id
  LEFT JOIN sales_engineers se ON se.id = c.sales_engineer_id
  LEFT JOIN system_types st ON st.id = c.system_type_id
  LEFT JOIN maintenance_frequencies mf ON mf.code = c.maintenance_frequency
  LEFT JOIN LATERAL (
    SELECT array_agg(i.invoice_number ORDER BY i.invoice_date, i.id) AS numbers,
           -- The part of those invoices allocated to this visit (OMR excluding VAT). One allocation per invoice and
           -- visit (0060 unique index), so nothing is counted twice; cancelled invoices are left out.
           sum(al.allocated_amount)::numeric(16,3) AS amount
    FROM invoice_allocations al
    JOIN invoices i ON i.id = al.invoice_id
    WHERE al.amc_visit_id = v.id AND i.status <> 'CANCELLED'
  ) inv ON true`;

/**
 * Read-only acknowledgement state of the service's invoice (Invoice Acknowledgements, 0112-0114), for the indicator
 * beside the Invoice No. Only for a user who may view Invoice Acknowledgements; it changes nothing on Accounts. An
 * Invoice No. with no acknowledgement recorded yet reads Pending.
 */
const ACKNOWLEDGEMENT_SQL = `CASE WHEN v.manual_invoice_no IS NULL THEN NULL ELSE COALESCE((
    SELECT CASE WHEN ca.status = 'ACKNOWLEDGED' THEN 'ACKNOWLEDGED' ELSE 'PENDING' END
    FROM ack_invoice_services s JOIN ack_invoices ai ON ai.id = s.ack_invoice_id
    LEFT JOIN invoice_acknowledgements ca ON ca.id = ai.current_acknowledgement_id
    WHERE s.amc_visit_id = v.id AND s.invoice_number = v.manual_invoice_no), 'PENDING') END`;

/** The row columns; `storedReference` is whether migration 0105 stores the AMC Reference Number. */
const selectSql = (storedReference: boolean, reports: boolean, acknowledgements = false) => `
  SELECT v.id, c.id AS contract_id, ${referenceSql("c", storedReference)} AS contract_reference, c.status AS contract_status,
         cl.id AS client_id, cl.name AS client_name, c.system_description,
         st.id AS system_type_id, st.name AS system_type_name,
         c.maintenance_frequency, mf.label AS frequency_label,
         v.sequence_no, v.cycle_no, v.service_code,
         v.scheduled_date::text AS scheduled_date, v.status, v.completed_date::text AS completed_date,
         v.visit_amount::text AS visit_amount, v.service_report_no, v.updated_at,
         v.manual_invoice_no, v.manual_invoice_at,
         se.id AS sales_engineer_id, se.name AS sales_engineer_name,
         COALESCE(inv.numbers, '{}') AS invoice_numbers, inv.amount::text AS invoice_amount,
         (c.billing_basis IS NULL AND c.default_visit_amount IS NULL) AS no_amount_source,
         ${reports ? SERVICE_REPORT_JSON_SQL : "NULL::jsonb"} AS service_report,
         ${SERVICE_STATUS_SQL} AS service_status,
         ${acknowledgements ? ACKNOWLEDGEMENT_SQL : "NULL"} AS acknowledgement_status,
         ${COLOUR_SQL} AS colour`;

interface AccountsRow {
  id: string;
  contract_id: string;
  contract_reference: string;
  contract_status: ContractStatus;
  client_id: string;
  client_name: string;
  system_description: string;
  system_type_id: string | null;
  system_type_name: string | null;
  maintenance_frequency: string;
  frequency_label: string | null;
  sequence_no: number;
  cycle_no: number | null;
  service_code: string | null;
  scheduled_date: string;
  status: VisitStatus;
  completed_date: string | null;
  visit_amount: string | null;
  service_report_no: string | null;
  updated_at: Date;
  manual_invoice_no: string | null;
  manual_invoice_at: Date | null;
  sales_engineer_id: string | null;
  sales_engineer_name: string | null;
  invoice_numbers: string[];
  invoice_amount: string | null;
  no_amount_source: boolean;
  service_report: unknown;
  service_status: ServiceStatus;
  acknowledgement_status: "PENDING" | "ACKNOWLEDGED" | null;
  colour: AccountsColour;
}

export interface AccountsItem {
  /** The visit id. */
  id: string;
  reference: string;
  contract: { id: string; status: ContractStatus };
  client: { id: string; name: string };
  system: { description: string; typeId: string | null; typeName: string | null };
  frequency: { code: string; label: string };
  /** Service code and contract year from migration 0076; null on older visits, which show their visit number. */
  service: { sequenceNo: number; cycleNo: number | null; serviceCode: string | null };
  scheduledDate: string;
  visitStatus: VisitStatus;
  serviceStatus: ServiceStatus;
  completedDate: string | null;
  /** amc_visits.visit_amount as a decimal string, OMR excluding VAT; null when no amount is set. */
  visitValue: string | null;
  /** amc_visits.service_report_no as entered on Service Status; null when none. */
  serviceReportNo: string | null;
  /** The manual Invoice No. of the visit: the source of the reference Paid / Unpaid status. */
  manualInvoiceNo: string | null;
  paymentStatus: PaymentStatus;
  paidAt: string | null;
  /** For the optimistic check when the manual Invoice No. is saved. */
  updatedAt: string;
  /** Every active Zoho invoice in Invoice Tracking that covers the visit, oldest first. Empty when none. Does not decide Paid / Unpaid. */
  invoiceNumbers: string[];
  /**
   * The amount of those Zoho invoices allocated to this visit (Invoice Tracking), OMR excluding VAT; null when no
   * active Zoho invoice covers it. Not the visit value, and not the contract value.
   */
  invoiceValue: string | null;
  /**
   * True when the visit has no value because its contract has neither a Billing Basis nor a Cost per Visit (the
   * approved rule: no amount is invented). Explains an empty Value column.
   */
  valueSourceMissing: boolean;
  /** The Service Report document uploaded on Service Status (0104), or null when none. Metadata only. */
  serviceReport: ServiceReport | null;
  salesEngineer: { id: string; name: string } | null;
  /**
   * Read-only: whether the invoice of this service's Invoice No. is acknowledged (Invoice Acknowledgements). Null when
   * no Invoice No. is entered, or the user may not view Invoice Acknowledgements. Never affects Paid / Unpaid.
   */
  acknowledgementStatus: "PENDING" | "ACKNOWLEDGED" | null;
  colour: AccountsColour;
}

function toItem(row: AccountsRow): AccountsItem {
  return {
    id: row.id,
    reference: row.contract_reference,
    contract: { id: row.contract_id, status: row.contract_status },
    client: { id: row.client_id, name: row.client_name },
    system: { description: row.system_description, typeId: row.system_type_id, typeName: row.system_type_name },
    frequency: { code: row.maintenance_frequency, label: row.frequency_label ?? row.maintenance_frequency },
    service: { sequenceNo: row.sequence_no, cycleNo: row.cycle_no, serviceCode: row.service_code },
    scheduledDate: row.scheduled_date,
    visitStatus: row.status,
    serviceStatus: row.service_status,
    completedDate: row.completed_date,
    visitValue: row.visit_amount,
    serviceReportNo: row.service_report_no,
    invoiceNumbers: row.invoice_numbers,
    invoiceValue: row.invoice_amount,
    valueSourceMissing: row.visit_amount === null && row.no_amount_source,
    serviceReport: toServiceReport(row.service_report),
    manualInvoiceNo: row.manual_invoice_no,
    paymentStatus: row.manual_invoice_no ? "PAID" : "UNPAID",
    paidAt: row.manual_invoice_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
    salesEngineer: row.sales_engineer_id && row.sales_engineer_name ? { id: row.sales_engineer_id, name: row.sales_engineer_name } : null,
    acknowledgementStatus: row.acknowledgement_status,
    colour: row.colour,
  };
}

export type AccountsFilters = Omit<ListAccountsQuery, "page" | "pageSize">;

/** One WHERE clause for the rows, the cards and the export, so the three always agree. */
function filterSql(query: AccountsFilters, storedReference: boolean) {
  const conditions: string[] = [IN_SCOPE];
  const params: unknown[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (query.clientId) conditions.push(`c.client_id = ${add(query.clientId)}`);
  if (query.salesEngineerId) conditions.push(`c.sales_engineer_id = ${add(query.salesEngineerId)}`);
  if (query.contractId) conditions.push(`c.id = ${add(query.contractId)}`);
  if (query.year) {
    // A date range, so the scheduled-date index can be used.
    const start = `make_date(${add(query.year)}::int, ${add(query.month ?? 1)}::int, 1)`;
    conditions.push(`v.scheduled_date >= ${start} AND v.scheduled_date < ${start} + ${query.month ? "interval '1 month'" : "interval '1 year'"}`);
  } else if (query.month) {
    conditions.push(`extract(month FROM v.scheduled_date) = ${add(query.month)}`);
  }
  if (query.serviceStatus === "COMPLETED") conditions.push("v.status = 'COMPLETED'");
  if (query.serviceStatus === "NOT_COMPLETED") conditions.push("v.status <> 'COMPLETED'");
  if (query.invoiceStatus === "RECORDED") conditions.push("v.manual_invoice_no IS NOT NULL");
  if (query.invoiceStatus === "NOT_RECORDED") conditions.push("v.manual_invoice_no IS NULL");
  if (query.search) {
    const p = add(`%${escapeLike(query.search)}%`);
    const matches = [
      `${referenceSql("c", storedReference)} ILIKE ${p}`,
      `cl.name ILIKE ${p}`,
      `v.service_report_no ILIKE ${p}`,
      `v.manual_invoice_no ILIKE ${p}`,
      `EXISTS (SELECT 1 FROM unnest(inv.numbers) AS n (number) WHERE n.number ILIKE ${p})`,
    ];

    conditions.push(`(${matches.join(" OR ")})`);
  }

  return { where: `WHERE ${conditions.join(" AND ")}`, params };
}

const ORDER = "ORDER BY v.scheduled_date, lower(cl.name), v.id";

export interface AccountsKpis {
  rows: number;
  completed: number;
  notCompleted: number;
  /** Rows with a manual Invoice No.: the Paid rows. */
  invoiceFilled: number;
  /** Sum of visit_amount over the selected rows, as a decimal string. Rows without an amount add nothing. */
  totalValue: string;
  /** Selected rows with no amount set, so the total is known to be incomplete. */
  valueMissing: number;
  /** Sum of visit_amount over the selected Paid rows (manual Invoice No. entered: a reference status, not proof of payment). */
  paidValue: string;
  /** Sum of the active Zoho invoice amounts allocated to the selected rows (Invoice Tracking), OMR excluding VAT. */
  invoiceValue: string;
  /** Selected rows covered by at least one active Zoho invoice. */
  invoiced: number;
  /** Rows by colour; red + blue + green = rows. */
  red: number;
  blue: number;
  green: number;
}

/** The card figures, over exactly the rows the filters select. rows = completed + notCompleted. */
async function kpis(where: string, params: unknown[]): Promise<AccountsKpis> {
  const result = await pool.query<{
    rows: number;
    completed: number;
    invoice_filled: number;
    total_value: string;
    value_missing: number;
    paid_value: string;
    invoice_value: string;
    invoiced: number;
    red: number;
    blue: number;
    green: number;
  }>(
    `SELECT count(*)::int AS rows,
            count(*) FILTER (WHERE v.status = 'COMPLETED')::int AS completed,
            count(*) FILTER (WHERE v.manual_invoice_no IS NOT NULL)::int AS invoice_filled,
            COALESCE(sum(v.visit_amount), 0)::numeric(16,3)::text AS total_value,
            count(*) FILTER (WHERE v.visit_amount IS NULL)::int AS value_missing,
            COALESCE(sum(v.visit_amount) FILTER (WHERE v.manual_invoice_no IS NOT NULL), 0)::numeric(16,3)::text AS paid_value,
            COALESCE(sum(inv.amount), 0)::numeric(16,3)::text AS invoice_value,
            count(*) FILTER (WHERE inv.amount IS NOT NULL)::int AS invoiced,
            count(*) FILTER (WHERE (${COLOUR_SQL}) = 'RED')::int AS red,
            count(*) FILTER (WHERE (${COLOUR_SQL}) = 'BLUE')::int AS blue,
            count(*) FILTER (WHERE (${COLOUR_SQL}) = 'GREEN')::int AS green
     ${FROM} ${where}`,
    params
  );
  const row = result.rows[0];
  const rows = row?.rows ?? 0;
  const completed = row?.completed ?? 0;

  return {
    rows,
    completed,
    notCompleted: rows - completed,
    invoiceFilled: row?.invoice_filled ?? 0,
    totalValue: row?.total_value ?? "0.000",
    valueMissing: row?.value_missing ?? 0,
    paidValue: row?.paid_value ?? "0.000",
    invoiceValue: row?.invoice_value ?? "0.000",
    invoiced: row?.invoiced ?? 0,
    red: row?.red ?? 0,
    blue: row?.blue ?? 0,
    green: row?.green ?? 0,
  };
}

/** `showAcknowledgements`: the user may view Invoice Acknowledgements (the read-only indicator is then filled in). */
export async function listAccounts(query: ListAccountsQuery, showAcknowledgements = false) {
  const storedReference = await hasStoredReference();
  const { where, params } = filterSql(query, storedReference);
  const acknowledgements = showAcknowledgements && (await schemaHas(["ack_invoices", "ack_invoice_services"]));
  const [figures, rows] = await Promise.all([
    kpis(where, params),
    pool.query<AccountsRow>(`${selectSql(storedReference, await serviceReportsAvailable(), acknowledgements)} ${FROM} ${where} ${ORDER} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [
      ...params,
      query.pageSize,
      (query.page - 1) * query.pageSize,
    ]),
  ]);

  return { items: rows.rows.map(toItem), total: figures.rows, page: query.page, pageSize: query.pageSize, kpis: figures };
}

/**
 * Every visit that matches the filters, in the page's order, for an export.
 * `checkSize` is given the number of rows before any is read and throws when
 * the export cannot hold that many.
 */
export async function listAllAccounts(filters: AccountsFilters, checkSize: (count: number) => void) {
  const storedReference = await hasStoredReference();
  const { where, params } = filterSql(filters, storedReference);
  const figures = await kpis(where, params);

  checkSize(figures.rows);

  const rows = await pool.query<AccountsRow>(`${selectSql(storedReference, await serviceReportsAvailable())} ${FROM} ${where} ${ORDER}`, params);

  return { items: rows.rows.map(toItem), kpis: figures };
}

/** The filter lists are those of Master AMC Status (the same visits, so the same clients, engineers and years), plus the contracts with visits on the page. */
export async function getAccountsOptions() {
  const storedReference = await hasStoredReference();
  const [shared, contracts] = await Promise.all([
    getMasterStatusOptions(),
    pool.query<{ id: string; reference: string; client_name: string; system_description: string }>(
      `SELECT c.id, ${referenceSql("c", storedReference)} AS reference, cl.name AS client_name, c.system_description
       FROM amc_contracts c JOIN clients cl ON cl.id = c.client_id
       WHERE EXISTS (SELECT 1 FROM amc_visits v WHERE v.amc_contract_id = c.id AND ${IN_SCOPE})
       ORDER BY c.id`
    ),
  ]);

  return {
    ...shared,
    contracts: contracts.rows.map((row) => ({ id: row.id, reference: row.reference, client: row.client_name, system: row.system_description })),
  };
}

/**
 * The Service Report document of ONE visit shown on Accounts, for the page's read-only viewer and its Download
 * (client fixes, 2026-11-09). Only a visit in Accounts' own scope is served, so the viewer can never reach a report
 * the page does not list. The file is read through the private document storage and checked against its checksum.
 */
export async function readAccountsServiceReport(visitId: string) {
  const visit = await pool.query(`SELECT 1 FROM amc_visits v JOIN amc_contracts c ON c.id = v.amc_contract_id WHERE v.id = $1 AND ${IN_SCOPE}`, [visitId]);

  if (visit.rowCount === 0) throw notFound("AMC visit not found.");

  return readServiceReport(visitId);
}

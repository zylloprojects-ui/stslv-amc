import type { PermissionKey } from "./permissions";

// Role visibility (owner request 2026-11-21): inside a page a role may open, Roles & Permissions can hide single
// parts of it from that role: a Dashboard row or panel, a column of a table, or an action such as a download.
// Page access itself stays with the permissions (MODULE:ACTION); this only takes away within a page, never gives.
//
// Rules:
//   * Everything is visible until it is hidden: a role with nothing stored sees every page exactly as before.
//   * Only the items listed here can be hidden; any other key is refused (deny by default, as with permissions).
//   * The API enforces it: a hidden item's data is left out of the page's response and its downloads, and a hidden
//     action is refused. The web app only hides what the API no longer sends.
//   * A user holding several roles sees an item when ANY of their roles that may open the page shows it (the same
//     union as permissions). Super Admin hides nothing.
//
// The keys are stored in role_hidden_items (migration 0123), so a key never changes once released.

export type VisibilityKind = "row" | "panel" | "column" | "action";

export interface VisibilityItem {
  key: string;
  label: string;
  kind: VisibilityKind;
  /** What hiding it does, for the Roles & Permissions screen. */
  description?: string;
}

export interface VisibilityGroup {
  title: string;
  items: VisibilityItem[];
}

export interface VisibilitySection {
  id: string;
  title: string;
  /** The page the items belong to. */
  page: { label: string; path: string };
  /** The permission that opens the page: only a role holding it is affected by these items. */
  requires: PermissionKey;
  groups: VisibilityGroup[];
}

export const VISIBILITY_CATALOG: VisibilitySection[] = [
  {
    id: "dashboard",
    title: "Dashboard",
    page: { label: "Dashboard", path: "/dashboard" },
    requires: "DASHBOARD:VIEW",
    groups: [
      {
        title: "Key figure rows",
        items: [
          { key: "dashboard.row.portfolio", label: "Row 1 · AMC Portfolio", kind: "row", description: "Active AMCs, Annual AMC Value, Final Credit, Expiring ≤45 Days" },
          { key: "dashboard.row.month", label: "Row 2 · Current Month", kind: "row", description: "Services this month, pending, Invoices Generated / Not Generated" },
          { key: "dashboard.row.ytd", label: "Row 3 · Current Year (YTD)", kind: "row", description: "Services and invoices from January 1 through today" },
          { key: "dashboard.row.tillDate", label: "Row 4 · Overall Till Date", kind: "row", description: "Services and invoices from each contract's start through today" },
          { key: "dashboard.row.overall", label: "Row 5 · Overall Contract", kind: "row", description: "Every service of the contracts, including visits ahead" },
        ],
      },
      {
        title: "Panels",
        items: [
          { key: "dashboard.panel.calendar", label: "AMC Maintenance Calendar", kind: "panel" },
          { key: "dashboard.panel.workload", label: "Upcoming Service Workload", kind: "panel" },
          { key: "dashboard.panel.paymentTrend", label: "Payment Trend", kind: "panel" },
        ],
      },
    ],
  },
  {
    id: "invoices",
    title: "Accounts › Invoices",
    page: { label: "Invoices", path: "/finance/accounts" },
    requires: "ACCOUNTS:VIEW",
    // AMC Reference, Scheduled Month and Service Status (with the row colour) define a row and always stay.
    groups: [
      {
        title: "Columns",
        items: [
          { key: "invoices.column.client", label: "Client", kind: "column" },
          { key: "invoices.column.system", label: "System", kind: "column" },
          { key: "invoices.column.frequency", label: "Frequency", kind: "column" },
          { key: "invoices.column.service", label: "Service", kind: "column" },
          { key: "invoices.column.serviceReportNo", label: "Service Report No.", kind: "column" },
          { key: "invoices.column.serviceReport", label: "Service Report", kind: "column", description: "Also stops viewing and downloading the report" },
          { key: "invoices.column.amcContract", label: "AMC Contract", kind: "column", description: "Also stops downloading the contract" },
          { key: "invoices.column.salesEngineer", label: "Sales Engineer", kind: "column" },
          { key: "invoices.column.serviceEngineer", label: "Service Engineer", kind: "column" },
          { key: "invoices.column.amcValue", label: "AMC Value (ex VAT)", kind: "column", description: "Excel download only; the page does not show it" },
          { key: "invoices.column.visitValue", label: "Service Value (ex VAT)", kind: "column", description: "Also hides the Total Value card, the value totals and AMC Value / Year" },
          { key: "invoices.column.invoiceNo", label: "Invoice No.", kind: "column", description: "Also hides the Zoho invoice numbers and the Invoice No. field on this page. The row colour still shows Paid / Unpaid" },
          { key: "invoices.column.invoiceValue", label: "Zoho Invoice Value (ex VAT)", kind: "column" },
        ],
      },
      {
        title: "Actions",
        items: [
          { key: "invoices.action.downloadContract", label: "Download AMC contract", kind: "action", description: "Without access to the AMC Contracts page" },
          { key: "invoices.action.serviceReport", label: "View and download Service Report", kind: "action" },
        ],
      },
    ],
  },
];

// Phase 2 (2026-11-21): Master AMC Status, Service Status and AMC Management. Only columns shown read-only on the page
// are hideable: a column edited on the page (Service Status' report number, engineer, working days, manpower, report)
// is not, so that hiding it can never lead to a save without it.
VISIBILITY_CATALOG.push(
  {
    id: "masterStatus",
    title: "Master AMC Status",
    page: { label: "Master AMC Status", path: "/amc/master-status" },
    requires: "MASTER_AMC_STATUS:VIEW",
    // AMC Reference, Scheduled Month and Service Status (with the row colour) define a row and always stay.
    groups: [
      {
        title: "Columns",
        items: [
          { key: "masterStatus.column.client", label: "Client", kind: "column" },
          { key: "masterStatus.column.system", label: "System", kind: "column" },
          { key: "masterStatus.column.frequency", label: "Frequency", kind: "column" },
          { key: "masterStatus.column.service", label: "Service", kind: "column" },
          { key: "masterStatus.column.visitValue", label: "Value (ex VAT)", kind: "column", description: "Also hides the Total Value card, the value totals and AMC Value / Year" },
          { key: "masterStatus.column.serviceEngineer", label: "Service Engineer", kind: "column" },
          { key: "masterStatus.column.invoiceNo", label: "Invoice No.", kind: "column", description: "Also hides the Zoho invoice numbers and references. The row colour still shows the status" },
          { key: "masterStatus.column.quotationNo", label: "Quote No.", kind: "column" },
          { key: "masterStatus.column.acknowledgement", label: "Invoice Acknowledged", kind: "column" },
          { key: "masterStatus.column.salesEngineer", label: "Sales Engineer", kind: "column" },
        ],
      },
    ],
  },
  {
    id: "serviceStatus",
    title: "Service Status",
    page: { label: "Service Status", path: "/amc/service-status" },
    requires: "SERVICE_STATUS:VIEW",
    // Columns edited on this page (report number, Service Engineer, working days, manpower, Service Report) are not
    // hideable; AMC Reference, Scheduled Month / Due Date and Service Status always stay.
    groups: [
      {
        title: "Columns",
        items: [
          { key: "serviceStatus.column.client", label: "Client", kind: "column" },
          { key: "serviceStatus.column.system", label: "System", kind: "column" },
          { key: "serviceStatus.column.frequency", label: "Frequency", kind: "column" },
          { key: "serviceStatus.column.service", label: "Service", kind: "column" },
          { key: "serviceStatus.column.amcValue", label: "AMC Value (ex VAT)", kind: "column", description: "Also hides its total" },
          { key: "serviceStatus.column.serviceValue", label: "Service Value (ex VAT)", kind: "column", description: "Also hides its total" },
          { key: "serviceStatus.column.acknowledgement", label: "Invoice Acknowledgement", kind: "column" },
          { key: "serviceStatus.column.engineer", label: "Sales Engineer", kind: "column" },
        ],
      },
    ],
  },
  {
    id: "amcManagement",
    title: "AMC Management",
    page: { label: "AMC Management", path: "/amc/management" },
    requires: "AMC_CONTRACTS:VIEW",
    groups: [
      {
        title: "Key figure groups",
        items: [
          { key: "amcManagement.group.contracts", label: "Contract KPIs", kind: "row", description: "Active AMCs, Annual AMC Value, Final Credit, Expiring" },
          { key: "amcManagement.group.schedule", label: "Schedule KPIs", kind: "row" },
          { key: "amcManagement.group.invoices", label: "Invoice KPIs", kind: "row" },
        ],
      },
      {
        title: "Panels",
        items: [
          { key: "amcManagement.panel.recentContracts", label: "Recent AMC Contracts", kind: "panel" },
          { key: "amcManagement.panel.expiry", label: "Expiry & Renewal", kind: "panel" },
        ],
      },
    ],
  }
);

// Phase 3 (2026-11-21): Invoice Acknowledgements, Service Sales, AMC Renewals and Reports. Fields that an action of the
// page works from (the acknowledgement document, Service Sales' Quote No.) are not hideable.
VISIBILITY_CATALOG.push(
  {
    id: "invoiceAcks",
    title: "Accounts › Invoice Acknowledgements",
    page: { label: "Invoice Acknowledgements", path: "/finance/invoice-acknowledgements" },
    requires: "INVOICE_ACKNOWLEDGEMENTS:VIEW",
    // Invoice No., the acknowledgement status, the services and the document always stay: the actions work from them.
    groups: [
      {
        title: "Columns",
        items: [
          { key: "invoiceAcks.column.client", label: "Client", kind: "column" },
          { key: "invoiceAcks.column.contract", label: "AMC Contract", kind: "column" },
          { key: "invoiceAcks.column.invoiceDate", label: "Invoice Date", kind: "column" },
          { key: "invoiceAcks.column.invoiceValue", label: "Invoice Value", kind: "column", description: "Also hides its total, here and in the linked services" },
          { key: "invoiceAcks.column.serviceValue", label: "Service Value", kind: "column", description: "Also hides its total and the values in Linked Services" },
          { key: "invoiceAcks.column.acknowledgedAt", label: "Acknowledged On", kind: "column" },
          { key: "invoiceAcks.column.acknowledgedBy", label: "Acknowledged By", kind: "column" },
          { key: "invoiceAcks.column.uploadedBy", label: "Uploaded By", kind: "column" },
        ],
      },
    ],
  },
  {
    id: "serviceSales",
    title: "Service Sales",
    page: { label: "Service Sales", path: "/amc/service-sales" },
    requires: "SERVICES_SALES:VIEW",
    // AMC Reference, Due Date and Service Status define a row; Quote No. is entered on this page and always stays.
    groups: [
      {
        title: "Columns",
        items: [
          { key: "serviceSales.column.client", label: "Client", kind: "column" },
          { key: "serviceSales.column.system", label: "System", kind: "column" },
          { key: "serviceSales.column.frequency", label: "Frequency", kind: "column" },
          { key: "serviceSales.column.service", label: "Service", kind: "column" },
          { key: "serviceSales.column.serviceReportNo", label: "Service Report No.", kind: "column" },
          { key: "serviceSales.column.serviceReport", label: "Service Report", kind: "column", description: "Also stops viewing and downloading the report" },
          { key: "serviceSales.column.serviceEngineer", label: "Service Engineer", kind: "column" },
          { key: "serviceSales.column.salesEngineer", label: "Sales Engineer", kind: "column" },
          { key: "serviceSales.column.amcValue", label: "AMC Value (ex VAT)", kind: "column", description: "Downloads only, with its total" },
          { key: "serviceSales.column.serviceValue", label: "Service Value (ex VAT)", kind: "column", description: "Downloads only" },
        ],
      },
    ],
  },
  {
    id: "amcRenewal",
    title: "AMC Renewals",
    page: { label: "AMC Renewals", path: "/amc/renewal" },
    requires: "AMC_RENEWAL:VIEW",
    // AMC Reference, Expiry and the renewal status define a row and always stay.
    groups: [
      {
        title: "Columns",
        items: [
          { key: "amcRenewal.column.client", label: "Client", kind: "column" },
          { key: "amcRenewal.column.system", label: "System", kind: "column" },
          { key: "amcRenewal.column.frequency", label: "Frequency", kind: "column" },
          { key: "amcRenewal.column.service", label: "Services", kind: "column" },
          { key: "amcRenewal.column.contractStatus", label: "Contract Status", kind: "column" },
          { key: "amcRenewal.column.amount", label: "AMC Value", kind: "column" },
          { key: "amcRenewal.column.remarks", label: "Remarks", kind: "column" },
        ],
      },
      { title: "Panels", items: [{ key: "amcRenewal.panel.history", label: "Renewal History", kind: "panel", description: "Also its download" }] },
    ],
  },
  {
    id: "reports",
    title: "Reports",
    page: { label: "Reports", path: "/reports" },
    requires: "REPORTS:VIEW",
    groups: [
      {
        title: "Reports",
        items: [
          { key: "reports.report.contractSummary", label: "AMC Contract Summary", kind: "panel" },
          { key: "reports.report.scheduledServices", label: "Billing Schedule", kind: "panel" },
          { key: "reports.report.completedServices", label: "Completed Services", kind: "panel" },
          { key: "reports.report.pendingServices", label: "Pending Services", kind: "panel" },
          { key: "reports.report.monthlyMaintenance", label: "Monthly Maintenance", kind: "panel" },
          { key: "reports.report.renewal", label: "AMC Renewal", kind: "panel" },
          { key: "reports.report.expiryRenewal", label: "Expiry & Renewal Due", kind: "panel" },
          { key: "reports.report.renewalHistory", label: "Renewal History", kind: "panel" },
          { key: "reports.report.accounts", label: "Accounts / Paid and Unpaid Summary", kind: "panel" },
          { key: "reports.report.clientSummary", label: "Client-wise Summary", kind: "panel" },
          { key: "reports.report.engineerSummary", label: "Sales Engineer-wise Summary", kind: "panel" },
          { key: "reports.report.contractValueReview", label: "Contract Value Review", kind: "panel" },
        ],
      },
    ],
  }
);

export const VISIBILITY_KEYS: ReadonlySet<string> = new Set(VISIBILITY_CATALOG.flatMap((section) => section.groups.flatMap((group) => group.items.map((item) => item.key))));

/** The section an item belongs to. */
export function sectionOfItem(key: string): VisibilitySection | undefined {
  return VISIBILITY_CATALOG.find((section) => section.groups.some((group) => group.items.some((item) => item.key === key)));
}

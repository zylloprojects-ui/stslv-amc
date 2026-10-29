import type { Action, Module } from "./permissions";

// What each permission module governs in the current application: the pages it
// opens and the actions the code actually checks. Roles & Permissions is drawn
// from this, and only the actions listed here can be granted. Any other
// module/action pair has no effect anywhere, so it is not offered (deny by default).
//
// This describes the permissions; it grants nothing. The grants live in
// role_permissions. tests/permission-catalog.test.ts checks this file against
// every authorize() and permission check in the API and the web app.

export interface CatalogPage {
  label: string;
  path: string;
  /** Further modules the user must also be able to view, for a page that shows data of several modules. */
  alsoRequires?: Module[];
}

export interface CatalogModule {
  module: Module;
  label: string;
  description: string;
  pages: CatalogPage[];
  /** The actions the application checks for this module, each with what it allows. */
  actions: Partial<Record<Action, string>>;
}

export interface CatalogSection {
  title: string;
  /** Modules whose pages were removed from the application. Existing grants are kept and shown, but no new grant is accepted. */
  retired?: true;
  modules: CatalogModule[];
}

export const PERMISSION_CATALOG: CatalogSection[] = [
  {
    title: "Dashboard",
    modules: [
      {
        module: "DASHBOARD",
        label: "Dashboard",
        description: "The AMC Operations Dashboard. Each panel also needs view access to its own module.",
        pages: [{ label: "Dashboard", path: "/dashboard" }],
        actions: { VIEW: "Open the Dashboard" },
      },
    ],
  },
  {
    title: "Master Data Center",
    modules: [
      {
        module: "CLIENTS",
        label: "Clients",
        description: "The client master and Client 360.",
        pages: [
          { label: "Clients", path: "/clients" },
          { label: "Client 360", path: "/clients/:id" },
        ],
        actions: {
          VIEW: "See clients and Client 360",
          CREATE: "Add clients",
          EDIT: "Edit client details",
          DELETE: "Deactivate and reactivate clients (nothing is deleted)",
          EXPORT: "Export the client list",
        },
      },
      {
        module: "SALES_ENGINEERS",
        label: "Sales Engineers",
        description: "The engineer master and Engineer 360. View also lets the Departments page list a department's engineers.",
        pages: [
          { label: "Sales Engineers", path: "/master-data/sales-engineers" },
          { label: "Engineer 360", path: "/master-data/sales-engineers/:id" },
        ],
        actions: {
          VIEW: "See sales engineers and Engineer 360",
          CREATE: "Add sales engineers",
          EDIT: "Edit and disable sales engineers",
          EXPORT: "Export the sales engineer list",
        },
      },
      {
        module: "SYSTEM_TYPES",
        label: "System Types",
        description: "The system type master.",
        pages: [{ label: "System Types", path: "/master-data/system-types" }],
        actions: {
          VIEW: "See system types",
          CREATE: "Add system types",
          EDIT: "Edit and disable system types",
          DELETE: "Delete a system type no contract uses",
          EXPORT: "Export the system type list",
        },
      },
      {
        module: "MAINTENANCE_FREQUENCIES",
        label: "Maintenance Frequencies",
        description: "The frequency master that schedule generation follows.",
        pages: [{ label: "Maintenance Frequencies", path: "/master-data/maintenance-frequencies" }],
        actions: {
          VIEW: "See maintenance frequencies",
          CREATE: "Add frequencies",
          EDIT: "Edit, disable and archive frequencies",
          EXPORT: "Export the frequency list",
        },
      },
      {
        module: "DEPARTMENTS",
        label: "Departments",
        description: "The department master. View also lets the Sales Engineers page filter and assign by department.",
        pages: [{ label: "Departments", path: "/master-data/departments" }],
        actions: {
          VIEW: "See departments",
          CREATE: "Add departments",
          EDIT: "Edit and disable departments",
          EXPORT: "Export the department list",
        },
      },
    ],
  },
  {
    title: "AMC Operations",
    modules: [
      {
        module: "AMC_CONTRACTS",
        label: "AMC Contracts",
        description: "Contracts and their schedule generation. View also lets contract users read the master lists to pick from.",
        pages: [
          { label: "AMC Management", path: "/amc/management" },
          { label: "AMC Contracts", path: "/amc/contracts" },
          { label: "Contract details", path: "/amc/contracts/:id" },
        ],
        actions: {
          VIEW: "See contracts and AMC Management",
          CREATE: "Add contracts",
          EDIT: "Edit contracts, change their status, generate schedules, link master records",
          DELETE: "Cancel contracts, also from AMC Renewal (nothing is deleted; also needs Edit)",
          EXPORT: "Export a client's contracts",
        },
      },
      {
        module: "AMC_RENEWAL",
        label: "AMC Renewal",
        description: "The renewal queue and renewal history.",
        pages: [{ label: "AMC Renewal", path: "/amc/renewal" }],
        actions: {
          VIEW: "See the renewal queue and history",
          CREATE: "Renew a contract, from AMC Renewal or the contract page",
          EXPORT: "Export the renewal queue and history",
        },
      },
      {
        module: "AMC_SCHEDULE",
        label: "AMC Schedule",
        description: "Scheduled maintenance visits.",
        pages: [
          { label: "AMC Schedule", path: "/amc/schedule" },
          { label: "Master AMC Status", path: "/amc/master-status", alsoRequires: ["INVOICES", "SERVICES_SALES"] },
        ],
        actions: {
          VIEW: "See the visit schedule",
          EDIT: "Edit scheduled visits, also from the Monthly Calendar",
          EXPORT: "Export the schedule and Master AMC Status",
        },
      },
      {
        module: "MONTHLY_CALENDAR",
        label: "Monthly Calendar",
        description: "Visits by year and by month.",
        pages: [{ label: "Monthly Calendar", path: "/amc/calendar" }],
        actions: {
          VIEW: "See the Monthly Calendar",
          EXPORT: "Download a month's visits",
        },
      },
      {
        module: "SERVICE_STATUS",
        label: "Service Status",
        description: "One row per scheduled service. Saving a row is a visit execution action.",
        pages: [{ label: "Service Status", path: "/amc/service-status" }],
        actions: {
          VIEW: "See Service Status",
          EXPORT: "Export Service Status",
        },
      },
      {
        module: "AMC_EXECUTION",
        label: "AMC Visit Execution",
        description: "Carrying out visits: the visit actions on AMC Schedule and Service Status. It has no page of its own.",
        pages: [],
        actions: {
          VIEW: "See visits as work to carry out",
          EDIT: "Record execution: start, postpone and complete visits, service report numbers",
          APPROVE: "Reopen a completed visit",
        },
      },
      {
        module: "SERVICES_SALES",
        label: "Services Sales",
        description: "Quotation numbers of completed visits.",
        pages: [
          { label: "Services Sales", path: "/amc/services-sales" },
          { label: "Master AMC Status", path: "/amc/master-status", alsoRequires: ["AMC_SCHEDULE", "INVOICES"] },
        ],
        actions: {
          VIEW: "See quotation numbers",
          EDIT: "Record quotation numbers",
          EXPORT: "Export Services Sales",
        },
      },
    ],
  },
  {
    title: "Finance",
    modules: [
      {
        module: "INVOICES",
        label: "Invoice Tracking",
        description: "Zoho invoice details recorded against completed work, and the Accounts reconciliation.",
        pages: [
          { label: "Invoice Tracking", path: "/invoices" },
          { label: "Accounts", path: "/finance/accounts", alsoRequires: ["AMC_SCHEDULE"] },
        ],
        actions: {
          VIEW: "See invoice records",
          CREATE: "Record Zoho invoices",
          EDIT: "Edit and cancel invoice records",
          EXPORT: "Export invoices and Accounts",
        },
      },
    ],
  },
  {
    title: "Administration",
    modules: [
      {
        module: "USERS",
        label: "Users & Access",
        description: "People, roles and their permissions. Nobody can grant a permission or role beyond their own.",
        pages: [
          { label: "Users & Access", path: "/admin/users" },
          { label: "Roles & Permissions", path: "/admin/roles" },
          { label: "Login History", path: "/admin/login-history" },
        ],
        actions: {
          VIEW: "See users, roles and login history",
          CREATE: "Add users and roles",
          EDIT: "Edit users, activate and deactivate accounts, assign roles, change role permissions, reset passwords",
          DELETE: "Delete unused roles",
          APPROVE: "Approve or reject sign-up requests",
        },
      },
      {
        module: "SETTINGS",
        label: "Settings",
        description: "The Settings page: the holiday calendar and organisation details.",
        pages: [{ label: "Settings", path: "/settings" }],
        actions: {
          VIEW: "See Settings and the holiday calendar",
          CREATE: "Add holidays",
          EDIT: "Edit holidays",
          DELETE: "Delete holidays",
        },
      },
    ],
  },
  {
    title: "Retired modules",
    retired: true,
    modules: [
      {
        module: "PROJECTS",
        label: "Projects",
        description: "No page in the current application. The API is still running; the Settings VAT rate panel reads it.",
        pages: [],
        actions: { VIEW: "Read projects through the API", CREATE: "Add projects; read project defaults (VAT rate)", EDIT: "Edit projects" },
      },
      {
        module: "PROCUREMENT",
        label: "Procurement",
        description: "No page in the current application. The API is still running.",
        pages: [],
        actions: { VIEW: "Read procurement requests through the API", CREATE: "Add procurement requests", EDIT: "Edit procurement requests" },
      },
      {
        module: "EXPENSES",
        label: "Expenses",
        description: "No page in the current application. The API is still running.",
        pages: [],
        actions: { VIEW: "Read expenses through the API", CREATE: "Add expenses", EDIT: "Edit expenses", DELETE: "Void expenses" },
      },
      {
        module: "HISTORICAL_DATA",
        label: "Historical Data",
        description: "Review of the earlier Excel import. No page in the current application. The API is still running.",
        pages: [],
        actions: { VIEW: "Read the historical import review through the API" },
      },
      {
        module: "REPORTS",
        label: "Reports",
        description: "Not checked anywhere in the application: a grant has no effect.",
        pages: [],
        actions: {},
      },
    ],
  },
];

/** Access no role can be granted or refused: it follows from being signed in, or from holding the built-in Admin role. */
export const FIXED_ACCESS = {
  adminOnly: [
    { label: "Audit Log", path: "/admin/audit-log" },
    { label: "Suggestions Review", path: "/admin/suggestions" },
    { label: "System readiness (Dashboard)", path: "/dashboard" },
    { label: "Historical import audit", path: "/api/historical-data/audit" },
  ],
  everyone: [
    { label: "Notifications (only for the modules the user may view)", path: "/notifications" },
    { label: "My Suggestions and the suggestion popup", path: "/suggestions" },
    { label: "My account", path: "/account" },
  ],
};

const RETIRED = new Set<Module>(PERMISSION_CATALOG.filter((section) => section.retired).flatMap((section) => section.modules.map((entry) => entry.module)));

const ENTRIES = new Map<Module, CatalogModule>(PERMISSION_CATALOG.flatMap((section) => section.modules.map((entry) => [entry.module, entry] as const)));

/** Whether the application checks this permission anywhere (retired modules included). */
export function isUsed(module: Module, action: Action): boolean {
  return ENTRIES.get(module)?.actions[action] !== undefined;
}

/** Whether a role may newly be given this permission: it must be used by a current module. */
export function isGrantable(module: Module, action: Action): boolean {
  return !RETIRED.has(module) && isUsed(module, action);
}

import { shows, type AuthContext } from "../auth/access";
import type { AccountsColumn } from "./accounts.schemas";

// Role visibility on Accounts › Invoices (migration 0123, shared/visibility-catalog.ts). A column hidden from the
// user's role is left out of the page data, its downloads and the export; a hidden action is refused. The row itself
// (AMC Reference, Scheduled Month, Service Status and its colour) always stays: it is what a row is.

/** The page columns role visibility can hide: the export's hideable columns plus the two page-only document columns. */
export const ROLE_HIDEABLE_COLUMNS = [
  "client",
  "system",
  "frequency",
  "service",
  "serviceReportNo",
  "serviceReport",
  "amcContract",
  "salesEngineer",
  "serviceEngineer",
  "amcValue",
  "visitValue",
  "invoiceNo",
  "invoiceValue",
] as const;
export type RoleHideableColumn = (typeof ROLE_HIDEABLE_COLUMNS)[number];

/** The columns hidden from this user by their role. */
export function roleHiddenColumns(auth: Pick<AuthContext, "hidden">): Set<RoleHideableColumn> {
  return new Set(ROLE_HIDEABLE_COLUMNS.filter((column) => !shows(auth, `invoices.column.${column}`)));
}

/** The hidden columns the export knows (it has no document columns). */
export function exportColumnsOf(hidden: ReadonlySet<RoleHideableColumn>): AccountsColumn[] {
  return [...hidden].filter((column) => column !== "serviceReport" && column !== "amcContract") as AccountsColumn[];
}

/** Downloading the contract document: the AMC Contract column and the Download AMC contract action. */
export const mayDownloadContract = (auth: Pick<AuthContext, "hidden">) => shows(auth, "invoices.column.amcContract") && shows(auth, "invoices.action.downloadContract");

/** Viewing or downloading the Service Report: its column and the action. */
export const mayOpenServiceReport = (auth: Pick<AuthContext, "hidden">) => shows(auth, "invoices.column.serviceReport") && shows(auth, "invoices.action.serviceReport");

// Which scheduled services count, and how cancelled contracts are treated: ONE rule for the
// Dashboard cards, Service Status, Accounts, Master AMC Status, AMC Management and the
// workload chart, so their service counts and Paid / Unpaid totals always reconcile.
//
// A service (amc_visits row `v`, its contract `c`) is in scope when:
//   * its status is Scheduled, In Progress, Postponed or Completed. Cancelled visits and
//     imported Historical periods are never counted; and
//   * its contract is not Cancelled, OR the service is Completed, OR it carries a manual
//     Invoice No. (reference status Paid).
//
// So cancelling a contract removes its outstanding unpaid work from every figure, but never
// hides work that was carried out or a Paid record: those stay visible in Accounts and in the
// Paid totals, with their amounts, numbers and history unchanged (P1 fixes, 2026-11-09).
// Within scope, a service is Completed or Pending (Scheduled, In Progress, Postponed):
// Overall = Completed + Pending and Overall = Invoices Generated + Invoices Not Generated.
//
// Draft, Active and Expired contracts are all counted the same way. Contracts in the Recycle
// Bin and their services are already outside the amc_contracts / amc_visits views.

/** The statuses a counted service can have. */
export const SCOPE_VISIT_STATUSES = ["SCHEDULED", "IN_PROGRESS", "POSTPONED", "COMPLETED"] as const;

const STATUS_IN_SCOPE = "v.status IN ('SCHEDULED', 'IN_PROGRESS', 'POSTPONED', 'COMPLETED')";
/** Carried out or Paid: kept whatever happened to the contract afterwards. */
const KEPT_ON_CANCELLED = "(v.status = 'COMPLETED' OR v.manual_invoice_no IS NOT NULL)";

/** For a query that joins the visit `v` to its contract `c`. */
export const SERVICE_IN_SCOPE = `${STATUS_IN_SCOPE} AND (${KEPT_ON_CANCELLED} OR c.status <> 'CANCELLED')`;

/** The same rule for a query over `amc_visits v` alone (no contract join). */
export const SERVICE_IN_SCOPE_VISIT_ONLY = `${STATUS_IN_SCOPE} AND (${KEPT_ON_CANCELLED}
  OR EXISTS (SELECT 1 FROM amc_contracts cc WHERE cc.id = v.amc_contract_id AND cc.status <> 'CANCELLED'))`;

/** Of the services in scope, those not yet completed. */
export const SERVICE_PENDING = "v.status IN ('SCHEDULED', 'IN_PROGRESS', 'POSTPONED')";

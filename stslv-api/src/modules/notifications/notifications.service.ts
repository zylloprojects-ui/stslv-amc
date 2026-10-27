import { pool } from "../../config/database";
import { notFound } from "../../shared/errors";
import { displayMoney } from "../../shared/export/report";
import { getAmcSummary } from "../amc/summary.service";
import type { AuthContext } from "../auth/access";
import { getInvoiceSummary } from "../invoices/invoices.service";

// In-app alerts. Every alert is a figure the application already defines and
// shows elsewhere (the AMC and Invoice Tracking summaries), worked out on
// request for the signed-in user's permissions. No threshold is introduced
// here. Expiry warnings ahead of the end date wait for the business to confirm
// its warning periods.

export interface Alert {
  key: string;
  severity: "warning" | "info";
  title: string;
  message: string;
  /** Where the related records are listed. */
  link: string;
  count: number;
  isRead: boolean;
  readAt: string | null;
}

interface Candidate {
  key: string;
  severity: Alert["severity"];
  title: string;
  message: string;
  link: string;
  count: number;
  /** Changes whenever the alert's state changes, so a read alert shows again. */
  fingerprint: string;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

async function candidates(auth: AuthContext): Promise<Candidate[]> {
  const list: Candidate[] = [];
  const amc =
    auth.permissions.has("AMC_CONTRACTS:VIEW") || auth.permissions.has("AMC_SCHEDULE:VIEW") || auth.permissions.has("AMC_EXECUTION:VIEW")
      ? await getAmcSummary(auth, 30)
      : null;

  if (amc?.visits && amc.visits.overdue > 0) {
    list.push({
      key: "visits.overdue",
      severity: "warning",
      title: "Overdue maintenance visits",
      message: `${plural(amc.visits.overdue, "visit is", "visits are")} past the planned date and not completed.`,
      link: "/amc/schedule",
      count: amc.visits.overdue,
      fingerprint: `${amc.asOf}:${amc.visits.overdue}`,
    });
  }
  if (amc?.contracts && amc.contracts.activePastValidity > 0) {
    list.push({
      key: "contracts.past_validity",
      severity: "warning",
      title: "Active contracts past their validity",
      message: `${plural(amc.contracts.activePastValidity, "contract has", "contracts have")} passed the end of validity and ${amc.contracts.activePastValidity === 1 ? "is" : "are"} still marked Active.`,
      link: "/reports",
      count: amc.contracts.activePastValidity,
      fingerprint: String(amc.contracts.activePastValidity),
    });
  }
  if (amc?.invoicing && amc.invoicing.readyForInvoice.count > 0) {
    list.push({
      key: "invoicing.amc_ready",
      severity: "info",
      title: "AMC visits ready for invoice",
      message: `${plural(amc.invoicing.readyForInvoice.count, "completed visit is", "completed visits are")} waiting for an invoice (visit amounts ${displayMoney(amc.invoicing.readyForInvoice.amount)}).`,
      link: auth.permissions.has("INVOICES:VIEW") ? "/invoices" : "/amc/schedule",
      count: amc.invoicing.readyForInvoice.count,
      fingerprint: `${amc.invoicing.readyForInvoice.count}:${amc.invoicing.readyForInvoice.amount}`,
    });
  }

  if (auth.permissions.has("INVOICES:VIEW")) {
    const invoices = await getInvoiceSummary(auth);

    if (invoices.projects && invoices.projects.pending.count > 0) {
      list.push({
        key: "invoicing.projects_ready",
        severity: "info",
        title: "Projects waiting for an invoice",
        message: `${plural(invoices.projects.pending.count, "completed project has", "completed projects have")} job value not yet invoiced (${displayMoney(invoices.projects.pending.uninvoicedValue)} excl. VAT).`,
        link: "/invoices",
        count: invoices.projects.pending.count,
        fingerprint: `${invoices.projects.pending.count}:${invoices.projects.pending.uninvoicedValue}`,
      });
    }
  }

  return list;
}

async function readMarks(userId: string): Promise<Map<string, { fingerprint: string; readAt: Date }>> {
  const result = await pool.query<{ alert_key: string; fingerprint: string; read_at: Date }>(
    "SELECT alert_key, fingerprint, read_at FROM notification_reads WHERE user_id = $1",
    [userId]
  );

  return new Map(result.rows.map((row) => [row.alert_key, { fingerprint: row.fingerprint, readAt: row.read_at }]));
}

export async function listAlerts(auth: AuthContext) {
  const [current, marks] = await Promise.all([candidates(auth), readMarks(auth.user.id)]);
  const items: Alert[] = current.map((candidate) => {
    const mark = marks.get(candidate.key);
    const isRead = mark?.fingerprint === candidate.fingerprint;

    return {
      key: candidate.key,
      severity: candidate.severity,
      title: candidate.title,
      message: candidate.message,
      link: candidate.link,
      count: candidate.count,
      isRead,
      readAt: isRead && mark ? mark.readAt.toISOString() : null,
    };
  });

  return { items, unreadCount: items.filter((item) => !item.isRead).length };
}

async function markRead(userId: string, candidate: Candidate): Promise<void> {
  await pool.query(
    `INSERT INTO notification_reads (user_id, alert_key, fingerprint) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, alert_key) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, read_at = now()`,
    [userId, candidate.key, candidate.fingerprint]
  );
}

/** Marks one current alert read for this user. An alert the user cannot see is "not found". */
export async function markAlertRead(auth: AuthContext, key: string) {
  const candidate = (await candidates(auth)).find((item) => item.key === key);

  if (!candidate) {
    throw notFound("There is no such alert for you at the moment.");
  }

  await markRead(auth.user.id, candidate);

  return listAlerts(auth);
}

export async function markAllAlertsRead(auth: AuthContext) {
  for (const candidate of await candidates(auth)) {
    await markRead(auth.user.id, candidate);
  }

  return listAlerts(auth);
}

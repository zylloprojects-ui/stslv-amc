import { pool } from "../../config/database";
import { notFound } from "../../shared/errors";
import { displayMoney } from "../../shared/export/report";
import { getExpiryFigures, type ExpiryBand } from "../amc/management.service";
import { getAmcSummary } from "../amc/summary.service";
import type { AuthContext } from "../auth/access";
import { getInvoiceSummary } from "../invoices/invoices.service";
import { schemaHas } from "../../shared/schema-features";
import { awaitingReview, responsesFor } from "../suggestions/suggestions.service";
import { isReviewer } from "../suggestions/suggestions.workflow";

// In-app alerts. Every alert is a figure the application already defines and
// shows elsewhere (the AMC, AMC Management and Invoice Tracking summaries),
// worked out on request for the signed-in user's permissions. Expiry warnings
// use the AMC Management bands (90, 60, 45, 30 and 15 days before the end of
// validity) and count only contracts with no renewal that is not cancelled.
// Read state is per user (notification_reads); marking an alert read never
// hides it, from this user or anyone else.

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
  /** The renewal warning: always listed while it applies, whatever other alerts were read. */
  pinned: boolean;
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
  pinned?: boolean;
}

// Alert keys cannot hold digits (notification_reads.alert_key_ck), so the bands are named in words.
const BAND_KEYS: Record<ExpiryBand, string> = { 90: "ninety", 60: "sixty", 45: "forty_five", 30: "thirty", 15: "fifteen" };

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
      link: "/amc/management",
      count: amc.contracts.activePastValidity,
      fingerprint: String(amc.contracts.activePastValidity),
    });
  }
  if (auth.permissions.has("AMC_CONTRACTS:VIEW")) {
    const expiry = await getExpiryFigures();

    if (expiry.renewalWarning.count > 0) {
      const count = expiry.renewalWarning.count;

      list.push({
        key: "contracts.renewal_warning",
        severity: "warning",
        title: `Renewal due: contracts ending within ${expiry.renewalWarning.days} days`,
        message: `${plural(count, "active contract ends", "active contracts end")} within ${expiry.renewalWarning.days} days and ${count === 1 ? "has" : "have"} not been renewed.`,
        link: "/amc/management",
        count,
        fingerprint: expiry.renewalWarning.ids.join(","),
        pinned: true,
      });
    }

    for (const band of expiry.bands) {
      if (band.notRenewed === 0) continue;

      list.push({
        key: `contracts.expiry.${BAND_KEYS[band.days]}`,
        severity: band.days <= 30 ? "warning" : "info",
        title: `Contracts expiring in ${band.fromDays}–${band.days} days`,
        message: `${plural(band.notRenewed, "active contract ends", "active contracts end")} in ${band.fromDays} to ${band.days} days and ${band.notRenewed === 1 ? "has" : "have"} not been renewed.`,
        link: "/amc/management",
        count: band.notRenewed,
        fingerprint: band.notRenewedIds.join(","),
      });
    }
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

  // Suggestions (migration 0085): new or reopened ones for reviewers, responses for the submitter.
  if (await schemaHas(["suggestions", "suggestion_events"])) {
    if (isReviewer(auth)) {
      const waiting = await awaitingReview();

      if (waiting.count > 0) {
        list.push({
          key: "suggestions.awaiting_review",
          severity: "info",
          title: "Suggestions waiting for review",
          message: `${plural(waiting.count, "suggestion is", "suggestions are")} new or reopened and waiting for review.`,
          link: "/admin/suggestions",
          count: waiting.count,
          fingerprint: waiting.fingerprint,
        });
      }
    }

    const responses = await responsesFor(auth.user.id);

    if (responses.count > 0) {
      list.push({
        key: "suggestions.responses",
        severity: "info",
        title: "Updates on your suggestions",
        message: `${plural(responses.count, "of your suggestions has", "of your suggestions have")} a new response or status change.`,
        link: "/suggestions",
        count: responses.count,
        fingerprint: responses.fingerprint,
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
      pinned: candidate.pinned === true,
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

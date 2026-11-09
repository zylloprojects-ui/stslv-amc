// The business calendar of STS-ELV AMC: every date-sensitive business rule is measured in Oman time (Asia/Muscat),
// whatever the time zone of the server or the database session (Neon runs in UTC; a local PostgreSQL may not).
// Approved by the owner 2026-11-09.
//
// What uses it: "today" for expiry, due/expiring windows, overdue and upcoming services, "this month" figures,
// completion dates recorded today, and the day/month a stored timestamp falls on (e.g. "renewed on", "paid this
// month", date-range filters on logs).
//
// What does NOT change: stored timestamps stay timestamptz (absolute instants, shown in UTC or the viewer's clock as
// before), and date-only fields (valid_from, valid_to, scheduled_date, completed_date, invoice_date, ...) are calendar
// dates and are never shifted or reinterpreted. A contract is valid through its Valid To date in Oman and is expired
// from the next Oman calendar day.
//
// Put every timezone calculation here instead of repeating it.

/** The business time zone (Oman). Also the time zone every report and export is printed in. */
export const BUSINESS_TIME_ZONE = "Asia/Muscat";

/** SQL: today's date in Oman, from the database clock. Use instead of current_date. */
export const BUSINESS_TODAY_SQL = `(now() AT TIME ZONE '${BUSINESS_TIME_ZONE}')::date`;

/** SQL: the Oman calendar day an absolute timestamp (timestamptz) falls on. */
export function businessDateSql(timestampSql: string): string {
  return `((${timestampSql}) AT TIME ZONE '${BUSINESS_TIME_ZONE}')::date`;
}

/** SQL: the instant (timestamptz) an Oman calendar day starts, for range filters on stored timestamps. */
export function businessDayStartSql(dateSql: string): string {
  return `((${dateSql})::timestamp AT TIME ZONE '${BUSINESS_TIME_ZONE}')`;
}

const DAY_FORMAT = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

/** Today's Oman date (YYYY-MM-DD) for an instant, from this process's clock. Prefer BUSINESS_TODAY_SQL inside queries. */
export function businessDateOf(instant: Date = new Date()): string {
  const parts = Object.fromEntries(DAY_FORMAT.formatToParts(instant).map((part) => [part.type, part.value]));

  return `${parts.year}-${parts.month}-${parts.day}`;
}

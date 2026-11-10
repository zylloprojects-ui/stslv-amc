// The business calendar on the page: Oman time (Asia/Muscat), the same as the API (stslv-api/src/shared/business-date.ts),
// whatever time zone the browser is set to. Approved by the owner 2026-11-09. Every "today", "this month" and
// "days left" on a page comes from here, so a user abroad sees the same business date as the server.
//
// Date-only values from the API ("2026-11-09": valid from/to, scheduled, completed) are calendar dates: they are never
// shifted. Timestamps keep their absolute meaning.

export const BUSINESS_TIME_ZONE = 'Asia/Muscat'

const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })

/** The Oman calendar date (YYYY-MM-DD) of an instant; today by default. */
export function businessDateOf(instant: Date | number = new Date()): string {
  const parts = Object.fromEntries(DAY_FORMAT.formatToParts(instant).map((part) => [part.type, part.value]))

  return `${parts.year}-${parts.month}-${parts.day}`
}

/** Today's date in Oman (YYYY-MM-DD). */
export function businessToday(): string {
  return businessDateOf(new Date())
}

/** Whole days from one YYYY-MM-DD date to another (negative when `to` is earlier). Pure calendar arithmetic. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/** A YYYY-MM-DD date `days` calendar days from `date`. */
export function addCalendarDays(date: string, days: number): string {
  const moved = new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)

  return moved.toISOString().slice(0, 10)
}

const DATE_TIME_FORMAT = new Intl.DateTimeFormat('en-GB', { timeZone: BUSINESS_TIME_ZONE, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/** An instant shown in Oman time ("10 Nov 2026, 14:05"), whatever the browser's zone; "—" when none. */
export function formatBusinessDateTime(value: string | null): string {
  return value ? DATE_TIME_FORMAT.format(new Date(value)) : '—'
}

/** A calendar date in words ("Monday, 9 November 2026"), without any time-zone shift. */
export function formatBusinessDayLong(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}

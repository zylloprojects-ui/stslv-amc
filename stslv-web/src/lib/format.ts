const dateTime = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
const time = new Intl.DateTimeFormat('en-GB', { timeStyle: 'short' })
const count = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 })

export function formatDateTime(value: string | null): string {
  return value ? dateTime.format(new Date(value)) : '—'
}

const dateOnly = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' })

/** Formats a calendar day held as YYYY-MM-DD. It has no time zone, so it never shifts by a day. */
export function formatDate(value: string | null): string {
  const match = value ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null

  return match ? dateOnly.format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))) : '—'
}

/** Today's date on this computer, as YYYY-MM-DD. */
export function todayIso(): string {
  const now = new Date()

  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

export function formatTime(value: number | Date): string {
  return time.format(value)
}

/** A whole number of things (clients, visits, projects) with thousands separators. Not for money. */
export function formatCount(value: number): string {
  return count.format(value)
}

/** Up to two initials of a person's name, for the avatar next to it. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const first = words[0]?.[0] ?? ''
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : ''

  return (first + last).toUpperCase()
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

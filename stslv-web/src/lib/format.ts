const dateTime = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
const time = new Intl.DateTimeFormat('en-GB', { timeStyle: 'short' })
const count = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 })

export function formatDateTime(value: string | null): string {
  return value ? dateTime.format(new Date(value)) : '—'
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

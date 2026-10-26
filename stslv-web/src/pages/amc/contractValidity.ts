// Where a contract stands in its validity period, worked out from calendar
// days ("YYYY-MM-DD"), so no time zone can shift a day.

const DAY_MS = 86_400_000

function dayNumber(value: string): number {
  return Date.parse(`${value}T00:00:00Z`) / DAY_MS
}

const days = (count: number) => `${count} day${count === 1 ? '' : 's'}`

export interface ValidityState {
  /** Calendar days covered, the start and end dates both included. */
  durationDays: number
  phase: 'upcoming' | 'running' | 'ended'
  /** In words, for example "120 days remaining" or "Ended 3 days ago". */
  text: string
}

/** `today` is the user's own date ("YYYY-MM-DD"). Null when a date cannot be read. */
export function validityState(validFrom: string, validTo: string, today: string): ValidityState | null {
  const start = dayNumber(validFrom)
  const end = dayNumber(validTo)
  const now = dayNumber(today)

  if ([start, end, now].some((value) => Number.isNaN(value)) || end < start) {
    return null
  }

  const durationDays = end - start + 1

  if (now < start) {
    return { durationDays, phase: 'upcoming', text: `Starts in ${days(start - now)}` }
  }
  if (now > end) {
    return { durationDays, phase: 'ended', text: `Ended ${days(now - end)} ago` }
  }

  const remaining = end - now

  return { durationDays, phase: 'running', text: remaining === 0 ? 'Ends today' : `${days(remaining)} remaining` }
}

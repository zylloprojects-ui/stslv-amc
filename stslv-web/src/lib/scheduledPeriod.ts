const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** The scheduled-date range a month ("1"-"12") and year filter select, in words. Empty values mean every month or year. */
export function scheduledPeriod(month: string, year: string): string {
  const name = month ? MONTHS[Number(month) - 1] : ''

  if (name && year) return `services scheduled in ${name} ${year}`
  if (year) return `services scheduled in ${year}`
  if (name) return `services scheduled in ${name} of every year`
  return 'services of all scheduled dates'
}

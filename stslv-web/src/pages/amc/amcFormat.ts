// Formatting for AMC dates and money. Both arrive as text and are formatted as
// text: money is never turned into a floating-point number, and a calendar day
// is never shifted by a time zone.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** "2027-01-05" -> "05 Jan 2027". */
export function formatDate(value: string | null): string {
  const match = value ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null

  return match ? `${match[3]} ${MONTHS[Number(match[2]) - 1]} ${match[1]}` : '—'
}

/** "9000.000" -> "9,000.000". Null (no amount set) -> "—". */
export function formatMoney(value: string | null): string {
  if (value === null) {
    return '—'
  }

  const negative = value.startsWith('-')
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.')

  return `${negative ? '-' : ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction.padEnd(3, '0')}`
}

/** Money as the API accepts it: digits with at most three decimals. */
export const MONEY_PATTERN = /^\d{1,11}(\.\d{1,3})?$/

/** True when a money text is zero ("0", "0.000"). */
export function isZeroMoney(value: string | null): boolean {
  return value !== null && /^-?0+(\.0+)?$/.test(value)
}

const pad = (value: number) => String(value).padStart(2, '0')

/** Today in the user's own time zone, as "YYYY-MM-DD". */
export function todayIso(): string {
  const now = new Date()

  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** The current month as "YYYY-MM". */
export function currentMonth(): string {
  return todayIso().slice(0, 7)
}

/** "2027-01" moved by a number of months. */
export function shiftMonth(month: string, by: number): string {
  const [year = 0, index = 1] = month.split('-').map(Number)
  const total = year * 12 + (index - 1) + by

  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}`
}

/** First and last day of a "YYYY-MM" month. */
export function monthRange(month: string): { from: string; to: string } {
  const [year = 0, index = 1] = month.split('-').map(Number)
  const lastDay = new Date(Date.UTC(year, index, 0)).getUTCDate()

  return { from: `${month}-01`, to: `${month}-${pad(lastDay)}` }
}

/** "2027-01" -> "January 2027". */
export function monthLabel(month: string): string {
  const [year = 0, index = 1] = month.split('-').map(Number)

  return `${MONTH_NAMES[index - 1]} ${year}`
}

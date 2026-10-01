// Money and rates travel as decimal strings ("1234.567") and are never turned
// into a JavaScript number, so nothing here can introduce a floating-point
// error. The saved figures are always the ones calculated by the API.

const MONEY = /^\d{1,11}(\.\d{1,3})?$/
const RATE = /^\d{1,3}(\.\d{1,3})?$/

export const MONEY_MESSAGE = 'Enter a number with at most 3 decimal places, for example 1250.500.'

export const isMoney = (value: string): boolean => MONEY.test(value)

/** A percentage between 0 and 100 with at most three decimals. */
export function isRate(value: string): boolean {
  if (!RATE.test(value)) {
    return false
  }

  return toThousandths(value) <= 100_000n
}

export const isZeroAmount = (value: string): boolean => /^0+(\.0+)?$/.test(value)

/** "12.5" becomes 12500n. The caller has checked the format. */
function toThousandths(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.')

  return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'))
}

function fromThousandths(value: bigint): string {
  const digits = value.toString().padStart(4, '0')

  return `${digits.slice(0, -3)}.${digits.slice(-3)}`
}

/** Shows a stored amount with thousands separators: "1234.567" becomes "1,234.567". */
export function formatMoney(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return '—'
  }

  const negative = value.startsWith('-')
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

  return `${negative ? '−' : ''}${grouped}.${fraction.padEnd(3, '0')}`
}

/** "5.000" becomes "5%", "7.500" becomes "7.5%". */
export function formatRate(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.')
  const trimmed = fraction.replace(/0+$/, '')

  return `${whole}${trimmed ? `.${trimmed}` : ''}%`
}

/**
 * VAT and grand value for the figures being typed, shown before saving. Exact
 * integer arithmetic on thousandths, rounded half up to three decimals: the
 * same result PostgreSQL stores. Null while either input is not a valid number.
 */
export function previewVat(jobValue: string, vatRate: string): { vatAmount: string; grandValue: string } | null {
  const value = jobValue.trim()
  const rate = vatRate.trim()

  if (!isMoney(value) || !isRate(rate)) {
    return null
  }

  const valueThousandths = toThousandths(value)
  const vat = (valueThousandths * toThousandths(rate) + 50_000n) / 100_000n

  return { vatAmount: fromThousandths(vat), grandValue: fromThousandths(valueThousandths + vat) }
}

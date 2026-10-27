import { monthRange } from '../amc/amcFormat'

/** Whole weeks, Sunday to Saturday, covering a "YYYY-MM" month. Null cells are days of the neighbouring months. */
export function monthCells(month: string): (string | null)[] {
  const { from, to } = monthRange(month)
  const first = new Date(`${from}T00:00:00Z`).getUTCDay()
  const last = Number(to.slice(8))
  const cells: (string | null)[] = Array.from({ length: first }, () => null)

  for (let day = 1; day <= last; day += 1) cells.push(`${month}-${String(day).padStart(2, '0')}`)
  while (cells.length % 7 !== 0) cells.push(null)

  return cells
}

import { screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { ADMIN, renderApp } from './helpers'
import { amcApi, makeContract, makeVisit } from './amc-helpers'

// Contract 360 → Service Schedule shows the quotation number saved on Service Sales for each
// service, read-only, immediately before Invoice No. Every record here is invented.

const quarter = (n: number, overrides: Parameters<typeof makeVisit>[0] = {}) =>
  makeVisit({
    id: String(500 + n),
    sequenceNo: n,
    cycleNo: 1,
    serviceCode: `Q${n}`,
    scheduledDate: `2027-0${n * 3 - 2}-05`,
    ...overrides,
  })

const VISITS = [
  quarter(1, { status: 'COMPLETED', completedDate: '2027-01-06', quotationNo: 'QT-2026-001' }),
  quarter(2, { status: 'COMPLETED', completedDate: '2027-04-06', quotationNo: 'QT-2026-002', manualInvoiceNo: 'INV-7', paymentStatus: 'PAID', paidAt: '2027-04-10T08:00:00.000Z' }),
  quarter(3),
  quarter(4),
]

beforeEach(() => {
  localStorage.clear()
})

async function scheduleTable() {
  amcApi(ADMIN, { contracts: [makeContract()], visits: VISITS })
  renderApp('/amc/contracts/100')
  return screen.findByRole('table', { name: 'Visits of this contract' })
}

const headers = (table: HTMLElement) => within(table).getAllByRole('columnheader').map((cell) => cell.textContent?.trim())

describe('Contract 360 Service Schedule quotation number', () => {
  it('adds a Quotation No. column immediately before Invoice No.', async () => {
    const names = headers(await scheduleTable())
    expect(names).toContain('Quotation No.')
    expect(names.indexOf('Invoice No.')).toBe(names.indexOf('Quotation No.') + 1)
  })

  it("shows each service's own quotation, and — where none is saved", async () => {
    const table = await scheduleTable()
    const column = headers(table).indexOf('Quotation No.')
    const rows = within(table).getAllByRole('row').slice(1) as HTMLTableRowElement[]

    const cells = rows.map((row) => [row.cells[0]?.textContent?.trim(), row.cells[column]?.textContent?.trim()])
    expect(cells).toEqual([
      ['Year 1 · Q1', 'QT-2026-001'],
      ['Year 1 · Q2', 'QT-2026-002'],
      ['Year 1 · Q3', '—'],
      ['Year 1 · Q4', '—'],
    ])
  })

  it('is read-only: no quotation input in the schedule, and Invoice No. is unchanged', async () => {
    const table = await scheduleTable()
    expect(within(table).queryByRole('textbox', { name: /quotation/i })).not.toBeInTheDocument()
    expect(within(table).queryByRole('button', { name: /quotation/i })).not.toBeInTheDocument()

    // The manual Invoice No. of each service still has its own field, with Paid on the invoiced one.
    expect(within(table).getByRole('textbox', { name: 'Invoice No. for Year 1 · Q2' })).toHaveValue('INV-7')
    expect(within(table).getAllByText('Paid').length).toBeGreaterThan(0)
  })
})

import { describe, expect, it } from 'vitest'
import { awaitingInvoiceText } from '../pages/dashboard/kpis'

// Client meeting 2026-11-16: of the services without an Invoice No., those already Completed are waiting to be invoiced.
// The "Invoices Not Generated" figure itself is unchanged; this only adds the completed part to its detail line.
describe('completed services awaiting invoice', () => {
  it('names how many completed services are waiting for an Invoice No., and their value', () => {
    expect(awaitingInvoiceText(2, '1200.000')).toBe(' · 2 completed, awaiting invoice (OMR 1,200.000)')
  })

  it('says plainly when none are waiting', () => {
    expect(awaitingInvoiceText(0, '0.000')).toBe(' · none completed awaiting invoice')
  })

  it('adds nothing when an older API does not send the figure', () => {
    expect(awaitingInvoiceText(undefined, undefined)).toBe('')
  })
})

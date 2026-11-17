import { describe, expect, it } from 'vitest'
import { actionLabel, fieldLabel } from '../pages/admin/auditTypes'

// Client UAT 2026-11-16: the visit field of migration 0110 is the Service Engineer; until then it was labelled
// "Sales Engineer Name". Its stored audit codes keep the old name, so the Audit Log names both, and no entry made
// before the rename is presented as something it may not be.
describe('Audit Log names of the Service Engineer field', () => {
  it('shows the stored action and field with both names', () => {
    expect(actionLabel('amc_visit.sales_engineer_name_changed')).toBe('AMC visit Service Engineer (formerly “Sales Engineer Name”) changed')
    expect(fieldLabel('salesEngineerName')).toBe('Service Engineer (formerly “Sales Engineer Name”)')
  })

  it('names the Customer PO Value field of CR-013', () => {
    expect(fieldLabel('customerPoValue')).toBe('Customer PO Value (ex VAT)')
  })

  it('leaves every other action and field as before', () => {
    expect(actionLabel('amc_contract.status_changed')).toBe('Amc contract status changed')
    expect(actionLabel('services_sales.exported')).toBe('Service sales exported')
    expect(fieldLabel('contractValue')).toBe('Contract value')
    expect(fieldLabel('salesEngineerId')).toBe('Sales engineer id')
  })
})

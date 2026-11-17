import { describe, expect, it } from 'vitest'
import { hasSeparateResponsibleEngineer } from '../pages/amc/amcFormat'

// Client meeting 2026-11-16: one engineer, the Sales Engineer. A typed "Responsible engineer" is still shown only when it
// is a different, older value, so it can be read or cleared; nothing is deleted.
describe('Responsible engineer on a contract', () => {
  it('is hidden when empty', () => {
    expect(hasSeparateResponsibleEngineer({ responsibleEngineer: null, salesEngineer: { name: 'Ravi Sales' } })).toBe(false)
    expect(hasSeparateResponsibleEngineer({ responsibleEngineer: '   ', salesEngineer: null })).toBe(false)
  })

  it('is hidden when it only repeats the Sales Engineer (filled automatically on a new contract)', () => {
    expect(hasSeparateResponsibleEngineer({ responsibleEngineer: ' ravi sales ', salesEngineer: { name: 'Ravi Sales' } })).toBe(false)
  })

  it('is shown when an older contract holds a different name, or has no Sales Engineer', () => {
    expect(hasSeparateResponsibleEngineer({ responsibleEngineer: 'Old Engineer', salesEngineer: { name: 'Ravi Sales' } })).toBe(true)
    expect(hasSeparateResponsibleEngineer({ responsibleEngineer: 'Old Engineer', salesEngineer: null })).toBe(true)
  })

  it('is hidden for a missing contract', () => {
    expect(hasSeparateResponsibleEngineer(null)).toBe(false)
  })
})

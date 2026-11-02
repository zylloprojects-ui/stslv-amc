import { describe, expect, it } from 'vitest'
import { contractEndDate } from '../pages/amc/amcFormat'

describe('contract duration', () => {
  it('ends the day before the same date the given number of years later', () => {
    expect(contractEndDate('2026-10-01', 1)).toBe('2027-09-30')
    expect(contractEndDate('2026-10-24', 1)).toBe('2027-10-23')
    expect(contractEndDate('2026-01-01', 5)).toBe('2030-12-31')
  })

  it('handles leap years', () => {
    expect(contractEndDate('2024-03-01', 1)).toBe('2025-02-28')
    expect(contractEndDate('2027-03-01', 1)).toBe('2028-02-29')
    expect(contractEndDate('2024-02-29', 1)).toBe('2025-02-28')
  })
})

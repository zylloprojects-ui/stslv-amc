import { screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addCalendarDays, businessDateOf, businessToday, daysBetween, formatBusinessDayLong } from '../lib/businessDate'
import { todayIso } from '../lib/format'
import { todayIso as amcTodayIso } from '../pages/amc/amcFormat'
import { ADMIN, mockApi, ok, renderApp, signIn } from './helpers'
import { makeContract } from './amc-helpers'

// Owner approval 2026-11-09: the pages use Oman's business date (Asia/Muscat), like the API, whatever the browser's
// time zone. Oman midnight is 20:00 UTC. Every instant below is fixed, so the checks do not depend on when they run.

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('business date helpers', () => {
  it('changes day at midnight in Oman, not at the browser’s or UTC midnight', () => {
    expect(businessDateOf(new Date('2026-11-09T19:59:59Z'))).toBe('2026-11-09')
    expect(businessDateOf(new Date('2026-11-09T20:00:00Z'))).toBe('2026-11-10')
  })

  it('handles month end, year end and leap years', () => {
    expect(businessDateOf(new Date('2026-11-30T20:00:00Z'))).toBe('2026-12-01')
    expect(businessDateOf(new Date('2026-12-31T19:59:59Z'))).toBe('2026-12-31')
    expect(businessDateOf(new Date('2026-12-31T20:00:00Z'))).toBe('2027-01-01')
    expect(businessDateOf(new Date('2028-02-28T20:00:00Z'))).toBe('2028-02-29')
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addCalendarDays('2027-03-01', -1)).toBe('2027-02-28')
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1)
    expect(daysBetween('2026-11-10', '2026-11-09')).toBe(-1)
  })

  it('gives every "today" on the page from the Oman clock', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-12-31T21:30:00Z')) // 01:30 on 1 January 2027 in Oman
    expect(businessToday()).toBe('2027-01-01')
    expect(todayIso()).toBe('2027-01-01')
    expect(amcTodayIso()).toBe('2027-01-01')
  })

  it('writes a calendar date in words without shifting it', () => {
    expect(formatBusinessDayLong('2027-01-01')).toContain('2027')
    expect(formatBusinessDayLong('2027-01-01')).toMatch(/1/)
  })
})

describe('AMC Contracts validity notes by the Oman day', () => {
  beforeEach(() => {
    signIn()
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }))
  })

  function contractsApi(validTo: string) {
    return mockApi((request) => {
      if (request.path === '/auth/me') return ok({ user: ADMIN })
      if (request.path === '/amc/contracts/kpis') return ok({ total: 1, contractValue: '0.000', finalCredit: '0.000', finalCreditMissing: 0, expired: 0 })
      if (request.path === '/amc/contracts/filter-options') return ok({ clients: [], systems: [], salesEngineers: [], frequencies: [], years: [] })
      if (request.path === '/amc/contracts') {
        return ok({ items: [makeContract({ id: '100', amcReference: 'OMAN-001', validFrom: '2026-01-01', validTo, status: 'ACTIVE' })], total: 1, page: 1, pageSize: 25, totals: { contractValue: '0.000', finalCredit: '0.000' } })
      }
      return undefined
    })
  }

  it('shows "Ends today" through the Valid To day in Oman, even after UTC midnight has not yet come', async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-12-30T20:30:00Z')) // 00:30 on 31 December in Oman; still 30 December in UTC
    contractsApi('2026-12-31')
    renderApp('/amc/contracts')

    expect(await screen.findByText('Ends today')).toBeInTheDocument()
  })

  it('shows "Ended 1 day ago" from the next Oman day', async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-12-31T20:30:00Z')) // 00:30 on 1 January 2027 in Oman; still 31 December in UTC
    contractsApi('2026-12-31')
    renderApp('/amc/contracts')

    expect(await screen.findByText('Ended 1 day ago')).toBeInTheDocument()
  })
})

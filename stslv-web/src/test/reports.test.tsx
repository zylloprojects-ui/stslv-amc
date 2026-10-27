import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { SessionUser } from '../lib/types'
import { ADMIN, fail, mockApi, ok, renderApp, signIn, type MockReply, type MockRequest } from './helpers'
import { makeVisit } from './amc-helpers'

// The Reports page. Every figure here is invented test data.

const INVOICES_ONLY: SessionUser = { ...ADMIN, id: '8', roles: [{ id: '5', code: 'INVOICING', name: 'Invoicing' }], permissions: ['DASHBOARD:VIEW', 'REPORTS:VIEW', 'INVOICES:VIEW'] }
const REPORTS_ONLY: SessionUser = { ...INVOICES_ONLY, permissions: ['DASHBOARD:VIEW', 'REPORTS:VIEW'] }

const AMC_SUMMARY = {
  asOf: '2026-10-26',
  contracts: { active: 12, activePastValidity: 2, draft: 3, expired: 4, cancelled: 1 },
  visits: { due: 5, overdue: 2, upcoming: 9, upcomingDays: 30, dueThisMonth: 10, completedThisMonth: 6, completedTotal: 80, inProgress: 1, postponed: 1, historical: 0 },
  invoicing: { readyForInvoice: { count: 7, amount: '2835.000' }, amountRequired: { count: 1 }, noInvoiceRequired: { count: 0 } },
}

const INVOICE_SUMMARY = {
  issued: { count: 40, amountExclVat: '16200.000', vatAmount: '810.000', totalAmount: '17010.000' },
  cancelled: { count: 2 },
  amc: { pending: { count: 7, amount: '2835.000' }, invoiced: { count: 30, invoicedAmount: '12150.000' } },
  projects: { pending: { count: 3, uninvoicedValue: '4500.000' }, partlyInvoiced: { count: 1 }, invoiced: { count: 6 }, invoicedValue: '4050.000' },
}

const EXPIRING = (days: number) => ({
  asOf: '2026-10-26',
  days,
  items: [
    { id: '100', client: { id: '10', name: 'Test Hotel One' }, systemDescription: 'FIRE', responsibleEngineer: 'Test Engineer', validTo: '2026-10-21', daysLeft: -5, contractValue: '1620.000' },
    { id: '101', client: { id: '11', name: 'Test Hotel Two' }, systemDescription: 'CCTV', responsibleEngineer: null, validTo: '2026-11-05', daysLeft: 10, contractValue: '800.000' },
  ],
  total: 2,
  pastValidity: 1,
  page: 1,
  pageSize: 50,
})

const WORKLOAD = {
  months: [
    { month: '2026-10', planned: 10, completed: 6, open: 4 },
    { month: '2026-11', planned: 8, completed: 0, open: 8 },
    { month: '2026-12', planned: 0, completed: 0, open: 0 },
  ],
}

function reportsApi(user: SessionUser, override?: (request: MockRequest) => MockReply | undefined) {
  signIn()

  return mockApi((request) => {
    const overridden = override?.(request)
    if (overridden) return overridden
    if (request.path === '/auth/me') return ok({ user })
    if (request.path === '/amc/summary') return ok(AMC_SUMMARY)
    if (request.path === '/amc/reports/expiring') return ok(EXPIRING(Number(request.query.get('days'))))
    if (request.path === '/amc/reports/workload') return ok(WORKLOAD)
    if (request.path === '/amc/reports/renewals') return ok({ items: [], total: 0, page: 1, pageSize: 25 })
    if (request.path === '/invoices/summary') return ok(INVOICE_SUMMARY)
    if (request.path === '/amc/visits') {
      const overdue = request.query.get('overdue') === 'true'
      const items = overdue ? [makeVisit({ id: '700', scheduledDate: '2026-10-01', isOverdue: true })] : [makeVisit({ id: '701', scheduledDate: '2026-10-30' })]

      return ok({ items, total: items.length, page: 1, pageSize: 20, totals: { visitAmount: '0.000', amountMissingCount: 0 } })
    }

    return undefined
  })
}

const region = (name: string) => within(screen.getByRole('region', { name }))

describe('Reports', () => {
  it('shows every section to an Admin, with the figures returned by the API', async () => {
    reportsApi(ADMIN)
    renderApp('/reports')

    await screen.findByRole('heading', { name: 'Reports', level: 1 })
    await waitFor(() => expect(region('AMC portfolio').getByText('2 past their validity')).toBeInTheDocument())
    expect(region('AMC portfolio').getByText('20')).toBeInTheDocument()

    const expiring = await screen.findByRole('table', { name: 'Expiring contracts' })
    const rows = within(expiring).getAllByRole('row').slice(1)
    expect(rows[0]).toHaveTextContent('Ended 5 days ago')
    expect(rows[1]).toHaveTextContent('10 days left')
    expect(within(rows[0] as HTMLElement).getByRole('link', { name: 'Test Hotel One — FIRE' })).toHaveAttribute('href', '/amc/contracts/100')

    const workload = await screen.findByRole('table', { name: 'Visits per month' })
    expect(within(workload).getAllByRole('row')[1]).toHaveTextContent('October 2026')
    expect(within(workload).getAllByRole('row')[1]).toHaveTextContent('1064')

    expect(await screen.findByRole('table', { name: 'Upcoming visits' })).toBeInTheDocument()
    expect(await screen.findByRole('table', { name: 'Overdue visits' })).toBeInTheDocument()

    const billing = region('Billing and invoices')
    expect(await billing.findByText('AMC visits ready for invoice')).toBeInTheDocument()
    expect(billing.getByText(/2,835\.000/)).toBeInTheDocument()
    expect(billing.getByText('Invoices recorded')).toBeInTheDocument()
    expect(billing.getByText(/17,010\.000 incl\. VAT/)).toBeInTheDocument()
  })

  it('never describes invoiced work as paid', async () => {
    reportsApi(ADMIN)
    renderApp('/reports')

    await screen.findByText('Invoices recorded')
    expect(screen.queryByText(/\bpaid\b/i)).not.toBeInTheDocument()
  })

  it('asks for the expiring contracts of the period the user picks', async () => {
    const api = reportsApi(ADMIN)
    renderApp('/reports')

    await screen.findByRole('table', { name: 'Expiring contracts' })
    expect(api.find('GET', '/amc/reports/expiring')[0]?.query.get('days')).toBe('90')

    await userEvent.click(screen.getByRole('button', { name: 'Next 30 days' }))
    await waitFor(() => expect(api.find('GET', '/amc/reports/expiring').some((request) => request.query.get('days') === '30')).toBe(true))
    expect(screen.getByRole('button', { name: 'Next 30 days' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('asks for upcoming visits from the day after the database date', async () => {
    const api = reportsApi(ADMIN)
    renderApp('/reports')

    await screen.findByRole('table', { name: 'Upcoming visits' })
    const upcoming = api.find('GET', '/amc/visits').find((request) => request.query.get('from'))
    expect(upcoming?.query.get('from')).toBe('2026-10-27')
    expect(upcoming?.query.get('to')).toBe('2026-11-09')
  })

  it('shows a role only the sections of the modules it may view, without asking for the others', async () => {
    const api = reportsApi(INVOICES_ONLY)
    renderApp('/reports')

    expect(await screen.findByText('Invoices recorded')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'AMC portfolio' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Expiring contracts' })).not.toBeInTheDocument()
    expect(api.find('GET', '/amc/summary')).toHaveLength(0)
    expect(api.find('GET', '/amc/reports/expiring')).toHaveLength(0)
    expect(api.find('GET', '/amc/visits')).toHaveLength(0)
  })

  it('tells a role with no report data that there is nothing to show', async () => {
    reportsApi(REPORTS_ONLY)
    renderApp('/reports')

    expect(await screen.findByText('No reports for your role')).toBeInTheDocument()
  })

  it('shows an error in one section while the others still load', async () => {
    reportsApi(ADMIN, (request) => (request.path === '/amc/reports/workload' ? fail(500, 'INTERNAL_ERROR', 'Workload is unavailable.') : undefined))
    renderApp('/reports')

    const workload = within(await screen.findByRole('region', { name: 'Service workload' }))
    expect(await workload.findByText(/Workload is unavailable/)).toBeInTheDocument()
    expect(await screen.findByRole('table', { name: 'Expiring contracts' })).toBeInTheDocument()
  })
})

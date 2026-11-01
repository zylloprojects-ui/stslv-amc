import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '../lib/types'
import { ADMIN, mockApi, ok, renderApp, signIn, type MockRequest, type MockReply } from './helpers'

// The Reports filters, KPI strip and deep link, and the links that lead to Reports and Accounts.

const CATALOGUE = [
  {
    id: 'contract-summary',
    title: 'AMC Contract Summary',
    description: 'Every contract.',
    filters: ['dates', 'client', 'engineer', 'system', 'status'],
    statuses: [{ value: 'ACTIVE', label: 'Active' }, { value: 'DRAFT', label: 'Draft' }],
  },
  {
    id: 'scheduled-services',
    title: 'Billing Schedule',
    description: 'Every scheduled service.',
    filters: ['dates', 'client', 'engineer', 'system', 'status', 'payment'],
    statuses: [{ value: 'SCHEDULED', label: 'Scheduled' }, { value: 'COMPLETED', label: 'Completed' }],
  },
  { id: 'expiry-renewal', title: 'Expiry & Renewal Due', description: 'Active contracts ending soon.', filters: ['client', 'engineer', 'system'], statuses: [] },
]
const OPTIONS = { clients: [{ id: '10', name: 'Alpha Towers' }], salesEngineers: [{ id: '4', name: 'Esha Engineer' }], systems: ['CCTV', 'FIRE'] }
const REPORT = {
  title: 'AMC Contract Summary',
  columns: [
    { key: 'client', header: 'Client', kind: 'text' },
    { key: 'value', header: 'AMC Value / Year', kind: 'money' },
  ],
  rows: [{ client: 'Alpha Towers', value: '1620.125' }],
  total: 1,
  page: 1,
  pageSize: 50,
  totals: { value: '1620.125' },
  kpis: [
    { id: 'contracts', label: 'Contracts in Scope', kind: 'count', value: '1', hint: null },
    { id: 'value', label: 'AMC Value', kind: 'money', value: '1620.125', hint: 'Excluding VAT' },
    { id: 'scheduled', label: 'Scheduled (Current Year)', kind: 'money', value: '810.000', hint: null },
    { id: 'unpaid', label: 'Unpaid Amount', kind: 'money', value: '405.500', hint: null },
  ],
  notes: [],
}

function reportsApi(user: SessionUser, extra?: (request: MockRequest) => MockReply | undefined) {
  return mockApi((request) => {
    if (request.path === '/auth/me') return ok({ user })
    if (request.path === '/notifications') return ok({ items: [], unread: 0 })
    const own = extra?.(request)
    if (own) return own
    if (request.path === '/reports') return ok(CATALOGUE)
    if (request.path === '/reports/options') return ok(OPTIONS)
    if (request.path.startsWith('/reports/')) return ok({ ...REPORT, kpis: request.path === '/reports/contract-summary' ? REPORT.kpis : [] })
    return undefined
  })
}

beforeEach(signIn)
afterEach(() => vi.restoreAllMocks())

describe('Reports page', () => {
  it('shows the API figures in a strip, only on the report that has them', async () => {
    reportsApi(ADMIN)
    renderApp('/reports')

    const strip = await screen.findByLabelText('AMC Contract Summary figures')
    expect(within(strip).getByText('Contracts in Scope')).toBeInTheDocument()
    expect(within(strip).getByText('Scheduled (Current Year)')).toBeInTheDocument()
    expect(within(strip).getByText('810.000')).toBeInTheDocument()
    expect(within(strip).getByText('405.500')).toBeInTheDocument()

    await userEvent.selectOptions(screen.getByLabelText('Report'), 'expiry-renewal')
    await waitFor(() => expect(screen.queryByLabelText('AMC Contract Summary figures')).not.toBeInTheDocument())
  })

  it('sends the System, Status and Paid / Unpaid filters, and offers only what the report has', async () => {
    const api = reportsApi(ADMIN)
    renderApp('/reports')

    await userEvent.selectOptions(await screen.findByLabelText('System'), 'FIRE')
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'ACTIVE')
    await waitFor(() => expect(api.find('GET', '/reports/contract-summary').at(-1)?.query.get('status')).toBe('ACTIVE'))
    expect(api.find('GET', '/reports/contract-summary').at(-1)?.query.get('system')).toBe('FIRE')
    expect(screen.queryByLabelText('Paid / Unpaid')).not.toBeInTheDocument()

    await userEvent.selectOptions(screen.getByLabelText('Report'), 'scheduled-services')
    // ACTIVE is not a visit status, so it is not carried over.
    await waitFor(() => expect(api.find('GET', '/reports/scheduled-services').length).toBeGreaterThan(0))
    expect(api.find('GET', '/reports/scheduled-services').at(-1)?.query.get('status')).toBeNull()
    expect(api.find('GET', '/reports/scheduled-services').at(-1)?.query.get('system')).toBe('FIRE')

    await userEvent.selectOptions(screen.getByLabelText('Paid / Unpaid'), 'UNPAID')
    await waitFor(() => expect(api.find('GET', '/reports/scheduled-services').at(-1)?.query.get('payment')).toBe('UNPAID'))

    await userEvent.selectOptions(screen.getByLabelText('Report'), 'expiry-renewal')
    await waitFor(() => expect(screen.queryByLabelText('Status')).not.toBeInTheDocument())
    expect(screen.queryByLabelText('From')).not.toBeInTheDocument()
  })

  it('opens the report named in the address, and reads options with the Reports permission alone', async () => {
    const onlyReports: SessionUser = { ...ADMIN, id: '9', permissions: ['REPORTS:VIEW'] }
    const api = reportsApi(onlyReports)
    renderApp('/reports?report=expiry-renewal')

    await waitFor(() => expect(api.find('GET', '/reports/expiry-renewal').length).toBeGreaterThan(0))
    expect(await screen.findByLabelText('Client')).toBeInTheDocument()
    expect(api.find('GET', '/accounts/options')).toHaveLength(0)
    // No export permission, no download.
    expect(screen.queryByRole('button', { name: /to Excel/ })).not.toBeInTheDocument()
  })

  it('asks for a report when the address names an unknown one', async () => {
    const api = reportsApi(ADMIN)
    renderApp('/reports?report=nonsense')

    expect(await screen.findByRole('option', { name: 'Select a report' })).toBeInTheDocument()
    expect(api.find('GET', '/reports/nonsense')).toHaveLength(0)
    expect(screen.queryByRole('status', { name: 'Loading report' })).not.toBeInTheDocument()
  })
})

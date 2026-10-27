import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { SessionUser } from '../lib/types'
import { monthCells } from '../pages/dashboard/calendarCells'
import { orderedIds } from '../pages/dashboard/dashboardPreferences'
import { MetricCard } from '../pages/dashboard/MetricCard'
import type { OperationsDashboard } from '../pages/dashboard/operationsTypes'
import { ACCOUNTANT, ADMIN, fail, mockApi, ok, renderApp, signIn, type MockReply, type MockRequest } from './helpers'

// The AMC Operations Dashboard. The API is mocked: every figure here is a
// fixture, and each test checks that the page shows exactly what the API sent.

const UNAVAILABLE = { available: false as const, reason: 'Payment is not recorded in STSLV AMC. Invoices are tracked as Issued or Cancelled only, with no paid date or paid amount.' }

const OPERATIONS: OperationsDashboard = {
  asOf: '2026-10-27',
  timeZone: 'Asia/Muscat',
  kpis: {
    contracts: {
      active: 12,
      activePastValidity: 2,
      activeValue: '8010.500',
      finalCreditTotal: '300.501',
      finalCreditRecorded: 2,
      expiringSoon: 3,
      expiringSoonDays: 45,
      expiringSoonWithRenewal: 1,
    },
    services: { thisMonth: 9, completedThisMonth: 4, openThisMonth: 5 },
    unpaidInvoices: UNAVAILABLE,
    paidThisMonth: UNAVAILABLE,
  },
  portfolio: {
    total: 16,
    statuses: [
      { status: 'DRAFT', count: 3, percent: '18.8' },
      { status: 'ACTIVE', count: 12, percent: '75.0' },
      { status: 'EXPIRED', count: 0, percent: '0.0' },
      { status: 'CANCELLED', count: 1, percent: '6.3' },
    ],
  },
  expiring: {
    days: 90,
    total: 2,
    pastValidity: 1,
    renewalsInstalled: true,
    items: [
      { id: '41', client: { id: '1', name: 'Harbour Hotel' }, systemDescription: 'FIRE ALARM', validTo: '2026-10-26', daysLeft: -1, renewal: null },
      { id: '42', client: { id: '2', name: 'City Tower' }, systemDescription: 'CCTV', validTo: '2026-12-11', daysLeft: 45, renewal: { id: '77', status: 'DRAFT' } },
    ],
  },
  workload: {
    months: [
      { month: '2026-10', planned: 9, completed: 4, open: 5 },
      { month: '2026-11', planned: 7, completed: 0, open: 7 },
      { month: '2026-12', planned: 0, completed: 0, open: 0 },
      { month: '2027-01', planned: 3, completed: 0, open: 3 },
      { month: '2027-02', planned: 1, completed: 0, open: 1 },
      { month: '2027-03', planned: 2, completed: 0, open: 2 },
    ],
  },
  schedule: {
    today: [
      { id: '501', contractId: '41', client: { id: '1', name: 'Harbour Hotel' }, systemDescription: 'FIRE ALARM', scheduledDate: '2026-10-27', assignedTo: 'R. Engineer', status: 'SCHEDULED', isOverdue: false },
    ],
    todayTotal: 1,
    upcoming: [
      { id: '502', contractId: '42', client: { id: '2', name: 'City Tower' }, systemDescription: 'CCTV', scheduledDate: '2026-10-30', assignedTo: null, status: 'SCHEDULED', isOverdue: false },
    ],
    upcomingTotal: 1,
    upcomingDays: 7,
  },
  payments: UNAVAILABLE,
}

const SUMMARY = {
  clients: { active: 1234, inactive: 2 },
  amc: {
    asOf: '2026-10-27',
    contracts: { active: 12, activePastValidity: 2 },
    visits: { due: 7, overdue: 4 },
    invoicing: { readyForInvoice: { count: 5, amount: '12345.500' }, amountRequired: { count: 2 } },
  },
  projects: {
    counts: { active: 9, new: 4, inProgress: 5, readyForInvoice: 6 },
    values: { readyForInvoiceValue: '2000.250' },
    costs: { trackedExpenses: '4321.125', trackedExpensesOnCancelledProjects: '40.000' },
  },
  invoices: { issued: { count: 3, amountExclVat: '900.000', vatAmount: '45.000', totalAmount: '945.000' }, cancelled: { count: 0 }, projects: null },
}

const VISIT = {
  id: '501',
  contract: { id: '41', status: 'ACTIVE', systemDescription: 'FIRE ALARM', maintenanceFrequency: 'QUARTERLY' },
  client: { id: '1', name: 'Harbour Hotel' },
  sequenceNo: 3,
  periodStart: '2026-10-01',
  periodEnd: '2026-12-31',
  originalScheduledDate: '2026-10-27',
  scheduledDate: '2026-10-27',
  isRescheduled: false,
  isOverdue: false,
  assignedTo: 'R. Engineer',
  assignedToOverride: null,
  status: 'COMPLETED',
  completedDate: '2026-10-27',
  completedBy: null,
  workPerformed: null,
  executionNotes: null,
  statusReason: null,
  notes: null,
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-01T08:00:00.000Z',
  visitAmount: '405.125',
  amountIsCustom: false,
  invoiceEligibility: 'INVOICED',
}

const invoice = (id: string, invoiceNumber: string, status: 'ISSUED' | 'CANCELLED' = 'ISSUED') => ({
  id,
  invoiceNumber,
  client: { id: '1', name: 'Harbour Hotel' },
  invoiceDate: '2026-10-20',
  amountExclVat: '400.000',
  vatAmount: '20.000',
  totalAmount: '420.000',
  status,
  source: 'ZOHO',
  sourceReference: null,
  notes: null,
  cancelledAt: null,
  cancelledBy: null,
  cancellationReason: null,
  createdBy: { id: '1', fullName: 'Asha Admin' },
  createdAt: '2026-10-20T08:00:00.000Z',
  updatedAt: '2026-10-20T08:00:00.000Z',
  allocations: [],
})

const READINESS = {
  checkedAt: '2026-10-27T08:00:00.000Z',
  checks: [
    { id: 'api', label: 'API', state: 'OK', detail: 'The API answered this request.' },
    { id: 'database', label: 'Database', state: 'OK', detail: 'Connected.' },
    { id: 'migrations', label: 'Database updates', state: 'ATTENTION', detail: '5 of 24 database updates are not applied: 0070, 0071, 0072, 0073, 0074.' },
    { id: 'backup', label: 'Last verified backup', state: 'UNAVAILABLE', detail: 'STSLV AMC does not record backups.' },
  ],
}

type Overrides = Partial<Record<'operations' | 'summary' | 'readiness' | 'invoices' | 'visit' | 'calendar' | 'dayVisits', (request: MockRequest) => MockReply | Promise<MockReply>>>

function dashboardApi(user: SessionUser, overrides: Overrides = {}) {
  signIn()

  return mockApi((request) => {
    if (request.path === '/auth/me') return ok({ user })
    if (request.path === '/notifications') return ok({ items: [], unread: 0 })
    if (request.path === '/dashboard/operations') return overrides.operations?.(request) ?? ok(OPERATIONS)
    if (request.path === '/dashboard/summary') return overrides.summary?.(request) ?? ok(SUMMARY)
    if (request.path === '/dashboard/readiness') return overrides.readiness?.(request) ?? ok(READINESS)
    if (request.path === '/dashboard/calendar')
      return overrides.calendar?.(request) ?? ok({ month: request.query.get('month'), days: [{ date: '2026-10-27', total: 2, completed: 1, open: 1, overdue: 0 }] })
    if (request.path === '/amc/visits/501') return overrides.visit?.(request) ?? ok(VISIT)
    if (request.path === '/amc/visits') return overrides.dayVisits?.(request) ?? ok({ items: [VISIT], total: 1, page: 1, pageSize: 50, totals: { visitAmount: '405.125', amountMissingCount: 0 } })
    if (request.path === '/invoices') {
      if (overrides.invoices) return overrides.invoices(request)
      if (request.query.get('amcVisitId')) return ok({ items: [invoice('9', 'INV-0091')], total: 1, page: 1, pageSize: 10, totals: {} })
      return ok({ items: [invoice('9', 'INV-0091'), invoice('8', 'INV-0090', 'CANCELLED')], total: 12, page: Number(request.query.get('page') ?? 1), pageSize: 8, totals: {} })
    }
    return undefined
  })
}

const withPermissions = (permissions: string[]): SessionUser => ({ ...ACCOUNTANT, permissions })

async function kpiCard(label: string) {
  const strip = await screen.findByRole('list', { name: 'Key figures' })
  const heading = await within(strip).findByRole('heading', { name: label })

  return heading.closest('[data-kpi]') as HTMLElement
}

const kpiOrder = () => [...document.querySelectorAll('[data-kpi]')].map((card) => card.getAttribute('data-kpi'))

describe('KPI cards', () => {
  it('shows the seven KPIs from the API, formatted, each with its code', async () => {
    dashboardApi(ADMIN)
    renderApp('/dashboard')

    const active = await kpiCard('Active AMC')
    expect(await within(active).findByText('12')).toBeInTheDocument()
    expect(within(active).getByText(/2 past validity/)).toBeInTheDocument()
    expect(within(active).getByText('AMC')).toBeInTheDocument()

    const value = await kpiCard('Active AMC Value')
    expect(within(value).getByText('8,010.500')).toBeInTheDocument()
    expect(within(value).getByText(/not annualised/)).toBeInTheDocument()

    const credit = await kpiCard('Total Final Credit')
    expect(within(credit).getByText('300.501')).toBeInTheDocument()
    expect(within(credit).getByText(/meaning not yet confirmed, not revenue/)).toBeInTheDocument()

    const services = await kpiCard('Services This Month')
    expect(within(services).getByText('9')).toBeInTheDocument()
    expect(within(services).getByText(/4 completed, 5 open/)).toBeInTheDocument()

    const expiring = await kpiCard('Expiring ≤45 Days')
    expect(within(expiring).getByText('3')).toBeInTheDocument()
    expect(within(expiring).getByText(/within 45 days · 1 with a renewal/)).toBeInTheDocument()
    expect(kpiOrder()).toEqual(['active', 'value', 'credit', 'services', 'unpaid', 'paid', 'expiring'])
  })

  it('shows unpaid and paid invoices as not available, never as a number', async () => {
    dashboardApi(ADMIN)
    renderApp('/dashboard')

    for (const label of ['Unpaid Invoices', 'Paid This Month']) {
      const card = await kpiCard(label)

      expect(await within(card).findByText('Not available')).toBeInTheDocument()
      expect(within(card).getByText(/Payment is not recorded/)).toBeInTheDocument()
      expect(within(card).queryByText(/^\d/)).not.toBeInTheDocument()
    }
  })

  it('shows a role only the KPIs its permissions allow, and only what the API returned', async () => {
    dashboardApi(withPermissions(['DASHBOARD:VIEW', 'AMC_SCHEDULE:VIEW']), {
      operations: () => ok({ ...OPERATIONS, kpis: { ...OPERATIONS.kpis, contracts: null, unpaidInvoices: null, paidThisMonth: null }, portfolio: null, expiring: null, payments: null }),
    })
    renderApp('/dashboard')

    await kpiCard('Services This Month')
    expect(kpiOrder()).toEqual(['services'])
    expect(screen.queryByText('8,010.500')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'AMC Portfolio Status' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Payment Trend' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Production Readiness' })).not.toBeInTheDocument()
  })

  it('hides a card whose section the API left out even if the role seems to allow it', async () => {
    dashboardApi(ADMIN, { operations: () => ok({ ...OPERATIONS, kpis: { ...OPERATIONS.kpis, contracts: null } }) })
    renderApp('/dashboard')

    await kpiCard('Services This Month')
    expect(kpiOrder()).toEqual(['services', 'unpaid', 'paid'])
  })

  it('reports a failure without inventing a figure, and recovers on retry', async () => {
    let failing = true
    dashboardApi(ADMIN, { operations: () => (failing ? fail(500, 'INTERNAL_ERROR', 'An unexpected error occurred.') : ok(OPERATIONS)) })
    renderApp('/dashboard')

    expect(await screen.findByText(/The dashboard figures could not be loaded/)).toBeInTheDocument()
    expect(screen.getByText('System unreachable')).toBeInTheDocument()
    const card = await kpiCard('Active AMC')
    expect(within(card).getByText('Could not be loaded')).toBeInTheDocument()
    expect(card.textContent).not.toMatch(/\d/)

    failing = false
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await within(await kpiCard('Active AMC')).findByText('12')).toBeInTheDocument()
    expect(screen.getByText('System online')).toBeInTheDocument()
  })
})

describe('KPI layout preferences', () => {
  it('moves cards, remembers the order for this user and resets it', async () => {
    dashboardApi(ADMIN)
    const view = renderApp('/dashboard')

    await kpiCard('Active AMC')
    await userEvent.click(screen.getByRole('button', { name: 'Arrange KPIs' }))
    await userEvent.click(screen.getByRole('button', { name: 'Move Active AMC later' }))
    expect(kpiOrder().slice(0, 2)).toEqual(['value', 'active'])
    expect(screen.getByRole('button', { name: 'Move Active AMC Value earlier' })).toBeDisabled()

    expect(JSON.parse(localStorage.getItem('stslev.dashboard.kpi-order.1') ?? '[]').slice(0, 2)).toEqual(['value', 'active'])

    // The order survives a reload.
    view.unmount()
    renderApp('/dashboard')
    await kpiCard('Active AMC')
    expect(kpiOrder().slice(0, 2)).toEqual(['value', 'active'])

    await userEvent.click(screen.getByRole('button', { name: 'Reset KPI Layout' }))
    expect(kpiOrder().slice(0, 2)).toEqual(['active', 'value'])
    expect(localStorage.getItem('stslev.dashboard.kpi-order.1')).toBeNull()
  })

  it('moves a card past the ones the user cannot see', async () => {
    // Saved order puts a contract card between two invoice cards; this role sees no contract cards.
    localStorage.setItem('stslev.dashboard.kpi-order.2', JSON.stringify(['unpaid', 'active', 'paid', 'value', 'credit', 'services', 'expiring']))
    dashboardApi(withPermissions(['DASHBOARD:VIEW', 'INVOICES:VIEW']), {
      operations: () => ok({ ...OPERATIONS, kpis: { ...OPERATIONS.kpis, contracts: null, services: null }, portfolio: null, expiring: null, workload: null, schedule: null }),
    })
    renderApp('/dashboard')

    await kpiCard('Unpaid Invoices')
    expect(kpiOrder()).toEqual(['unpaid', 'paid'])
    await userEvent.click(screen.getByRole('button', { name: 'Arrange KPIs' }))
    await userEvent.click(screen.getByRole('button', { name: 'Move Unpaid Invoices later' }))
    expect(kpiOrder()).toEqual(['paid', 'unpaid'])
  })

  it('keeps saved ids that still exist and adds new cards at the end', () => {
    expect(orderedIds(['b', 'gone', 'a', 'b'], ['a', 'b', 'c'])).toEqual(['b', 'a', 'c'])
    expect(orderedIds(null, ['a', 'b'])).toEqual(['a', 'b'])
  })
})

describe('maintenance calendar', () => {
  it('lists today’s work and the next days, and opens service details', async () => {
    dashboardApi(ADMIN)
    renderApp('/dashboard')

    const panel = (await screen.findByRole('heading', { name: 'Daily operations — AMC Maintenance Calendar' })).closest('section') as HTMLElement
    expect(within(panel).getByText(/Today · 27 Oct 2026/)).toBeInTheDocument()
    expect(within(panel).getByText('City Tower')).toBeInTheDocument()
    expect(within(panel).getByRole('link', { name: 'Open full calendar →' })).toHaveAttribute('href', '/amc/calendar')

    await userEvent.click(within(panel).getByRole('button', { name: /Service details: Harbour Hotel, FIRE ALARM, 27 Oct 2026/ }))

    const details = within(panel).getByRole('region', { name: 'Service details' })
    expect(await within(details).findByText('Quarterly')).toBeInTheDocument()
    expect(within(details).getByRole('link', { name: 'Contract record 41' })).toHaveAttribute('href', '/amc/contracts/41')
    expect(within(details).getByText('R. Engineer')).toBeInTheDocument()
    expect(within(details).getByText('405.125')).toBeInTheDocument()
    expect(within(details).getByText('Invoiced')).toBeInTheDocument()
    expect(await within(details).findByText('INV-0091')).toBeInTheDocument()
    expect(within(details).getByText('Not tracked in STSLV AMC')).toBeInTheDocument()
  })

  it('does not ask for invoice numbers without Invoice Tracking access', async () => {
    const api = dashboardApi(withPermissions(['DASHBOARD:VIEW', 'AMC_SCHEDULE:VIEW']), {
      operations: () => ok({ ...OPERATIONS, kpis: { ...OPERATIONS.kpis, contracts: null, unpaidInvoices: null, paidThisMonth: null }, portfolio: null, expiring: null, payments: null }),
    })
    renderApp('/dashboard')

    await userEvent.click(await screen.findByRole('button', { name: /Service details: Harbour Hotel/ }))
    expect(await screen.findByText('Needs Invoice Tracking access')).toBeInTheDocument()
    expect(api.find('GET', '/invoices')).toHaveLength(0)
  })

  it('shows counts per day, lists a day’s services, and collapses with the choice remembered', async () => {
    const api = dashboardApi(ADMIN)
    const view = renderApp('/dashboard')

    const grid = await screen.findByRole('grid', { name: 'Visits in October 2026' })
    await userEvent.click(within(grid).getByRole('button', { name: '27 Oct 2026: 2 visits' }))
    expect(await screen.findByRole('heading', { name: 'Services on 27 Oct 2026' })).toBeInTheDocument()
    const dayRequest = api.find('GET', '/amc/visits')[0]
    expect(dayRequest?.query.get('from')).toBe('2026-10-27')
    expect(dayRequest?.query.get('to')).toBe('2026-10-27')
    // Days without visits cannot be opened.
    expect(within(grid).getByRole('button', { name: '01 Oct 2026: no visits' })).toBeDisabled()

    await userEvent.click(screen.getByRole('button', { name: 'Next month' }))
    expect(await screen.findByRole('grid', { name: 'Visits in November 2026' })).toBeInTheDocument()
    expect(api.find('GET', '/dashboard/calendar').map((request) => request.query.get('month'))).toEqual(['2026-10', '2026-11'])

    await userEvent.click(screen.getByRole('button', { name: 'Hide calendar ▴' }))
    expect(screen.queryByRole('grid')).not.toBeInTheDocument()
    expect(localStorage.getItem('stslev.dashboard.calendar-open.1')).toBe('0')

    view.unmount()
    renderApp('/dashboard')
    expect(await screen.findByRole('button', { name: 'Show calendar ▾' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('builds whole weeks around a month', () => {
    const cells = monthCells('2026-10')

    // 1 October 2026 is a Thursday.
    expect(cells.slice(0, 5)).toEqual([null, null, null, null, '2026-10-01'])
    expect(cells.length % 7).toBe(0)
    expect(cells.filter(Boolean)).toHaveLength(31)
    expect(monthCells('2028-02').filter(Boolean)).toHaveLength(29)
  })
})

describe('charts and widgets', () => {
  it('draws the workload for six months with the same figures in a table', async () => {
    dashboardApi(ADMIN)
    renderApp('/dashboard')

    const panel = (await screen.findByRole('heading', { name: 'Upcoming Service Workload' })).closest('section') as HTMLElement
    const rows = within(panel).getAllByRole('row').slice(1)

    expect(rows.map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent))).toEqual([
      ['October 2026', '9', '4', '5'],
      ['November 2026', '7', '0', '7'],
      ['December 2026', '0', '0', '0'],
      ['January 2027', '3', '0', '3'],
      ['February 2027', '1', '0', '1'],
      ['March 2027', '2', '0', '2'],
    ])
    expect(within(panel).getByRole('link', { name: 'Schedule →' })).toHaveAttribute('href', '/amc/schedule')
  })

  it('says the payment trend is not available instead of drawing zeros', async () => {
    dashboardApi(ADMIN)
    renderApp('/dashboard')

    const panel = (await screen.findByRole('heading', { name: 'Payment Trend' })).closest('section') as HTMLElement
    expect(within(panel).getByText('Payment data not available')).toBeInTheDocument()
    expect(within(panel).queryByRole('img')).not.toBeInTheDocument()
  })

  it('breaks the portfolio down by every status with the API’s percentages', async () => {
    dashboardApi(ADMIN)
    renderApp('/dashboard')

    const panel = (await screen.findByRole('heading', { name: 'AMC Portfolio Status' })).closest('section') as HTMLElement
    const cells = within(panel)
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.lastElementChild?.textContent)

    expect(cells).toEqual(['Draft: 3 · 18.8%', 'Active: 12 · 75.0%', 'Expired: 0 · 0.0%', 'Cancelled: 1 · 6.3%'])
    expect(within(panel).getByRole('link', { name: 'AMC Contracts →' })).toHaveAttribute('href', '/amc/contracts')
  })

  it('handles an empty portfolio', async () => {
    dashboardApi(ADMIN, {
      operations: () => ok({ ...OPERATIONS, portfolio: { total: 0, statuses: OPERATIONS.portfolio!.statuses.map((s) => ({ ...s, count: 0, percent: null })) }, expiring: { ...OPERATIONS.expiring!, total: 0, pastValidity: 0, items: [] } }),
    })
    renderApp('/dashboard')

    expect(await screen.findByText('No AMC contracts recorded yet.')).toBeInTheDocument()
    expect(screen.getByText('✓ No active AMC ends in the next 90 days.')).toBeInTheDocument()
  })

  it('lists expiring contracts with days left and renewal status', async () => {
    dashboardApi(ADMIN)
    renderApp('/dashboard')

    const panel = (await screen.findByRole('heading', { name: 'Expiring Contracts' })).closest('section') as HTMLElement
    const rows = within(panel).getAllByRole('row').slice(1)

    expect(within(rows[0] as HTMLElement).getByText('Ended 1 day ago')).toBeInTheDocument()
    expect(within(rows[0] as HTMLElement).getByText('None')).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('45 days')).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByRole('link', { name: /Renewal/ })).toHaveAttribute('href', '/amc/contracts/77')
    expect(within(panel).getByText(/1 already past validity/)).toBeInTheDocument()
  })
})

describe('recent invoices', () => {
  const panel = async () => (await screen.findByRole('heading', { name: 'Recent Invoices' })).closest('section') as HTMLElement

  it('lists invoices without a paid date, pages through them, and links to Invoice Tracking', async () => {
    const api = dashboardApi(ADMIN)
    renderApp('/dashboard')

    const section = await panel()
    expect(await within(section).findByText('INV-0091')).toBeInTheDocument()
    expect(within(section).getAllByText('Not tracked')).toHaveLength(2)
    expect(within(section).getAllByText('420.000')).toHaveLength(2)
    expect(within(section).getByRole('link', { name: 'Open Invoice Tracking →' })).toHaveAttribute('href', '/invoices')

    await userEvent.click(within(section).getByRole('button', { name: 'Next' }))
    expect(api.find('GET', '/invoices').some((request) => request.query.get('page') === '2')).toBe(true)
  })

  it('searches and filters through the invoice list', async () => {
    const api = dashboardApi(ADMIN)
    renderApp('/dashboard')

    const section = await panel()
    await userEvent.type(within(section).getByLabelText('Search'), 'Harbour')
    await userEvent.selectOptions(within(section).getByRole('combobox', { name: 'Status' }), 'ISSUED')

    await screen.findByText('INV-0091')
    await new Promise((resolve) => setTimeout(resolve, 400))
    const last = api.find('GET', '/invoices').filter((request) => !request.query.get('amcVisitId')).at(-1)
    expect(last?.query.get('search')).toBe('Harbour')
    expect(last?.query.get('status')).toBe('ISSUED')
  })

  it('hides and shows columns and remembers the choice', async () => {
    dashboardApi(ADMIN)
    renderApp('/dashboard')

    const section = await panel()
    await within(section).findByText('INV-0091')
    await userEvent.click(within(section).getByText('Columns'))
    await userEvent.click(within(section).getByRole('checkbox', { name: 'Paid on' }))

    expect(within(section).queryByRole('columnheader', { name: 'Paid on' })).not.toBeInTheDocument()
    expect(within(section).queryByText('Not tracked')).not.toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('stslev.dashboard.columns.recent-invoices.1') ?? '[]')).toEqual(['paid'])
  })

  it('offers Excel and PDF only with the export permission, using the current filters', async () => {
    dashboardApi(withPermissions(['DASHBOARD:VIEW', 'INVOICES:VIEW']), {
      operations: () => ok({ ...OPERATIONS, kpis: { ...OPERATIONS.kpis, contracts: null, services: null }, portfolio: null, expiring: null, workload: null, schedule: null }),
    })
    renderApp('/dashboard')

    const section = await panel()
    await within(section).findByText('INV-0091')
    expect(within(section).queryByRole('button', { name: /Export invoices/ })).not.toBeInTheDocument()
    expect(within(section).getByText(/exports need the Invoice Tracking export permission/)).toBeInTheDocument()
  })

  it('shows export buttons to a role with INVOICES:EXPORT', async () => {
    dashboardApi(ADMIN)
    renderApp('/dashboard')

    const section = await panel()
    expect(await within(section).findByRole('button', { name: 'Export invoices to Excel' })).toBeInTheDocument()
    expect(within(section).getByRole('button', { name: 'Export invoices to PDF' })).toBeInTheDocument()
  })

  it('is not shown without Invoice Tracking access', async () => {
    const api = dashboardApi(ACCOUNTANT, { operations: () => ok({ ...OPERATIONS, kpis: { contracts: null, services: null, unpaidInvoices: null, paidThisMonth: null }, portfolio: null, expiring: null, workload: null, schedule: null, payments: null }) })
    renderApp('/dashboard')

    await screen.findByRole('heading', { name: 'AMC Operations Dashboard' })
    await screen.findByText('1,234')
    expect(screen.queryByRole('heading', { name: 'Recent Invoices' })).not.toBeInTheDocument()
    expect(api.find('GET', '/invoices')).toHaveLength(0)
  })
})

describe('production readiness', () => {
  it('shows each verified check to the Admin, with no score, and links to the existing security pages', async () => {
    dashboardApi(ADMIN)
    renderApp('/dashboard')

    const panel = (await screen.findByRole('heading', { name: 'Production Readiness' })).closest('section') as HTMLElement
    expect(await within(panel).findByText('Database updates')).toBeInTheDocument()
    expect(within(panel).getByText('Needs attention')).toBeInTheDocument()
    expect(within(panel).getByText('STSLV AMC does not record backups.')).toBeInTheDocument()
    expect(panel.textContent).not.toMatch(/\/100|score:/i)
    expect(within(panel).getByRole('link', { name: 'Login History →' })).toHaveAttribute('href', '/admin/login-history')
    expect(within(panel).queryByRole('link', { name: /Backup|Security Center/ })).not.toBeInTheDocument()
  })

  it('is not requested for a role other than the built-in Admin', async () => {
    const all = ADMIN.permissions
    const api = dashboardApi({ ...ADMIN, roles: [{ id: '5', code: 'MANAGER', name: 'Manager' }], permissions: all })
    renderApp('/dashboard')

    await kpiCard('Active AMC')
    expect(screen.queryByRole('heading', { name: 'Production Readiness' })).not.toBeInTheDocument()
    expect(api.find('GET', '/dashboard/readiness')).toHaveLength(0)
  })
})

describe('module figures', () => {
  async function card(label: string) {
    const region = await screen.findByRole('region', { name: 'Waiting for an invoice and other figures' })
    const heading = await within(region).findByRole('heading', { name: label, level: 3 })

    return heading.closest('[data-metric-card]') as HTMLElement
  }

  it('keeps the clients, ready-for-invoice and finance figures, without links to retired pages', async () => {
    dashboardApi(ADMIN)
    renderApp('/dashboard')

    const region = await screen.findByRole('region', { name: 'Waiting for an invoice and other figures' })
    await within(region).findByText('1,234')
    expect(within(region).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
      'Active Clients',
      'Visits Due',
      'Ready for Invoice',
      'Tracked Expenses',
      'Invoices Recorded',
      'Ready-for-Invoice Value',
    ])
    const hrefs = within(region).queryAllByRole('link').map((link) => link.getAttribute('href'))
    expect(hrefs).not.toContain('/projects')
    expect(hrefs).not.toContain('/amc/execution')
    expect(within(await card('Visits Due')).getByRole('link', { name: 'View schedule' })).toHaveAttribute('href', '/amc/schedule')
  })

  it('shows the AMC and project amounts waiting for an invoice as two separate values', async () => {
    dashboardApi(ADMIN)
    renderApp('/dashboard')

    const value = await card('Ready-for-Invoice Value')
    const rows = (await within(value).findAllByRole('term')).map((term) => [term.textContent, (term.nextElementSibling as HTMLElement).textContent])

    expect(rows).toEqual([
      ['AMC As entered', '12,345.500'],
      ['Projects Excl. VAT', '2,000.250'],
    ])
    expect(value.textContent).not.toMatch(/14,?345\.75/)
  })

  it('reads the figures again when Refresh is pressed', async () => {
    const api = dashboardApi(ADMIN)
    renderApp('/dashboard')

    await card('Active Clients')
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    await screen.findByRole('button', { name: 'Refresh' })
    expect(api.find('GET', '/dashboard/summary').length).toBeGreaterThanOrEqual(2)
    expect(api.find('GET', '/dashboard/operations').length).toBeGreaterThanOrEqual(2)
  })
})

describe('a metric with no data source', () => {
  it('is marked "Not yet available" and never shows a number', () => {
    render(
      <MemoryRouter>
        <MetricCard metric={{ id: 'invoices.pending', label: 'Pending Invoices', visible: () => true, source: 'Invoice Tracking' }} state={{ kind: 'unavailable' }} />
      </MemoryRouter>,
    )

    const card = screen.getByRole('heading', { name: 'Pending Invoices' }).closest('[data-metric-card]') as HTMLElement

    expect(within(card).getByText('Not yet available')).toBeInTheDocument()
    expect(card.textContent).not.toMatch(/\d/)
  })
})

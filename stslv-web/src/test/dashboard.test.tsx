import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '../lib/types'
import { orderedIds } from '../pages/dashboard/dashboardPreferences'
import { monthName } from '../pages/dashboard/kpis'
import { MetricCard } from '../pages/dashboard/MetricCard'
import type { OperationsDashboard } from '../pages/dashboard/operationsTypes'
import { ACCOUNTANT, ADMIN, fail, mockApi, ok, renderApp, signIn, type MockReply, type MockRequest } from './helpers'

// The AMC Operations Dashboard. The API is mocked: every figure here is a
// fixture, and each test checks that the page shows exactly what the API sent.


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
    services: { thisMonth: 9, completedThisMonth: 4, openThisMonth: 5, overall: 140, openOverall: 96 },
    payments: {
      paid: 3,
      paidValue: '240.000',
      unpaid: 8,
      unpaidValue: '640.500',
      paidThisMonth: 2,
      paidThisMonthValue: '160.000',
      scheduledThisMonth: { withInvoiceNo: 1, withInvoiceNoValue: '80.000', withoutInvoiceNo: 6, withoutInvoiceNoValue: '480.375' },
    },
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
      { id: '41', reference: 'AMC-0041', client: { id: '1', name: 'Harbour Hotel' }, systemDescription: 'FIRE ALARM', validTo: '2026-10-26', daysLeft: -1, renewal: null },
      { id: '42', reference: 'AMC-0042', client: { id: '2', name: 'City Tower' }, systemDescription: 'CCTV', validTo: '2026-12-11', daysLeft: 45, renewal: { id: '77', reference: 'AMC-0077', status: 'DRAFT' } },
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
  paymentTrend: {
    months: [
      { month: '2026-06', count: 0, value: '0.000' },
      { month: '2026-07', count: 0, value: '0.000' },
      { month: '2026-08', count: 0, value: '0.000' },
      { month: '2026-09', count: 0, value: '0.000' },
      { month: '2026-10', count: 1, value: '80.000' },
      { month: '2026-11', count: 2, value: '160.000' },
    ],
  },
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
  contract: { id: '41', reference: 'AMC-0041', status: 'ACTIVE', systemDescription: 'FIRE ALARM', maintenanceFrequency: 'QUARTERLY' },
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

const UPCOMING_VISIT = {
  ...VISIT,
  id: '502',
  contract: { id: '42', reference: 'AMC-0042', status: 'ACTIVE', systemDescription: 'CCTV', maintenanceFrequency: 'MONTHLY' },
  client: { id: '2', name: 'City Tower' },
  scheduledDate: '2026-10-30',
  originalScheduledDate: '2026-10-30',
  assignedTo: null,
  status: 'SCHEDULED',
  completedDate: null,
  visitAmount: '120.000',
  invoiceEligibility: 'NOT_COMPLETED',
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
    if (request.path === '/amc/visits/502') return ok(UPCOMING_VISIT)
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

const ROW_TITLES = { portfolio: 'AMC Portfolio', month: 'Current Month', overall: 'Overall' } as const
type RowKey = keyof typeof ROW_TITLES

/** A row of key figures. Rows 2 and 3 share card names, so cards are always found within their row. */
async function kpiRow(row: RowKey) {
  return screen.findByRole('list', { name: ROW_TITLES[row] })
}

async function kpiCard(label: string, row: RowKey = 'portfolio') {
  const heading = await within(await kpiRow(row)).findByRole('heading', { name: label })

  return heading.closest('[data-kpi]') as HTMLElement
}

const kpiOrder = () => [...document.querySelectorAll('[data-kpi]')].map((card) => card.getAttribute('data-kpi'))
const labelsOf = (list: HTMLElement) => within(list).getAllByRole('heading').map((heading) => heading.textContent)

const TWELVE_IDS = [
  'active', 'value', 'credit', 'expiring',
  'month-services', 'month-pending', 'month-invoiced', 'month-not-invoiced',
  'overall-services', 'overall-pending', 'overall-invoiced', 'overall-not-invoiced',
]

describe('KPI cards', () => {
  it('shows exactly twelve cards in three rows of four, in the client’s order and wording', async () => {
    dashboardApi(ADMIN)
    renderApp('/dashboard')

    expect(labelsOf(await kpiRow('portfolio'))).toEqual(['Active AMCs', 'Annual AMC Value (Ex VAT)', 'Final Credit (Ex VAT)', 'Expiring ≤45 Days'])
    expect(labelsOf(await kpiRow('month'))).toEqual(['Services This Month', 'Services Pending', 'Invoices Generated', 'Invoices Not Generated'])
    expect(labelsOf(await kpiRow('overall'))).toEqual(['Services Overall', 'Services Pending', 'Invoices Generated', 'Invoices Not Generated'])
    expect(kpiOrder()).toEqual(TWELVE_IDS)
    // The rows say which period they cover; the month comes from the API's date.
    expect(screen.getByText('Services scheduled in October 2026')).toBeInTheDocument()
    expect(screen.getByText(/All service records, earlier years and visits ahead/)).toBeInTheDocument()
  })

  it('shows the portfolio figures from the API, amounts in OMR with three decimals', async () => {
    dashboardApi(ADMIN)
    renderApp('/dashboard')

    const active = await kpiCard('Active AMCs')
    expect(await within(active).findByText('12')).toBeInTheDocument()
    expect(within(active).getByText(/2 past validity/)).toBeInTheDocument()

    const value = await kpiCard('Annual AMC Value (Ex VAT)')
    expect(within(value).getByText('8,010.500')).toBeInTheDocument()
    expect(within(value).getByText('OMR')).toBeInTheDocument()
    expect(within(value).getByTitle(/may be whole-term amounts/)).toBeInTheDocument()

    const credit = await kpiCard('Final Credit (Ex VAT)')
    expect(within(credit).getByText('300.501')).toBeInTheDocument()
    expect(within(credit).getByText('Entered on 2 of 12 active contracts')).toBeInTheDocument()

    const expiring = await kpiCard('Expiring ≤45 Days')
    expect(within(expiring).getByText('3')).toBeInTheDocument()
    expect(within(expiring).getByText(/within 45 days · 1 with a renewal/)).toBeInTheDocument()
  })

  it('reads the current-month row and the overall row from different API figures', async () => {
    dashboardApi(ADMIN)
    renderApp('/dashboard')

    const figure = async (label: string, row: RowKey) => (await kpiCard(label, row)).querySelector('p')?.textContent

    expect(await figure('Services This Month', 'month')).toBe('9')
    expect(await figure('Services Pending', 'month')).toBe('5')
    expect(await figure('Invoices Generated', 'month')).toBe('1')
    expect(await figure('Invoices Not Generated', 'month')).toBe('6')
    expect(within(await kpiCard('Invoices Generated', 'month')).getByText(/OMR 80\.000 · Invoice No\. entered/)).toBeInTheDocument()
    expect(within(await kpiCard('Invoices Not Generated', 'month')).getByText(/OMR 480\.375 · no Invoice No\./)).toBeInTheDocument()

    expect(await figure('Services Overall', 'overall')).toBe('140')
    expect(await figure('Services Pending', 'overall')).toBe('96')
    expect(await figure('Invoices Generated', 'overall')).toBe('3')
    expect(await figure('Invoices Not Generated', 'overall')).toBe('8')
    expect(within(await kpiCard('Invoices Generated', 'overall')).getByText(/OMR 240\.000/)).toBeInTheDocument()
    expect(within(await kpiCard('Invoices Not Generated', 'overall')).getByText(/OMR 640\.500/)).toBeInTheDocument()
  })

  it('says an entered Invoice No. is a reference status, not verified payment', async () => {
    dashboardApi(ADMIN)
    renderApp('/dashboard')

    for (const row of ['month', 'overall'] as const) {
      const card = await kpiCard('Invoices Generated', row)
      expect(within(card).getByTitle(/does not verify that money was received/)).toBeInTheDocument()
    }
  })

  it('shows zeros, not blanks, for an empty database', async () => {
    dashboardApi(ADMIN, {
      operations: () =>
        ok({
          ...OPERATIONS,
          kpis: {
            contracts: { active: 0, activePastValidity: 0, activeValue: '0.000', finalCreditTotal: '0.000', finalCreditRecorded: 0, expiringSoon: 0, expiringSoonDays: 45, expiringSoonWithRenewal: 0 },
            services: { thisMonth: 0, completedThisMonth: 0, openThisMonth: 0, overall: 0, openOverall: 0 },
            payments: {
              paid: 0, paidValue: '0.000', unpaid: 0, unpaidValue: '0.000', paidThisMonth: 0, paidThisMonthValue: '0.000',
              scheduledThisMonth: { withInvoiceNo: 0, withInvoiceNoValue: '0.000', withoutInvoiceNo: 0, withoutInvoiceNoValue: '0.000' },
            },
          },
        }),
    })
    renderApp('/dashboard')

    await kpiCard('Active AMCs')
    const figures = [...document.querySelectorAll('[data-kpi]')].map((card) => card.querySelector('p')?.textContent)
    expect(figures).toEqual(['0', 'OMR0.000', 'OMR0.000', '0', '0', '0', '0', '0', '0', '0', '0', '0'])
  })

  it('has no links or buttons on the cards and no arranging', async () => {
    dashboardApi(ADMIN)
    renderApp('/dashboard')

    await kpiCard('Active AMCs')
    for (const card of document.querySelectorAll('[data-kpi]')) {
      expect(card.querySelector('a, button, input, [role="button"]')).toBeNull()
      expect(card.getAttribute('draggable')).toBeNull()
    }
    expect(screen.queryByRole('button', { name: 'Arrange KPIs' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reset KPI Layout' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reset KPI Names' })).not.toBeInTheDocument()
  })

  it('keeps the fixed order whatever the old Arrange KPIs saved, and leaves the saved choice in place', async () => {
    localStorage.setItem('stslev.dashboard.kpi-order.1', JSON.stringify(['expiring', 'paid', 'unpaid', 'services', 'credit', 'value', 'active']))
    localStorage.setItem('stslev.dashboard.kpis.kpi-names.1', JSON.stringify({ active: 'My contracts' }))
    dashboardApi(ADMIN)
    renderApp('/dashboard')

    await kpiCard('Active AMCs')
    expect(kpiOrder()).toEqual(TWELVE_IDS)
    expect(screen.queryByRole('heading', { name: 'My contracts' })).not.toBeInTheDocument()
    expect(localStorage.getItem('stslev.dashboard.kpi-order.1')).not.toBeNull()
  })

  it('shows a role only the cards and rows its permissions allow, and only what the API returned', async () => {
    dashboardApi(withPermissions(['DASHBOARD:VIEW', 'AMC_SCHEDULE:VIEW']), {
      operations: () => ok({ ...OPERATIONS, kpis: { ...OPERATIONS.kpis, contracts: null, payments: null }, portfolio: null, expiring: null, paymentTrend: null }),
    })
    renderApp('/dashboard')

    await kpiCard('Services This Month', 'month')
    expect(kpiOrder()).toEqual(['month-services', 'month-pending', 'overall-services', 'overall-pending'])
    expect(screen.queryByRole('list', { name: 'AMC Portfolio' })).not.toBeInTheDocument()
    expect(screen.queryByText('8,010.500')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'AMC Portfolio Status' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Payment Trend' })).not.toBeInTheDocument()
  })

  it('hides a card whose section the API left out even if the role seems to allow it', async () => {
    dashboardApi(ADMIN, { operations: () => ok({ ...OPERATIONS, kpis: { ...OPERATIONS.kpis, contracts: null } }) })
    renderApp('/dashboard')

    await kpiCard('Services This Month', 'month')
    expect(kpiOrder()).toEqual(TWELVE_IDS.slice(4))
  })

  it('reports a failure without inventing a figure, and recovers on retry', async () => {
    let failing = true
    dashboardApi(ADMIN, { operations: () => (failing ? fail(500, 'INTERNAL_ERROR', 'An unexpected error occurred.') : ok(OPERATIONS)) })
    renderApp('/dashboard')

    expect(await screen.findByText(/The dashboard figures could not be loaded/)).toBeInTheDocument()
    expect(screen.getByText('System unreachable')).toBeInTheDocument()
    const card = await kpiCard('Active AMCs')
    expect(within(card).getByText('Could not be loaded')).toBeInTheDocument()
    expect(card.textContent).not.toMatch(/\d/)

    failing = false
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await within(await kpiCard('Active AMCs')).findByText('12')).toBeInTheDocument()
    expect(screen.getByText('System online')).toBeInTheDocument()
  })
})

describe('KPI preferences helper', () => {
  it('keeps saved ids that still exist and adds new cards at the end', () => {
    expect(orderedIds(['b', 'gone', 'a', 'b'], ['a', 'b', 'c'])).toEqual(['b', 'a', 'c'])
    expect(orderedIds(null, ['a', 'b'])).toEqual(['a', 'b'])
  })
})

describe('month name', () => {
  it('reads the API date as a calendar date across year boundaries', () => {
    expect(monthName('2026-12-31')).toBe('December 2026')
    expect(monthName('2027-01-01')).toBe('January 2027')
    expect(monthName('')).toBe('this month')
  })
})

describe('maintenance calendar', () => {
  it('lists today’s work and the next days, and opens service details', async () => {
    dashboardApi(ADMIN)
    renderApp('/dashboard')

    const panel = (await screen.findByRole('heading', { name: 'AMC Maintenance Calendar' })).closest('section') as HTMLElement
    expect(within(panel).getByText(/Today · 27 Oct 2026/)).toBeInTheDocument()
    expect(within(panel).getByText('City Tower')).toBeInTheDocument()
    expect(within(panel).getByText('Next 7 days')).toBeInTheDocument()
    // The month grid, its navigation, legend and buttons are no longer on the dashboard.
    expect(within(panel).queryByRole('grid')).not.toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: /calendar/i })).not.toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: /month/i })).not.toBeInTheDocument()
    expect(within(panel).queryByRole('link', { name: /full calendar/i })).not.toBeInTheDocument()

    await userEvent.click(within(panel).getByRole('button', { name: /Service details: Harbour Hotel, FIRE ALARM, 27 Oct 2026/ }))

    const details = within(panel).getByRole('region', { name: 'Service details' })
    expect(await within(details).findByText('Quarterly')).toBeInTheDocument()
    expect(within(details).getByRole('link', { name: 'AMC-0041' })).toHaveAttribute('href', '/amc/contracts/41')
    expect(within(details).getByText('R. Engineer')).toBeInTheDocument()
    expect(within(details).getByText('405.125')).toBeInTheDocument()
    expect(within(details).getByText('Invoiced')).toBeInTheDocument()
    expect(within(details).getByText('Zoho invoices')).toBeInTheDocument()
    expect(await within(details).findByText('INV-0091')).toBeInTheDocument()
    expect(within(details).getByText('Invoice No.')).toBeInTheDocument()
    expect(within(details).getByText('None entered')).toBeInTheDocument()
    expect(within(details).getByText('Unpaid')).toBeInTheDocument()
  })

  it('does not ask for invoice numbers without Invoice Tracking access', async () => {
    const api = dashboardApi(withPermissions(['DASHBOARD:VIEW', 'AMC_SCHEDULE:VIEW']), {
      operations: () => ok({ ...OPERATIONS, kpis: { ...OPERATIONS.kpis, contracts: null, payments: null }, portfolio: null, expiring: null, paymentTrend: null }),
    })
    renderApp('/dashboard')

    await userEvent.click(await screen.findByRole('button', { name: /Service details: Harbour Hotel/ }))
    expect(await screen.findByText('Needs Invoice Tracking access')).toBeInTheDocument()
    expect(api.find('GET', '/invoices')).toHaveLength(0)
  })

  it('shows a Next 7 days service in Service details and does not load a month calendar', async () => {
    const api = dashboardApi(ADMIN)
    renderApp('/dashboard')

    const panel = (await screen.findByRole('heading', { name: 'AMC Maintenance Calendar' })).closest('section') as HTMLElement
    const details = within(panel).getByRole('region', { name: 'Service details' })
    expect(within(details).getByText('Select a service from today’s work or the next days.')).toBeInTheDocument()

    await userEvent.click(within(panel).getByRole('button', { name: /Service details: Harbour Hotel/ }))
    expect(await within(details).findByText('Quarterly')).toBeInTheDocument()

    await userEvent.click(within(panel).getByRole('button', { name: /Service details: City Tower, CCTV, 30 Oct 2026/ }))
    expect(await within(details).findByText('Monthly')).toBeInTheDocument()
    expect(within(details).getByRole('link', { name: 'AMC-0042' })).toHaveAttribute('href', '/amc/contracts/42')
    expect(within(details).getByText('Not completed')).toBeInTheDocument()
    expect(within(details).queryByText('Harbour Hotel')).not.toBeInTheDocument()

    await userEvent.click(within(details).getByRole('button', { name: 'Clear' }))
    expect(within(details).getByText('Select a service from today’s work or the next days.')).toBeInTheDocument()
    expect(api.find('GET', '/dashboard/calendar')).toHaveLength(0)
  })
})

describe('charts and widgets', () => {
  it('draws the workload for six months with the same figures in a table', async () => {
    dashboardApi(ADMIN)
    renderApp('/dashboard')

    const panel = (await screen.findByRole('heading', { name: 'Upcoming Service Workload' })).closest('section') as HTMLElement
    expect(within(panel).queryByRole('table')).not.toBeInTheDocument()
    await userEvent.click(within(panel).getByRole('button', { name: 'Show as table' }))
    expect(within(panel).queryByRole('img')).not.toBeInTheDocument()
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

  it('draws the payment trend from the API and says Paid is a reference status', async () => {
    dashboardApi(ADMIN)
    renderApp('/dashboard')

    const panel = (await screen.findByRole('heading', { name: 'Payment Trend' })).closest('section') as HTMLElement
    expect(within(panel).getByText('160.000')).toBeInTheDocument()
    expect(within(panel).getByText('2026-11')).toBeInTheDocument()
    expect(within(panel).getByText(/does not verify that money was received/)).toBeInTheDocument()
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
  const panel = async () => (await screen.findByRole('heading', { name: 'Recent Invoices (Zoho)' })).closest('section') as HTMLElement

  it('lists invoices without a paid date, pages through them, and links to Invoice Tracking', async () => {
    const api = dashboardApi(ADMIN)
    renderApp('/dashboard')

    const section = await panel()
    expect(await within(section).findByText('INV-0091')).toBeInTheDocument()
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
    await userEvent.click(within(section).getByRole('checkbox', { name: 'Status' }))

    expect(within(section).queryByRole('columnheader', { name: 'Status' })).not.toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('stslev.dashboard.columns.recent-invoices.1') ?? '[]')).toEqual(['status'])
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
    const api = dashboardApi(ACCOUNTANT, { operations: () => ok({ ...OPERATIONS, kpis: { contracts: null, services: null, payments: null }, portfolio: null, expiring: null, workload: null, schedule: null, payments: null }) })
    renderApp('/dashboard')

    await screen.findByRole('heading', { name: 'AMC Operations Dashboard' })
    await screen.findByText(/Figures as of/)
    expect(screen.queryByRole('heading', { name: 'Recent Invoices (Zoho)' })).not.toBeInTheDocument()
    expect(api.find('GET', '/invoices')).toHaveLength(0)
  })
})

describe('dashboard detail panels', () => {
  const PANELS = ['AMC Portfolio Status', 'Expiring Contracts', 'Recent Invoices (Zoho)']
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('are hidden by default, when VITE_SHOW_DASHBOARD_DETAIL_PANELS is not set', async () => {
    vi.stubEnv('VITE_SHOW_DASHBOARD_DETAIL_PANELS', undefined)
    const api = dashboardApi(ADMIN)
    renderApp('/dashboard')

    await kpiCard('Active AMCs')
    for (const name of PANELS) expect(screen.queryByRole('heading', { name })).not.toBeInTheDocument()
    // The recent-invoices list is not requested when its panel is hidden.
    expect(api.find('GET', '/invoices')).toHaveLength(0)
  })

  it('stay hidden for any value other than "true"', async () => {
    vi.stubEnv('VITE_SHOW_DASHBOARD_DETAIL_PANELS', 'false')
    dashboardApi(ADMIN)
    renderApp('/dashboard')

    await kpiCard('Active AMCs')
    for (const name of PANELS) expect(screen.queryByRole('heading', { name })).not.toBeInTheDocument()
  })

  it('all three show when the setting is "true"', async () => {
    vi.stubEnv('VITE_SHOW_DASHBOARD_DETAIL_PANELS', 'true')
    const api = dashboardApi(ADMIN)
    renderApp('/dashboard')

    for (const name of PANELS) expect(await screen.findByRole('heading', { name })).toBeInTheDocument()
    await waitFor(() => expect(api.find('GET', '/invoices').length).toBeGreaterThan(0))
  })
})

describe('production readiness', () => {
  it('is not shown or requested, even for the built-in Admin', async () => {
    const api = dashboardApi(ADMIN)
    renderApp('/dashboard')

    await kpiCard('Active AMCs')
    await screen.findByRole('heading', { name: 'Recent Invoices (Zoho)' })
    expect(screen.queryByRole('heading', { name: 'Production Readiness' })).not.toBeInTheDocument()
    expect(api.find('GET', '/dashboard/readiness')).toHaveLength(0)
  })
})

describe('module figures', () => {
  it('are not shown, and their summary is not requested, even for the built-in Admin', async () => {
    const api = dashboardApi(ADMIN)
    renderApp('/dashboard')

    await kpiCard('Active AMCs')
    await screen.findByRole('heading', { name: 'Recent Invoices (Zoho)' })
    expect(screen.queryByRole('region', { name: 'Waiting for an invoice and other figures' })).not.toBeInTheDocument()
    for (const label of ['Active Clients', 'Visits Due', 'Ready for Invoice', 'Tracked Expenses', 'Invoices Recorded', 'Ready-for-Invoice Value']) {
      expect(screen.queryByRole('heading', { name: label, level: 3 })).not.toBeInTheDocument()
    }
    expect(document.querySelector('[data-metric-card]')).toBeNull()
    expect(api.find('GET', '/dashboard/summary')).toHaveLength(0)
  })

  it('reads the figures again when Refresh is pressed', async () => {
    const api = dashboardApi(ADMIN)
    renderApp('/dashboard')

    await kpiCard('Active AMCs')
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    await screen.findByRole('button', { name: 'Refresh' })
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

describe('references and the Expiry report', () => {
  it('shows the AMC reference and links Expiring Contracts to the report with the Reports permission', async () => {
    dashboardApi(ADMIN)
    renderApp('/dashboard')

    const panel = (await screen.findByRole('heading', { name: 'Expiring Contracts' })).closest('section') as HTMLElement
    expect(within(panel).getByRole('link', { name: 'AMC-0041' })).toHaveAttribute('href', '/amc/contracts/41')
    expect(within(panel).queryByText(/^Record /)).not.toBeInTheDocument()
    expect(within(panel).getByRole('link', { name: /Expiry report/ })).toHaveAttribute('href', '/reports?report=expiry-renewal')
    expect(screen.getByText(/Contracts, scheduled maintenance, invoicing and renewals at a glance\./)).toBeInTheDocument()
  })

  it('keeps the AMC Contracts link without the Reports permission', async () => {
    dashboardApi(withPermissions(['DASHBOARD:VIEW', 'AMC_CONTRACTS:VIEW']))
    renderApp('/dashboard')

    const panel = (await screen.findByRole('heading', { name: 'Expiring Contracts' })).closest('section') as HTMLElement
    expect(within(panel).queryByRole('link', { name: /Expiry report/ })).not.toBeInTheDocument()
    expect(within(panel).getByRole('link', { name: /AMC Contracts/ })).toHaveAttribute('href', '/amc/contracts')
  })
})

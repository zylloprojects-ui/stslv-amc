import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '../lib/types'
import { displayName, parseNames } from '../pages/amcManagement/managementPreferences'
import type { AmcManagementSummary } from '../pages/amcManagement/managementTypes'
import { invoiceAmountText } from '../pages/dashboard/kpis'
import type { OperationsDashboard, PaymentFigures } from '../pages/dashboard/operationsTypes'
import { ADMIN, fail, mockApi, ok, renderApp, signIn, type MockReply, type MockRequest } from './helpers'

// AMC Management. The API is mocked: every figure here is a fixture, and each
// test checks that the page shows exactly what the API sent.
//
// Client correction (2026-11-10): AMC Management and the Dashboard are SEPARATE pages. Only the KPI cards the two have in
// common must match (label, figure, wording, icon, colour). The suites below test AMC Management's own page, and then
// that the shared cards match the Dashboard's while each page keeps its own sections.

const KPIS: AmcManagementSummary['kpis'] = {
  contracts: {
    active: 12,
    activePastValidity: 2,
    activeAwaitingPredecessor: 1,
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
    paidAmountMissing: 0,
    unpaid: 8,
    unpaidValue: '640.500',
    unpaidAmountMissing: 0,
    paidThisMonth: 2,
    paidThisMonthValue: '160.000',
    scheduledThisMonth: { withInvoiceNo: 1, withInvoiceNoValue: '80.000', withInvoiceNoAmountMissing: 0, withoutInvoiceNo: 6, withoutInvoiceNoValue: '480.375', withoutInvoiceNoAmountMissing: 0 },
  },
}

const SUMMARY: AmcManagementSummary = {
  asOf: '2026-10-28',
  timeZone: 'Asia/Muscat',
  kpis: KPIS,
  contracts: KPIS.contracts!,
  schedule: {
    servicesThisMonth: { planned: 9, completed: 4, open: 5 },
    pendingBilling: { count: 6, amount: '2430.750', amountRequired: 2 },
    currentScheduledValue: { amount: '3645.125', visits: 9, amountMissing: 1 },
    engine: { activeContracts: 12, withoutSchedule: 0 },
  },
  invoices: {
    paid: { count: 3 },
    unpaid: { count: 8, amount: '640.500', amountMissing: 0 },
    paidTotal: { amount: '240.000', amountMissing: 0 },
    module: { issued: 14, cancelled: 1 },
  },
  expiry: {
    renewalsInstalled: true,
    bands: [
      { days: 90, fromDays: 61, count: 4, notRenewed: 3, notRenewedIds: ['51', '52', '53'] },
      { days: 60, fromDays: 46, count: 1, notRenewed: 1, notRenewedIds: ['54'] },
      { days: 45, fromDays: 31, count: 2, notRenewed: 1, notRenewedIds: ['55'] },
      { days: 30, fromDays: 16, count: 0, notRenewed: 0, notRenewedIds: [] },
      { days: 15, fromDays: 0, count: 1, notRenewed: 1, notRenewedIds: ['41'] },
    ],
    renewalWarning: { days: 45, count: 2, ids: ['41', '55'] },
    critical: { days: 15, count: 1, notRenewed: 1 },
    notRenewedExpired: { count: 5, expiredStatus: 3, activePastValidity: 2 },
    list: {
      days: 90,
      total: 2,
      pastValidity: 0,
      items: [
        { id: '41', reference: 'AMC-0041', client: { id: '1', name: 'Harbour Hotel' }, systemDescription: 'FIRE ALARM', validTo: '2026-11-05', daysLeft: 8, renewal: null, band: 15 },
        { id: '42', reference: 'AMC-0042', client: { id: '2', name: 'City Tower' }, systemDescription: 'CCTV', validTo: '2026-12-11', daysLeft: 44, renewal: { id: '77', reference: 'AMC-0077', status: 'DRAFT' }, band: 45 },
      ],
    },
  },
  recentContracts: {
    total: 16,
    items: [
      { id: '77', reference: 'AMC-0077', client: { id: '2', name: 'City Tower' }, systemDescription: 'CCTV', status: 'DRAFT', contractValue: '1200.000', createdAt: '2026-10-27T08:00:00.000Z' },
      { id: '42', reference: 'AMC-0042', client: { id: '2', name: 'City Tower' }, systemDescription: 'CCTV', status: 'ACTIVE', contractValue: '1100.500', createdAt: '2026-10-01T08:00:00.000Z' },
    ],
  },
}

/** The Dashboard's answer for the same database: the same `kpis` object, plus the Dashboard's own sections. */
const OPERATIONS: OperationsDashboard = {
  asOf: '2026-10-28',
  timeZone: 'Asia/Muscat',
  kpis: KPIS,
  portfolio: { total: 16, statuses: [{ status: 'ACTIVE', count: 12, percent: '75.0' }] },
  expiring: { days: 90, total: 0, pastValidity: 0, renewalsInstalled: true, items: [] },
  workload: { months: [{ month: '2026-10', planned: 9, completed: 4, open: 5 }, { month: '2026-11', planned: 3, completed: 0, open: 3 }] },
  schedule: {
    today: [{ id: '501', contractId: '41', client: { id: '1', name: 'Harbour Hotel' }, systemDescription: 'FIRE ALARM', scheduledDate: '2026-10-28', assignedTo: 'R. Engineer', status: 'SCHEDULED', isOverdue: false }],
    todayTotal: 1,
    upcoming: [],
    upcomingTotal: 0,
    upcomingDays: 7,
  },
  paymentTrend: { months: [{ month: '2026-09', count: 1, value: '80.000' }, { month: '2026-10', count: 2, value: '160.000' }] },
}

const CONTRACTS_ONLY: SessionUser = {
  id: '5',
  email: 'viewer@example.com',
  fullName: 'Vera Viewer',
  roles: [{ id: '5', code: 'VIEWER', name: 'Viewer' }],
  permissions: ['DASHBOARD:VIEW', 'AMC_CONTRACTS:VIEW'],
}

const EXECUTION_ONLY: SessionUser = {
  id: '6',
  email: 'engineer@example.com',
  fullName: 'Eli Engineer',
  roles: [{ id: '6', code: 'EXECUTION', name: 'Execution' }],
  permissions: ['DASHBOARD:VIEW', 'AMC_EXECUTION:VIEW', 'AMC_SCHEDULE:VIEW'],
}

function managementApi(
  user: SessionUser,
  summary?: (request: MockRequest) => MockReply | Promise<MockReply>,
  operations: () => MockReply | Promise<MockReply> = () => ok(OPERATIONS),
) {
  signIn()

  return mockApi((request) => {
    if (request.path === '/auth/me') return ok({ user })
    if (request.path === '/notifications') return ok({ items: [], unreadCount: 0 })
    if (request.path === '/amc/management/summary') return summary?.(request) ?? ok(SUMMARY)
    if (request.path === '/dashboard/operations') return operations()
    if (request.path === '/dashboard/calendar') return ok({ month: request.query.get('month'), days: [] })
    if (request.path === '/clients') return ok({ items: [], total: 0, page: 1, pageSize: 100 })
    if (request.path === '/amc/contracts/systems') return ok([])
    if (request.path === '/masters/sales-engineers/options') return ok([])
    if (request.path === '/masters/maintenance-frequencies/options') return ok([])
    return undefined
  })
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const group = (title: string) => screen.getByRole('list', { name: title })
const card = (title: string, label: string) => within(group(title)).getByRole('heading', { name: new RegExp(`^${escape(label)}`) }).closest('li') as HTMLElement
const cardOrder = (title: string) => within(group(title)).getAllByRole('heading', { level: 3 }).map((heading) => heading.firstChild?.textContent)

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('AMC Management page', () => {
  it('shows the title, subtitle and every KPI group from the API figures', async () => {
    managementApi(ADMIN)
    renderApp('/amc/management')

    expect(await screen.findByRole('heading', { level: 1, name: 'AMC Management' })).toBeInTheDocument()
    expect(screen.getByText('Contract master and automatic schedule control center')).toBeInTheDocument()

    await waitFor(() => expect(within(card('Contract KPIs', 'Active AMCs')).getByText('12')).toBeInTheDocument())
    expect(within(card('Contract KPIs', 'Active AMCs')).getByText(/2 past validity not counted/)).toBeInTheDocument()
    expect(within(card('Contract KPIs', 'Annual AMC Value (Ex VAT)')).getByText('8,010.500')).toBeInTheDocument()
    expect(within(card('Contract KPIs', 'Final Credit (Ex VAT)')).getByText('300.501')).toBeInTheDocument()
    expect(within(card('Contract KPIs', 'Final Credit (Ex VAT)')).getByText(/Entered on 2 of 12 active contracts/)).toBeInTheDocument()
    expect(within(card('Contract KPIs', 'Expiring ≤45 Days')).getByText('3')).toBeInTheDocument()
    expect(within(card('Contract KPIs', 'Expiring ≤45 Days')).getByText(/1 with a renewal/)).toBeInTheDocument()

    expect(within(card('Schedule KPIs', 'Services This Month')).getByText('9')).toBeInTheDocument()
    expect(within(card('Schedule KPIs', 'Schedule Pending Billing')).getByText('6')).toBeInTheDocument()
    expect(within(card('Schedule KPIs', 'Schedule Pending Billing')).getByText(/2,430\.750 · 2 need an amount/)).toBeInTheDocument()
    expect(within(card('Schedule KPIs', 'Current Scheduled Value')).getByText('3,645.125')).toBeInTheDocument()
    expect(within(card('Schedule KPIs', 'Current Scheduled Value')).getByText(/9 visits, 1 without an amount/)).toBeInTheDocument()
    expect(within(card('Schedule KPIs', 'Schedule Engine Status')).getByText('In sync')).toBeInTheDocument()

    // The reference status from the manual Invoice No., on the Dashboard's Overall cards.
    expect(within(card('Invoice KPIs', 'Invoices Generated')).getByText('3')).toBeInTheDocument()
    expect(within(card('Invoice KPIs', 'Invoices Generated')).getByText('OMR 240.000 · Invoice No. entered')).toBeInTheDocument()
    expect(within(card('Invoice KPIs', 'Invoices Not Generated')).getByText('OMR 640.500 · no Invoice No.')).toBeInTheDocument()
    expect(within(card('Invoice KPIs', 'Paid Invoice Total')).getByText('240.000')).toBeInTheDocument()
    expect(within(card('Invoice KPIs', 'Invoice Module Status')).getByText('Tracking')).toBeInTheDocument()
    expect(within(card('Invoice KPIs', 'Invoice Module Status')).getByText(/14 issued invoices · 1 cancelled · Zoho records/)).toBeInTheDocument()
  })

  it('reports active contracts without a schedule as needing attention', async () => {
    managementApi(ADMIN, () => ok({ ...SUMMARY, schedule: { ...SUMMARY.schedule!, engine: { activeContracts: 12, withoutSchedule: 2 } } }))
    renderApp('/amc/management')

    await waitFor(() => expect(within(card('Schedule KPIs', 'Schedule Engine Status')).getByText('Attention')).toBeInTheDocument())
    expect(within(card('Schedule KPIs', 'Schedule Engine Status')).getByText(/2 of 12 active contracts have no scheduled visits/)).toBeInTheDocument()
  })

  it('offers the top-level actions as links to the existing modules, including Reports', async () => {
    managementApi(ADMIN)
    renderApp('/amc/management')

    const banner = (await screen.findByRole('heading', { level: 1, name: 'AMC Management' })).closest('.app-banner') as HTMLElement
    expect(within(banner).getByRole('link', { name: 'Schedule Engine' })).toHaveAttribute('href', '/amc/schedule')
    expect(within(banner).getByRole('link', { name: 'Invoices' })).toHaveAttribute('href', '/invoices')
    expect(within(banner).getByRole('link', { name: 'Alerts' })).toHaveAttribute('href', '/notifications')
    expect(within(banner).getByRole('link', { name: 'Reports' })).toHaveAttribute('href', '/reports')

    await userEvent.click(within(banner).getByRole('button', { name: '+ New AMC' }))
    expect(await screen.findByRole('dialog', { name: 'Add AMC Contract' })).toBeInTheDocument()
  })

  it('lists the recent contracts with their details and links', async () => {
    managementApi(ADMIN)
    renderApp('/amc/management')

    const table = await screen.findByRole('table', { name: 'Latest AMC contracts, newest first' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    expect(within(rows[0] as HTMLElement).getAllByRole('cell')[0]).toHaveTextContent('AMC-0077')
    expect(within(rows[0] as HTMLElement).getByText('Draft')).toBeInTheDocument()
    expect(within(rows[0] as HTMLElement).getByText('1,200.000')).toBeInTheDocument()
    expect(within(rows[0] as HTMLElement).getByRole('link', { name: 'View AMC-0077' })).toHaveAttribute('href', '/amc/contracts/77')
    expect(screen.getByText(/16 in total/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View All →' })).toHaveAttribute('href', '/amc/contracts')
  })

  it('shows the expiry and renewal figures, bands and the renewal warning', async () => {
    managementApi(ADMIN)
    renderApp('/amc/management')

    const section = (await screen.findByRole('heading', { name: 'Expiry & Renewal' })).closest('section') as HTMLElement
    const critical = within(section).getByRole('heading', { name: 'Critical — expiring within 15 days' }).parentElement as HTMLElement
    expect(within(critical).getByText('1')).toBeInTheDocument()
    const expired = within(section).getByRole('heading', { name: 'Not Renewed & Expired' }).parentElement as HTMLElement
    expect(within(expired).getByText('5')).toBeInTheDocument()
    expect(within(expired).getByText('3 with status Expired · 2 still Active past validity')).toBeInTheDocument()

    expect(within(section).getByRole('note')).toHaveTextContent('Renewal warning: 2 active contracts end within 45 days without a renewal.')

    const bands = within(within(section).getByRole('list', { name: 'Expiry warning bands' })).getAllByRole('listitem')
    expect(bands.map((band) => band.textContent)).toEqual([
      '90 days61–90 days left43 not renewed',
      '60 days46–60 days left11 not renewed',
      '45 days31–45 days left21 not renewed',
      '30 days16–30 days left00 not renewed',
      '15 days0–15 days left11 not renewed',
    ])

    const list = within(section).getByRole('table', { name: 'Active contracts ending within 90 days' })
    expect(within(list).getByRole('link', { name: 'AMC-0041' })).toHaveAttribute('href', '/amc/contracts/41')
    expect(within(list).getByText('15-day band')).toBeInTheDocument()
    expect(within(list).getByRole('link', { name: 'Not renewed · open to renew' })).toHaveAttribute('href', '/amc/contracts/41')
    expect(within(list).getByRole('link', { name: /Renewal/ })).toHaveAttribute('href', '/amc/contracts/77')
    expect(within(section).getByText(/the expiry job is switched off/)).toBeInTheDocument()
  })

  it('shows empty states when there are no contracts', async () => {
    const empty: AmcManagementSummary = {
      ...SUMMARY,
      expiry: {
        ...SUMMARY.expiry,
        bands: SUMMARY.expiry.bands.map((band) => ({ ...band, count: 0, notRenewed: 0, notRenewedIds: [] })),
        renewalWarning: { days: 45, count: 0, ids: [] },
        critical: { days: 15, count: 0, notRenewed: 0 },
        notRenewedExpired: { count: 0, expiredStatus: 0, activePastValidity: 0 },
        list: { days: 90, total: 0, pastValidity: 0, items: [] },
      },
      recentContracts: { total: 0, items: [] },
    }
    managementApi(ADMIN, () => ok(empty))
    renderApp('/amc/management')

    expect(await screen.findByText('No AMC contracts have been added yet.')).toBeInTheDocument()
    expect(screen.getByText('✓ No active AMC ends in the next 90 days.')).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent('No active contract ends within 45 days without a renewal.')
  })

  it('shows loading cards, then an error with a retry when the summary fails', async () => {
    let calls = 0
    managementApi(ADMIN, async () => {
      calls += 1
      if (calls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 30))
        return fail(500, 'INTERNAL_ERROR', 'Something went wrong.')
      }
      return ok(SUMMARY)
    })
    renderApp('/amc/management')

    expect(await screen.findAllByText(/^Loading Active AMCs$/)).not.toHaveLength(0)
    expect(await screen.findByText(/The AMC Management figures could not be loaded/)).toBeInTheDocument()
    expect(within(group('Contract KPIs')).getAllByText('Could not be loaded')).toHaveLength(4)

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(within(card('Contract KPIs', 'Active AMCs')).getByText('12')).toBeInTheDocument())
  })

  it('lays the KPI cards out in a responsive grid', async () => {
    managementApi(ADMIN)
    renderApp('/amc/management')

    expect((await screen.findByRole('list', { name: 'Contract KPIs' })).className).toContain('sm:grid-cols-2')
    expect(group('Contract KPIs').className).toContain('xl:grid-cols-4')
  })
})

describe('KPI customization', () => {
  it('renames a page-specific KPI in one group only, remembers it for this user, and resets the names', async () => {
    managementApi(ADMIN)
    const view = renderApp('/amc/management')

    await waitFor(() => expect(within(card('Schedule KPIs', 'Schedule Pending Billing')).getByText('6')).toBeInTheDocument())
    const schedule = group('Schedule KPIs').closest('section') as HTMLElement
    const reset = within(schedule).getByRole('button', { name: 'Reset KPI Names of Schedule KPIs' })
    expect(reset).toBeDisabled()

    await userEvent.click(within(schedule).getByRole('button', { name: 'Customize Schedule KPIs' }))
    await userEvent.type(within(schedule).getByLabelText('Display name for Schedule Pending Billing'), 'To bill')

    // Same figure under the new name; the standard name stays available.
    expect(within(card('Schedule KPIs', 'To bill')).getByText('6')).toBeInTheDocument()
    expect(within(card('Schedule KPIs', 'To bill')).getByText('(standard name: Schedule Pending Billing)')).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('stslev.amc-management.schedule.kpi-names.1') ?? '{}')).toEqual({ pendingBilling: 'To bill' })
    // The other groups keep their names.
    expect(card('Contract KPIs', 'Active AMCs')).toBeInTheDocument()

    // Remembered after a fresh visit.
    view.unmount()
    managementApi(ADMIN)
    renderApp('/amc/management')
    await waitFor(() => expect(within(card('Schedule KPIs', 'To bill')).getByText('6')).toBeInTheDocument())

    const again = group('Schedule KPIs').closest('section') as HTMLElement
    await userEvent.click(within(again).getByRole('button', { name: 'Reset KPI Names of Schedule KPIs' }))
    expect(card('Schedule KPIs', 'Schedule Pending Billing')).toBeInTheDocument()
    expect(localStorage.getItem('stslev.amc-management.schedule.kpi-names.1')).toBeNull()
  })

  it('never renames a card shared with the Dashboard, even from a name saved earlier', async () => {
    localStorage.setItem('stslev.amc-management.contracts.kpi-names.1', JSON.stringify({ active: 'Live contracts' }))
    managementApi(ADMIN)
    renderApp('/amc/management')

    await waitFor(() => expect(within(card('Contract KPIs', 'Active AMCs')).getByText('12')).toBeInTheDocument())
    expect(screen.queryByText('Live contracts')).not.toBeInTheDocument()

    const contracts = group('Contract KPIs').closest('section') as HTMLElement
    await userEvent.click(within(contracts).getByRole('button', { name: 'Customize Contract KPIs' }))
    expect(within(contracts).queryByLabelText('Display name for Active AMCs')).not.toBeInTheDocument()
    expect(within(card('Contract KPIs', 'Active AMCs')).getByText(/Same card as on the Dashboard/)).toBeInTheDocument()
  })

  it('reorders KPIs within a group and resets the order', async () => {
    managementApi(ADMIN)
    renderApp('/amc/management')

    await waitFor(() => expect(within(card('Schedule KPIs', 'Services This Month')).getByText('9')).toBeInTheDocument())
    const schedule = group('Schedule KPIs').closest('section') as HTMLElement
    expect(within(schedule).getByRole('button', { name: 'Reset KPI Order of Schedule KPIs' })).toBeDisabled()

    await userEvent.click(within(schedule).getByRole('button', { name: 'Customize Schedule KPIs' }))
    expect(within(schedule).getByRole('button', { name: 'Move Services This Month earlier' })).toBeDisabled()
    await userEvent.click(within(schedule).getByRole('button', { name: 'Move Services This Month later' }))

    expect(cardOrder('Schedule KPIs')).toEqual(['Schedule Pending Billing', 'Services This Month', 'Current Scheduled Value', 'Schedule Engine Status'])
    expect(cardOrder('Contract KPIs')).toEqual(['Active AMCs', 'Annual AMC Value (Ex VAT)', 'Final Credit (Ex VAT)', 'Expiring ≤45 Days'])
    expect(JSON.parse(localStorage.getItem('stslev.amc-management.schedule.kpi-order.1') ?? '[]')).toEqual(['pendingBilling', 'services', 'scheduledValue', 'engine'])

    await userEvent.click(within(schedule).getByRole('button', { name: 'Reset KPI Order of Schedule KPIs' }))
    expect(cardOrder('Schedule KPIs')).toEqual(['Services This Month', 'Schedule Pending Billing', 'Current Scheduled Value', 'Schedule Engine Status'])
    expect(localStorage.getItem('stslev.amc-management.schedule.kpi-order.1')).toBeNull()
  })

  it('keeps each user’s choices separate', async () => {
    localStorage.setItem('stslev.amc-management.schedule.kpi-names.99', JSON.stringify({ engine: 'Someone else’s name' }))
    managementApi(ADMIN)
    renderApp('/amc/management')

    await waitFor(() => expect(within(card('Contract KPIs', 'Active AMCs')).getByText('12')).toBeInTheDocument())
    expect(screen.queryByText('Someone else’s name')).not.toBeInTheDocument()
  })

  it('reads saved names defensively', () => {
    expect(parseNames('{"active":"A","gone":"B","value":5}', ['active', 'value'])).toEqual({ active: 'A' })
    expect(parseNames('not json', ['active'])).toEqual({})
    expect(parseNames('["active"]', ['active'])).toEqual({})
    expect(parseNames(JSON.stringify({ active: 'x'.repeat(60) }), ['active']).active).toHaveLength(40)
    expect(displayName({ active: '   ' }, 'active', 'Active AMC')).toBe('Active AMC')
    expect(displayName({ active: ' Live ' }, 'active', 'Active AMC')).toBe('Live')
  })
})

describe('permissions', () => {
  it('shows only the contract figures and no create or module actions to a contract viewer', async () => {
    managementApi(CONTRACTS_ONLY, () => ok({ ...SUMMARY, kpis: { ...KPIS, services: null, payments: null }, schedule: null, invoices: null }))
    renderApp('/amc/management')

    await waitFor(() => expect(within(card('Contract KPIs', 'Active AMCs')).getByText('12')).toBeInTheDocument())
    expect(screen.queryByRole('list', { name: 'Schedule KPIs' })).not.toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Invoice KPIs' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '+ New AMC' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Schedule Engine' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Invoices' })).not.toBeInTheDocument()
    // KPI cards are informational only: no links inside them.
    expect(within(card('Contract KPIs', 'Active AMCs')).queryByRole('link')).not.toBeInTheDocument()
    // Not in the approved sidebar (owner decision, 2026-11-10): the page opens from its address and the expiry alerts.
    expect(screen.queryByRole('link', { name: 'AMC Management' })).not.toBeInTheDocument()
  })

  it('hides the amounts a user without schedule access cannot see', async () => {
    const executionOnly: SessionUser = { ...CONTRACTS_ONLY, permissions: ['AMC_CONTRACTS:VIEW', 'AMC_EXECUTION:VIEW'] }
    managementApi(executionOnly, () =>
      ok({ ...SUMMARY, kpis: { ...KPIS, payments: null }, schedule: { ...SUMMARY.schedule!, pendingBilling: null, currentScheduledValue: null }, invoices: null }),
    )
    renderApp('/amc/management')

    await waitFor(() => expect(within(card('Schedule KPIs', 'Services This Month')).getByText('9')).toBeInTheDocument())
    expect(cardOrder('Schedule KPIs')).toEqual(['Services This Month', 'Schedule Engine Status'])
  })

  it('denies the page without AMC contract access', async () => {
    managementApi(EXECUTION_ONLY)
    renderApp('/amc/management')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'AMC Management' })).not.toBeInTheDocument()
  })
})

describe('Reports link and informational KPI cards', () => {
  it('links Reports only with its permission, and puts no link in any KPI card', async () => {
    managementApi(ADMIN)
    renderApp('/amc/management')

    const banner = (await screen.findByRole('heading', { level: 1, name: 'AMC Management' })).closest('.app-banner') as HTMLElement
    expect(within(banner).getByRole('link', { name: 'Reports' })).toHaveAttribute('href', '/reports')
    expect(screen.queryByText('(not built yet)')).not.toBeInTheDocument()

    await waitFor(() => expect(within(card('Invoice KPIs', 'Invoices Generated')).getByText('3')).toBeInTheDocument())
    // No card holds a link (View contracts, AMC Schedule, Invoice Tracking, Accounts) or acts as one.
    for (const title of ['Contract KPIs', 'Schedule KPIs', 'Invoice KPIs']) {
      const cards = within(group(title)).getAllByRole('listitem')
      expect(cards.length).toBeGreaterThan(0)
      for (const item of cards) {
        expect(within(item).queryByRole('link')).not.toBeInTheDocument()
        expect(item.closest('a')).toBeNull()
        expect(item).not.toHaveAttribute('role', 'link')
        expect(item).not.toHaveAttribute('tabindex')
      }
    }
    expect(document.body.textContent).not.toMatch(/figures are unavailable/)
  })

  it('shows neither link without the permission', async () => {
    managementApi({ ...CONTRACTS_ONLY, permissions: ['AMC_CONTRACTS:VIEW', 'INVOICES:VIEW'] })
    renderApp('/amc/management')

    const banner = (await screen.findByRole('heading', { level: 1, name: 'AMC Management' })).closest('.app-banner') as HTMLElement
    expect(within(banner).queryByRole('link', { name: 'Reports' })).not.toBeInTheDocument()
    await waitFor(() => expect(within(card('Invoice KPIs', 'Invoices Generated')).getByText('3')).toBeInTheDocument())
    expect(within(card('Invoice KPIs', 'Invoices Generated')).queryByRole('link', { name: 'Accounts' })).not.toBeInTheDocument()
  })
})

describe('Hide / Show of Recent AMC Contracts and Expiry & Renewal', () => {
  const sectionOf = async (title: string) => (await screen.findByRole('heading', { name: title })).closest('section') as HTMLElement

  it('shows both sections by default and hides each one on its own', async () => {
    managementApi(ADMIN)
    renderApp('/amc/management')

    const recent = await sectionOf('Recent AMC Contracts')
    const expiry = await sectionOf('Expiry & Renewal')
    const hideRecent = within(recent).getByRole('button', { name: 'Hide Recent AMC Contracts' })
    const hideExpiry = within(expiry).getByRole('button', { name: 'Hide Expiry & Renewal' })
    expect(hideRecent).toHaveAttribute('aria-expanded', 'true')
    expect(hideExpiry).toHaveAttribute('aria-expanded', 'true')
    expect(within(recent).getByRole('table')).toBeVisible()
    expect(within(expiry).getByRole('note')).toBeVisible()

    await userEvent.click(hideRecent)
    const showRecent = within(recent).getByRole('button', { name: 'Show Recent AMC Contracts' })
    expect(showRecent).toHaveAttribute('aria-expanded', 'false')
    expect(document.getElementById(showRecent.getAttribute('aria-controls') ?? '')).not.toBeVisible()
    expect(within(recent).queryByRole('table')).not.toBeInTheDocument()
    // The header and its View All button stay.
    expect(within(recent).getByRole('heading', { name: 'Recent AMC Contracts' })).toBeVisible()
    expect(within(recent).getByRole('link', { name: 'View All →' })).toHaveAttribute('href', '/amc/contracts')
    // The other section is unaffected.
    expect(within(expiry).getByRole('button', { name: 'Hide Expiry & Renewal' })).toHaveAttribute('aria-expanded', 'true')
    expect(within(expiry).getByRole('list', { name: 'Expiry warning bands' })).toBeVisible()

    await userEvent.click(within(expiry).getByRole('button', { name: 'Hide Expiry & Renewal' }))
    expect(within(expiry).queryByRole('note')).not.toBeInTheDocument()
    expect(within(expiry).queryByRole('list', { name: 'Expiry warning bands' })).not.toBeInTheDocument()
    expect(within(expiry).queryByRole('table')).not.toBeInTheDocument()
    expect(within(expiry).getByRole('link', { name: 'AMC Contracts →' })).toHaveAttribute('href', '/amc/contracts')

    expect(localStorage.getItem('stslev.amc-management.section.recent-contracts.open.1')).toBe('0')
    expect(localStorage.getItem('stslev.amc-management.section.expiry-renewal.open.1')).toBe('0')

    await userEvent.click(within(recent).getByRole('button', { name: 'Show Recent AMC Contracts' }))
    expect(within(recent).getByRole('table')).toBeVisible()
    expect(within(expiry).queryByRole('note')).not.toBeInTheDocument()
    expect(localStorage.getItem('stslev.amc-management.section.recent-contracts.open.1')).toBe('1')
  })

  it('works from the keyboard', async () => {
    managementApi(ADMIN)
    renderApp('/amc/management')

    const expiry = await sectionOf('Expiry & Renewal')
    within(expiry).getByRole('button', { name: 'Hide Expiry & Renewal' }).focus()
    await userEvent.keyboard('{Enter}')
    expect(within(expiry).getByRole('button', { name: 'Show Expiry & Renewal' })).toHaveAttribute('aria-expanded', 'false')
    await userEvent.keyboard(' ')
    expect(within(expiry).getByRole('button', { name: 'Hide Expiry & Renewal' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('remembers each choice per user when the page is opened again', async () => {
    localStorage.setItem('stslev.amc-management.section.expiry-renewal.open.1', '0')
    localStorage.setItem('stslev.amc-management.section.recent-contracts.open.99', '0')
    managementApi(ADMIN)
    renderApp('/amc/management')

    const recent = await sectionOf('Recent AMC Contracts')
    const expiry = await sectionOf('Expiry & Renewal')
    // Another user's choice does not apply.
    expect(within(recent).getByRole('button', { name: 'Hide Recent AMC Contracts' })).toHaveAttribute('aria-expanded', 'true')
    expect(within(recent).getByRole('table')).toBeVisible()
    expect(within(expiry).getByRole('button', { name: 'Show Expiry & Renewal' })).toHaveAttribute('aria-expanded', 'false')
    expect(within(expiry).queryByRole('note')).not.toBeInTheDocument()
  })
})

// --- The Dashboard and AMC Management: separate pages, matching shared cards (client correction, 2026-11-10) ---------

/** The Dashboard card ids of the cards AMC Management also shows. */
const SHARED_IDS: Record<string, string> = {
  active: 'active',
  value: 'value',
  credit: 'credit',
  expiring: 'expiring',
  services: 'month-services',
  paid: 'overall-invoiced',
  unpaid: 'overall-not-invoiced',
}

/** What a card shows: its name, figure and line, its icon tile colours, and its accent colour. */
function cardFacts(item: Element) {
  const heading = item.querySelector('h3, h4')
  const name = heading?.firstChild?.textContent?.trim()

  return {
    name,
    // The text below the name: the figure (with its unit) | the detail line.
    body: [...item.querySelectorAll('p')].map((line) => line.textContent?.replace(/\s+/g, ' ').trim()).join(' | '),
    hint: item.querySelector('[title]')?.getAttribute('title'),
    tile: item.querySelector('.absolute.right-5.top-5')?.getAttribute('style'),
    accent: item.getAttribute('style')?.replace(/animation-delay:[^;]+;?\s*/, ''),
  }
}

async function readDashboardCards(user: SessionUser = ADMIN, operations: OperationsDashboard = OPERATIONS) {
  managementApi(user, undefined, () => ok(operations))
  const view = renderApp('/dashboard')
  await screen.findByText(/Figures as of/)
  const cards = Object.fromEntries([...document.querySelectorAll('[data-kpi]')].map((item) => [item.getAttribute('data-kpi'), cardFacts(item)]))
  const headings = [...document.querySelectorAll('#main-content h1, #main-content h2')].map((heading) => heading.textContent?.replace(/\s+/g, ' ').trim())
  view.unmount()

  return { cards, headings }
}

async function readManagementCards(user: SessionUser = ADMIN, summary: AmcManagementSummary = SUMMARY) {
  managementApi(user, () => ok(summary))
  const view = renderApp('/amc/management')
  await screen.findByText(/Figures as of/)
  const cards = Object.fromEntries([...document.querySelectorAll('[data-kpi-group] [data-kpi]')].map((item) => [item.getAttribute('data-kpi'), cardFacts(item)]))
  const headings = [...document.querySelectorAll('#main-content h1, #main-content h2')].map((heading) => heading.textContent?.replace(/\s+/g, ' ').trim())
  view.unmount()

  return { cards, headings }
}

describe('the Dashboard and AMC Management are separate pages with matching shared cards', () => {
  it('shows each shared card exactly as the Dashboard does: name, figure, wording, hint, icon colours and accent', async () => {
    const dashboard = await readDashboardCards()
    const management = await readManagementCards()

    for (const [managementId, dashboardId] of Object.entries(SHARED_IDS)) {
      expect(management.cards[managementId], managementId).toBeDefined()
      expect(management.cards[managementId], managementId).toEqual(dashboard.cards[dashboardId])
    }
  })

  it('keeps each page’s own sections', async () => {
    const dashboard = await readDashboardCards()
    const management = await readManagementCards()

    // Dashboard only.
    expect(dashboard.headings).toContain('AMC Operations Dashboard')
    expect(dashboard.headings.some((heading) => heading?.includes('AMC Maintenance Calendar'))).toBe(true)
    expect(dashboard.headings.some((heading) => heading?.includes('Upcoming Service Workload'))).toBe(true)
    expect(dashboard.headings.some((heading) => heading?.includes('Payment Trend'))).toBe(true)
    expect(dashboard.headings).not.toContain('Recent AMC Contracts')
    expect(dashboard.headings).not.toContain('Expiry & Renewal')
    expect(Object.keys(dashboard.cards)).toHaveLength(12)

    // AMC Management only.
    expect(management.headings).toContain('AMC Management')
    expect(management.headings).toContain('Recent AMC Contracts')
    expect(management.headings).toContain('Expiry & Renewal')
    expect(management.headings).toEqual(expect.arrayContaining(['Contract KPIs', 'Schedule KPIs', 'Invoice KPIs']))
    expect(management.headings.some((heading) => heading?.includes('AMC Maintenance Calendar'))).toBe(false)
    expect(management.headings.some((heading) => heading?.includes('Payment Trend'))).toBe(false)
    expect(Object.keys(management.cards).sort()).toEqual(['active', 'credit', 'engine', 'expiring', 'module', 'paid', 'paidTotal', 'pendingBilling', 'scheduledValue', 'services', 'unpaid', 'value'])
  })

  it('shows the same shared figures to a restricted role on both pages', async () => {
    const finance: SessionUser = { ...CONTRACTS_ONLY, id: '7', permissions: ['DASHBOARD:VIEW', 'AMC_CONTRACTS:VIEW', 'INVOICES:VIEW'] }
    const restricted = { ...KPIS, services: null }
    const dashboard = await readDashboardCards(finance, { ...OPERATIONS, kpis: restricted, workload: null, schedule: null })
    const management = await readManagementCards(finance, { ...SUMMARY, kpis: restricted, schedule: null })

    expect(Object.keys(dashboard.cards).sort()).toEqual(['active', 'credit', 'expiring', 'month-invoiced', 'month-not-invoiced', 'overall-invoiced', 'overall-not-invoiced', 'value'])
    expect(management.cards.services).toBeUndefined()
    for (const id of ['active', 'value', 'credit', 'expiring', 'paid', 'unpaid']) {
      expect(management.cards[id], id).toEqual(dashboard.cards[SHARED_IDS[id] as string])
    }
  })
})

// --- Invoice amounts: a service value that was never recorded is not OMR 0.000 ----------------------------------------

/** One service with an Invoice No. and no recorded value: the local alpha record behind the OMR 0.000 screenshot. */
const ONE_WITHOUT_AMOUNT: PaymentFigures = {
  ...KPIS.payments!,
  paid: 1,
  paidValue: '0.000',
  paidAmountMissing: 1,
  scheduledThisMonth: { ...KPIS.payments!.scheduledThisMonth, withInvoiceNo: 1, withInvoiceNoValue: '0.000', withInvoiceNoAmountMissing: 1 },
}

describe('Invoices Generated amount', () => {
  it('formats the amount line', () => {
    expect(invoiceAmountText(1, '0.000', 1)).toBe('Amount not recorded')
    expect(invoiceAmountText(3, '120.000', 1)).toBe('OMR 120.000 · 1 without amount')
    expect(invoiceAmountText(2, '1250.5', 0)).toBe('OMR 1,250.500')
    // A real stored zero, or no services at all, is 0.000.
    expect(invoiceAmountText(1, '0.000', 0)).toBe('OMR 0.000')
    expect(invoiceAmountText(0, '0.000', 0)).toBe('OMR 0.000')
    // An older API without the count shows the amount as before.
    expect(invoiceAmountText(1, '80.000', undefined)).toBe('OMR 80.000')
  })

  it('says Amount not recorded on both pages instead of OMR 0.000', async () => {
    const kpis = { ...KPIS, payments: ONE_WITHOUT_AMOUNT }
    const dashboard = await readDashboardCards(ADMIN, { ...OPERATIONS, kpis })
    const management = await readManagementCards(ADMIN, {
      ...SUMMARY,
      kpis,
      invoices: { ...SUMMARY.invoices!, paid: { count: 1 }, paidTotal: { amount: '0.000', amountMissing: 1 } },
    })

    expect(dashboard.cards['month-invoiced']?.body).toBe('1 | Amount not recorded · Invoice No. entered')
    expect(dashboard.cards['overall-invoiced']?.body).toBe('1 | Amount not recorded · Invoice No. entered')
    expect(management.cards.paid).toEqual(dashboard.cards['overall-invoiced'])
    expect(management.cards.paidTotal?.body).toBe('Not recorded | No value recorded on the 1 Paid service')
    for (const card of [dashboard.cards['month-invoiced'], dashboard.cards['overall-invoiced'], management.cards.paid, management.cards.paidTotal]) {
      expect(card?.body).not.toMatch(/0\.000/)
    }
  })

  it('shows the recorded amount and says how many services have none', async () => {
    const kpis = { ...KPIS, payments: { ...KPIS.payments!, paid: 3, paidValue: '120.000', paidAmountMissing: 1 } }
    const dashboard = await readDashboardCards(ADMIN, { ...OPERATIONS, kpis })

    expect(dashboard.cards['overall-invoiced']?.body).toBe('3 | OMR 120.000 · 1 without amount · Invoice No. entered')
  })
})

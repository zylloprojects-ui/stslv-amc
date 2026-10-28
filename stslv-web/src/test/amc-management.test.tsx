import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '../lib/types'
import { displayName, parseNames } from '../pages/amcManagement/managementPreferences'
import type { AmcManagementSummary } from '../pages/amcManagement/managementTypes'
import { ADMIN, fail, mockApi, ok, renderApp, signIn, type MockReply, type MockRequest } from './helpers'

// AMC Management. The API is mocked: every figure here is a fixture, and each
// test checks that the page shows exactly what the API sent.

const UNAVAILABLE = { available: false as const, reason: 'Payment is not recorded in STSLV AMC. Invoices are tracked as Issued or Cancelled only, with no paid date or paid amount.' }

const SUMMARY: AmcManagementSummary = {
  asOf: '2026-10-28',
  timeZone: 'Asia/Muscat',
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
  schedule: {
    servicesThisMonth: { planned: 9, completed: 4, open: 5 },
    pendingBilling: { count: 6, amount: '2430.750', amountRequired: 2 },
    currentScheduledValue: { amount: '3645.125', visits: 9, amountMissing: 1 },
    engine: { activeContracts: 12, withoutSchedule: 0 },
  },
  invoices: { paid: UNAVAILABLE, unpaid: UNAVAILABLE, paidTotal: UNAVAILABLE, module: { issued: 14, cancelled: 1, paymentTracked: false } },
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
        { id: '42', reference: 'AMC-0042', client: { id: '2', name: 'City Tower' }, systemDescription: 'CCTV', validTo: '2026-12-11', daysLeft: 44, renewal: { id: '77', status: 'DRAFT' }, band: 45 },
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

function managementApi(user: SessionUser, summary?: (request: MockRequest) => MockReply | Promise<MockReply>) {
  signIn()

  return mockApi((request) => {
    if (request.path === '/auth/me') return ok({ user })
    if (request.path === '/notifications') return ok({ items: [], unreadCount: 0 })
    if (request.path === '/amc/management/summary') return summary?.(request) ?? ok(SUMMARY)
    if (request.path === '/clients') return ok({ items: [], total: 0, page: 1, pageSize: 100 })
    if (request.path === '/amc/contracts/systems') return ok([])
    if (request.path === '/masters/sales-engineers/options') return ok([])
    if (request.path === '/masters/maintenance-frequencies/options') return ok([])
    return undefined
  })
}

const group = (title: string) => screen.getByRole('list', { name: title })
const card = (title: string, label: string) => within(group(title)).getByRole('heading', { name: new RegExp(`^${label}`) }).closest('li') as HTMLElement
const cardOrder = (title: string) => within(group(title)).getAllByRole('heading', { level: 3 }).map((heading) => heading.firstChild?.textContent)

afterEach(() => localStorage.clear())

describe('AMC Management page', () => {
  it('shows the title, subtitle and every KPI group from the API figures', async () => {
    managementApi(ADMIN)
    renderApp('/amc/management')

    expect(await screen.findByRole('heading', { level: 1, name: 'AMC Management' })).toBeInTheDocument()
    expect(screen.getByText('Contract master and automatic schedule control center')).toBeInTheDocument()

    await waitFor(() => expect(within(card('Contract KPIs', 'Active AMC')).getByText('12')).toBeInTheDocument())
    expect(within(card('Contract KPIs', 'Active AMC')).getByText(/2 past validity/)).toBeInTheDocument()
    expect(within(card('Contract KPIs', 'Total AMC Value')).getByText('8,010.500')).toBeInTheDocument()
    expect(within(card('Contract KPIs', 'Total Final Credit')).getByText('300.501')).toBeInTheDocument()
    expect(within(card('Contract KPIs', 'Total Final Credit')).getByText(/meaning not confirmed/)).toBeInTheDocument()
    expect(within(card('Contract KPIs', 'Expiring within 45 days')).getByText('3')).toBeInTheDocument()
    expect(within(card('Contract KPIs', 'Expiring within 45 days')).getByText(/1 with a renewal/)).toBeInTheDocument()

    expect(within(card('Schedule KPIs', 'Services This Month')).getByText('9')).toBeInTheDocument()
    expect(within(card('Schedule KPIs', 'Schedule Pending Billing')).getByText('6')).toBeInTheDocument()
    expect(within(card('Schedule KPIs', 'Schedule Pending Billing')).getByText(/2,430\.750 · 2 need an amount/)).toBeInTheDocument()
    expect(within(card('Schedule KPIs', 'Current Scheduled Value')).getByText('3,645.125')).toBeInTheDocument()
    expect(within(card('Schedule KPIs', 'Current Scheduled Value')).getByText(/9 visits, 1 without an amount/)).toBeInTheDocument()
    expect(within(card('Schedule KPIs', 'Schedule Engine Status')).getByText('In sync')).toBeInTheDocument()

    // Payment is not recorded: never shown as a number.
    for (const label of ['Paid Invoices', 'Unpaid Invoices', 'Paid Invoice Total']) {
      expect(within(card('Invoice KPIs', label)).getByText('Not available')).toBeInTheDocument()
      expect(within(card('Invoice KPIs', label)).getByText('Payment is not recorded in STSLV AMC.')).toBeInTheDocument()
    }
    expect(within(card('Invoice KPIs', 'Invoice Module Status')).getByText('Tracking')).toBeInTheDocument()
    expect(within(card('Invoice KPIs', 'Invoice Module Status')).getByText(/14 issued invoices · 1 cancelled · payment not recorded/)).toBeInTheDocument()
  })

  it('reports active contracts without a schedule as needing attention', async () => {
    managementApi(ADMIN, () => ok({ ...SUMMARY, schedule: { ...SUMMARY.schedule!, engine: { activeContracts: 12, withoutSchedule: 2 } } }))
    renderApp('/amc/management')

    await waitFor(() => expect(within(card('Schedule KPIs', 'Schedule Engine Status')).getByText('Attention')).toBeInTheDocument())
    expect(within(card('Schedule KPIs', 'Schedule Engine Status')).getByText(/2 of 12 active contracts have no scheduled visits/)).toBeInTheDocument()
  })

  it('offers the top-level actions as links to the existing modules, and Reports as not built', async () => {
    managementApi(ADMIN)
    renderApp('/amc/management')

    const banner = (await screen.findByRole('heading', { level: 1, name: 'AMC Management' })).closest('.app-banner') as HTMLElement
    expect(within(banner).getByRole('link', { name: 'Schedule Engine' })).toHaveAttribute('href', '/amc/schedule')
    expect(within(banner).getByRole('link', { name: 'Invoices' })).toHaveAttribute('href', '/invoices')
    expect(within(banner).getByRole('link', { name: 'Alerts' })).toHaveAttribute('href', '/notifications')
    expect(within(banner).queryByRole('link', { name: /Reports/ })).not.toBeInTheDocument()
    expect(within(banner).getByText('Reports').closest('[aria-disabled="true"]')).not.toBeNull()

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
    expect(within(section).getByText(/there is no daily expiry job/)).toBeInTheDocument()
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

    expect(await screen.findAllByText(/^Loading Active AMC$/)).not.toHaveLength(0)
    expect(await screen.findByText(/The AMC Management figures could not be loaded/)).toBeInTheDocument()
    expect(within(group('Contract KPIs')).getAllByText('Could not be loaded')).toHaveLength(4)

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(within(card('Contract KPIs', 'Active AMC')).getByText('12')).toBeInTheDocument())
  })

  it('lays the KPI cards out in a responsive grid', async () => {
    managementApi(ADMIN)
    renderApp('/amc/management')

    expect((await screen.findByRole('list', { name: 'Contract KPIs' })).className).toContain('sm:grid-cols-2')
    expect(group('Contract KPIs').className).toContain('xl:grid-cols-4')
  })
})

describe('KPI customization', () => {
  it('renames a KPI in one group only, remembers it for this user, and resets the names', async () => {
    managementApi(ADMIN)
    const view = renderApp('/amc/management')

    await waitFor(() => expect(within(card('Contract KPIs', 'Active AMC')).getByText('12')).toBeInTheDocument())
    const contracts = group('Contract KPIs').closest('section') as HTMLElement
    const reset = within(contracts).getByRole('button', { name: 'Reset KPI Names of Contract KPIs' })
    expect(reset).toBeDisabled()

    await userEvent.click(within(contracts).getByRole('button', { name: 'Customize Contract KPIs' }))
    const input = within(contracts).getByLabelText('Display name for Active AMC')
    await userEvent.type(input, 'Live contracts')

    // Same figure under the new name; the standard name stays available.
    expect(within(card('Contract KPIs', 'Live contracts')).getByText('12')).toBeInTheDocument()
    expect(within(card('Contract KPIs', 'Live contracts')).getByText('(standard name: Active AMC)')).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('stslev.amc-management.contracts.kpi-names.1') ?? '{}')).toEqual({ active: 'Live contracts' })
    // The other groups keep their names.
    expect(card('Schedule KPIs', 'Services This Month')).toBeInTheDocument()

    // Remembered after a fresh visit.
    view.unmount()
    managementApi(ADMIN)
    renderApp('/amc/management')
    await waitFor(() => expect(within(card('Contract KPIs', 'Live contracts')).getByText('12')).toBeInTheDocument())

    const again = group('Contract KPIs').closest('section') as HTMLElement
    await userEvent.click(within(again).getByRole('button', { name: 'Reset KPI Names of Contract KPIs' }))
    expect(card('Contract KPIs', 'Active AMC')).toBeInTheDocument()
    expect(localStorage.getItem('stslev.amc-management.contracts.kpi-names.1')).toBeNull()
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
    expect(cardOrder('Contract KPIs')).toEqual(['Active AMC', 'Total AMC Value', 'Total Final Credit', 'Expiring within 45 days'])
    expect(JSON.parse(localStorage.getItem('stslev.amc-management.schedule.kpi-order.1') ?? '[]')).toEqual(['pendingBilling', 'services', 'scheduledValue', 'engine'])

    await userEvent.click(within(schedule).getByRole('button', { name: 'Reset KPI Order of Schedule KPIs' }))
    expect(cardOrder('Schedule KPIs')).toEqual(['Services This Month', 'Schedule Pending Billing', 'Current Scheduled Value', 'Schedule Engine Status'])
    expect(localStorage.getItem('stslev.amc-management.schedule.kpi-order.1')).toBeNull()
  })

  it('keeps each user’s choices separate', async () => {
    localStorage.setItem('stslev.amc-management.contracts.kpi-names.99', JSON.stringify({ active: 'Someone else’s name' }))
    managementApi(ADMIN)
    renderApp('/amc/management')

    await waitFor(() => expect(within(card('Contract KPIs', 'Active AMC')).getByText('12')).toBeInTheDocument())
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
    managementApi(CONTRACTS_ONLY, () => ok({ ...SUMMARY, schedule: null, invoices: null }))
    renderApp('/amc/management')

    await waitFor(() => expect(within(card('Contract KPIs', 'Active AMC')).getByText('12')).toBeInTheDocument())
    expect(screen.queryByRole('list', { name: 'Schedule KPIs' })).not.toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Invoice KPIs' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '+ New AMC' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Schedule Engine' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Invoices' })).not.toBeInTheDocument()
    // The KPI links lead only to modules the user may open.
    expect(within(card('Contract KPIs', 'Active AMC')).getByRole('link', { name: 'View contracts' })).toHaveAttribute('href', '/amc/contracts')
    expect(screen.getByRole('link', { name: 'AMC Management' })).toHaveAttribute('href', '/amc/management')
  })

  it('hides the amounts a user without schedule access cannot see', async () => {
    const executionOnly: SessionUser = { ...CONTRACTS_ONLY, permissions: ['AMC_CONTRACTS:VIEW', 'AMC_EXECUTION:VIEW'] }
    managementApi(executionOnly, () =>
      ok({ ...SUMMARY, schedule: { ...SUMMARY.schedule!, pendingBilling: null, currentScheduledValue: null }, invoices: null }),
    )
    renderApp('/amc/management')

    await waitFor(() => expect(within(card('Schedule KPIs', 'Services This Month')).getByText('9')).toBeInTheDocument())
    expect(cardOrder('Schedule KPIs')).toEqual(['Services This Month', 'Schedule Engine Status'])
  })

  it('denies the page, and leaves it out of the navigation, without AMC contract access', async () => {
    managementApi(EXECUTION_ONLY)
    renderApp('/amc/management')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'AMC Management' })).not.toBeInTheDocument()
  })
})

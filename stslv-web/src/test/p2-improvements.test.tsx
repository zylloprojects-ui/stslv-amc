import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '../lib/types'
import { groupByContract, contractMonthStatus } from '../pages/amc/calendar/contractMonth'
import { ADMIN, ACCOUNTANT, mockApi, ok, renderApp, signIn, type MockRequest, type MockReply } from './helpers'
import { amcApi, makeContract, makeVisit } from './amc-helpers'

// P2 improvements (2026-11-09): Reports isolation on the page, the Monthly Calendar's By contract
// view, custom-role management and the contract Recycle Bin dependency check. Invented data only.

const REPORT = { title: 'Report', columns: [{ key: 'client', header: 'Client', kind: 'text' }], rows: [{ client: 'Alpha Towers' }], total: 1, page: 1, pageSize: 50, totals: {}, kpis: [], notes: [] }

function reportsApi(user: SessionUser, catalogue: unknown[]) {
  return mockApi((request) => {
    if (request.path === '/auth/me') return ok({ user })
    if (request.path === '/notifications') return ok({ items: [], unread: 0 })
    if (request.path === '/reports') return ok(catalogue)
    if (request.path === '/reports/options') return ok({ clients: [], salesEngineers: [], systems: [] })
    if (request.path.startsWith('/reports/')) return ok(REPORT)
    return undefined
  })
}

describe('Reports page: only what the role may open', () => {
  beforeEach(signIn)

  it('opens the first report the API offers and shows export only where the API allows it', async () => {
    const api = reportsApi(ADMIN, [
      { id: 'renewal', title: 'AMC Renewal', description: 'Renewals.', filters: [], statuses: [], canExport: false },
      { id: 'accounts', title: 'Accounts Summary', description: 'Paid and unpaid.', filters: [], statuses: [], canExport: true },
    ])
    renderApp('/reports')

    expect(await screen.findByText('Alpha Towers')).toBeInTheDocument()
    expect(api.find('GET', '/reports/renewal')).toHaveLength(1)
    expect(api.find('GET', '/reports/contract-summary')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /to Excel/ })).not.toBeInTheDocument()

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Report' }), 'accounts')
    expect(await screen.findByRole('button', { name: /to Excel/ })).toBeInTheDocument()
  })

  it('says so when no report is available, and asks for no filter options', async () => {
    const api = reportsApi(ADMIN, [])
    renderApp('/reports')

    expect(await screen.findByText('No reports available')).toBeInTheDocument()
    expect(api.find('GET', '/reports/options')).toHaveLength(0)
  })
})

describe('Monthly Calendar: By contract', () => {
  const VISITS = [
    makeVisit({ id: '1', scheduledDate: '2027-03-04', sequenceNo: 1, serviceCode: 'Q1', status: 'COMPLETED', manualInvoiceNo: 'INV-1' }),
    makeVisit({ id: '2', scheduledDate: '2027-03-20', sequenceNo: 2, serviceCode: 'Q2', status: 'SCHEDULED', isOverdue: true }),
    makeVisit({
      id: '3',
      scheduledDate: '2027-03-10',
      contract: { id: '200', reference: 'AMC-0200', status: 'ACTIVE', systemDescription: 'CCTV', maintenanceFrequency: 'MONTHLY' },
      client: { id: '11', name: 'Test Hotel Two' },
      status: 'CANCELLED',
    }),
  ]

  it('groups the month by contract with counts, in order of the first visit, and never counts a cancelled visit as unpaid', () => {
    const groups = groupByContract(VISITS)
    expect(groups.map((group) => group.reference)).toEqual(['AMC-0100', 'AMC-0200'])
    expect(groups[0]).toMatchObject({ paid: 1, unpaid: 1, overdue: 1 })
    expect(groups[0]?.visits.map((visit) => visit.id)).toEqual(['1', '2'])
    expect(contractMonthStatus(groups[0]!).label).toBe('Overdue')
    expect(groups[1]).toMatchObject({ paid: 0, unpaid: 0 })
    expect(contractMonthStatus(groups[1]!).label).toBe('Cancelled')
  })

  it('switches between By service and By contract, keeping the choice in the address', async () => {
    amcApi(ADMIN, {
      visits: VISITS,
      override: (request: MockRequest): MockReply | undefined => {
        if (request.path === '/amc/calendar/options') return ok({ clients: [], salesEngineers: [], frequencies: [], years: [2027] })
        if (request.path === '/amc/reports/expiring') return ok({ asOf: '2027-03-01', days: 45, items: [], total: 0, pastValidity: 0 })
        return undefined
      },
    })
    renderApp('/amc/calendar?view=month&month=2027-03')

    const byService = await screen.findByRole('button', { name: 'By service' })
    expect(byService).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('list', { name: /Contracts with visits/ })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'By contract' }))
    const list = await screen.findByRole('list', { name: 'Contracts with visits in March 2027' })
    const entries = within(list).getAllByRole('article')
    expect(entries).toHaveLength(2)
    expect(within(entries[0]!).getByText('AMC-0100')).toBeInTheDocument()
    expect(within(entries[0]!).getByText('Overdue')).toBeInTheDocument()
    expect(within(entries[0]!).getAllByRole('button', { name: /Q1|Q2/ })).toHaveLength(2)
    expect(screen.getByText(/2 contracts · 3 visits/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'By contract' })).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('Custom roles: Role list in Settings', () => {
  beforeEach(signIn)

  const ROLES = {
    roles: [
      { id: '1', code: 'ADMIN', name: 'Super Admin', description: null, isActive: true, userCount: 1, permissions: [], permissionsEditable: false, lockedReason: 'x', permissionsVersion: '0000000000000000', builtIn: true, scope: null, assignable: false },
      { id: '9', code: 'SITE_SUPERVISOR', name: 'Site Supervisor', description: 'Checks services', isActive: true, userCount: 0, permissions: [], permissionsEditable: true, lockedReason: null, permissionsVersion: '0000000000000000', builtIn: false, scope: null, assignable: true },
    ],
    modules: [],
    actions: [],
    catalog: [],
    fixedAccess: { adminOnly: [], superAdminOnly: [], everyone: [] },
  }

  it('is offered to Users & Access viewers and marks custom roles', async () => {
    mockApi((request) => {
      if (request.path === '/auth/me') return ok({ user: ADMIN })
      if (request.path === '/notifications') return ok({ items: [], unread: 0 })
      if (request.path === '/roles') return ok(ROLES)
      return undefined
    })
    renderApp('/settings?section=roles')

    const row = (await screen.findByText('SITE_SUPERVISOR')).closest('tr') as HTMLElement
    expect(within(row).getByText('Custom')).toBeInTheDocument()
    const note = screen.getByText(/A new role starts with no permissions, so it opens nothing/)
    expect(within(note).getByRole('link', { name: 'Roles & Permissions' })).toHaveAttribute('href', '/admin/roles')
  })

  it('is not in the Settings menu without Users & Access view', async () => {
    mockApi((request) => {
      if (request.path === '/auth/me') return ok({ user: { ...ACCOUNTANT, permissions: ['DASHBOARD:VIEW', 'SETTINGS:VIEW'] } })
      if (request.path === '/notifications') return ok({ items: [], unread: 0 })
      return undefined
    })
    renderApp('/settings')

    const nav = await screen.findByRole('navigation', { name: 'Settings sections' })
    expect(within(nav).getByRole('button', { name: 'Company profile' })).toBeInTheDocument()
    expect(within(nav).queryByRole('button', { name: 'Role list' })).not.toBeInTheDocument()
  })
})

describe('Contract Recycle Bin dialog: dependencies', () => {
  const contract = makeContract({ id: '100' })

  const open = async (usage: unknown) => {
    const api = amcApi(ADMIN, {
      contracts: [contract],
      override: (request: MockRequest): MockReply | undefined => (request.path === '/amc/contracts/100/usage' ? ok(usage) : undefined),
    })
    renderApp('/amc/contracts')
    await userEvent.click(await screen.findByRole('button', { name: /Move .* to the Recycle Bin|Delete/ }))
    return { api, dialog: await screen.findByRole('dialog', { name: 'Move contract to the Recycle Bin' }) }
  }
  const SERVICES = { total: 4, completed: 1, open: 3, cancelled: 0, historical: 0 }

  it('lists what is kept and allows the move when nothing blocks it', async () => {
    const { dialog } = await open({ services: SERVICES, paidServices: 1, invoices: 2, documents: 1, renewal: null, renewedFrom: null, blockedReason: null })

    expect(await within(dialog).findByText(/4 services/)).toBeInTheDocument()
    expect(within(dialog).getByText('2 invoices in Invoice Tracking')).toBeInTheDocument()
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Move to Recycle Bin' })).toBeEnabled())
  })

  it('names the renewal that blocks the move and disables it', async () => {
    const { dialog, api } = await open({
      services: SERVICES,
      paidServices: 0,
      invoices: 0,
      documents: 0,
      renewal: { id: '300', reference: 'AMC-0300' },
      renewedFrom: null,
      blockedReason: 'The contract for "Test Hotel One" (FIRE) was renewed as AMC-0300. Move the renewal to the Recycle Bin first, or cancel this contract instead.',
    })

    expect(await within(dialog).findByText(/was renewed as AMC-0300/)).toBeInTheDocument()
    const move = within(dialog).getByRole('button', { name: 'Move to Recycle Bin' })
    expect(move).toBeDisabled()
    await userEvent.click(move)
    expect(api.find('DELETE', '/amc/contracts/100')).toHaveLength(0)
  })
})

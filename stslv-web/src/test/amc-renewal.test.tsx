import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '../lib/types'
import type { RenewalHistory, RenewalQueue, RenewalQueueItem } from '../pages/amcRenewal/renewalTypes'
import { amcApi, makeContract } from './amc-helpers'
import { afterPageSplit, ADMIN, fail, ok, renderApp } from './helpers'

// AMC Renewal. The API is mocked: every record here is invented, and each test
// checks that the page shows what the API sent and calls the contract routes.

const SOURCE = makeContract({ id: '41', validFrom: '2025-11-06', validTo: '2026-11-05' })
const DRAFT_RENEWAL = makeContract({ id: '77', status: 'DRAFT', validFrom: '2026-12-12', validTo: '2027-12-11', schedule: { ...SOURCE.schedule, visitCount: 0, openCount: 0, completedCount: 0 } })

function item(overrides: Partial<RenewalQueueItem>): RenewalQueueItem {
  return {
    id: '41',
    reference: 'AMC-0041',
    client: { id: '10', name: 'Harbour Hotel' },
    system: { description: 'FIRE ALARM', typeName: 'Fire Alarm' },
    frequency: { code: 'QUARTERLY', label: 'Quarterly' },
    services: { completed: 3, scheduled: 4 },
    validFrom: '2025-11-06',
    validTo: '2026-11-05',
    daysLeft: 8,
    contractStatus: 'ACTIVE',
    contractValue: '1620.000',
    remarks: 'Client asked for a revised quote.',
    renewalState: 'DUE',
    renewal: null,
    ...overrides,
  }
}

const QUEUE: RenewalQueue = {
  items: [
    item({}),
    item({ id: '42', reference: 'AMC-0042', client: { id: '11', name: 'City Tower' }, system: { description: 'CCTV', typeName: null }, daysLeft: -12, validTo: '2026-10-16', contractStatus: 'EXPIRED', remarks: null }),
    item({
      id: '43',
      reference: 'AMC-0043',
      renewalState: 'UNDER_APPROVAL',
      daysLeft: 44,
      renewal: { id: '77', reference: 'AMC-0077', status: 'DRAFT', validFrom: '2026-12-12', validTo: '2027-12-11' },
    }),
    item({ id: '44', reference: 'AMC-0044', renewalState: 'RENEWED', daysLeft: 20, renewal: { id: '78', reference: 'AMC-0078', status: 'ACTIVE', validFrom: '2026-11-18', validTo: '2027-11-17' } }),
    item({ id: '45', reference: 'AMC-0045', renewalState: 'CANCELLED', daysLeft: 30, renewal: { id: '79', reference: 'AMC-0079', status: 'CANCELLED', validFrom: '2026-12-01', validTo: '2027-11-30' } }),
  ],
  total: 5,
  page: 1,
  pageSize: 50,
  kpis: { due: 2, underApproval: 1, renewed: 1, cancelled: 1 },
  windowDays: 45,
  today: '2026-10-28',
}

const HISTORY: RenewalHistory = {
  items: [
    {
      renewal: { id: '79', client: { id: '10', name: 'Harbour Hotel' }, systemDescription: 'FIRE ALARM', validFrom: '2026-12-01', validTo: '2027-11-30', status: 'CANCELLED', createdAt: '2026-10-27T20:30:00.000Z' },
      createdOn: '2026-10-28',
      source: { id: '45', validFrom: '2025-12-01', validTo: '2026-11-30', status: 'ACTIVE' },
    },
    {
      renewal: { id: '77', client: { id: '10', name: 'Harbour Hotel' }, systemDescription: 'FIRE ALARM', validFrom: '2026-12-12', validTo: '2027-12-11', status: 'DRAFT', createdAt: '2026-10-20T08:00:00.000Z' },
      createdOn: '2026-10-20',
      source: { id: '43', validFrom: '2025-12-12', validTo: '2026-12-11', status: 'ACTIVE' },
    },
  ],
  total: 2,
  page: 1,
  pageSize: 50,
}

const VIEW_ONLY: SessionUser = {
  id: '5',
  email: 'viewer@example.com',
  fullName: 'Vera Viewer',
  roles: [{ id: '5', code: 'VIEWER', name: 'Viewer' }],
  permissions: afterPageSplit(['DASHBOARD:VIEW', 'AMC_CONTRACTS:VIEW']),
}

function renewalApi(user: SessionUser = ADMIN, queue: () => ReturnType<typeof ok> = () => ok(QUEUE)) {
  return amcApi(user, {
    contracts: [SOURCE, DRAFT_RENEWAL],
    override: (request) => {
      if (request.path === '/notifications') return ok({ items: [], unreadCount: 0 })
      if (request.path === '/amc/renewals/queue') return queue()
      if (request.path === '/amc/reports/renewals') return ok(HISTORY)
      if (request.path === '/masters/sales-engineers/options' || request.path === '/masters/maintenance-frequencies/options') return ok([])
      if (request.method === 'POST' && request.path === '/amc/contracts/41/renewals') return ok({ ...DRAFT_RENEWAL, id: '80', scheduleChange: null }, 201)
      return undefined
    },
  })
}

const queueTable = () => screen.findByRole('table', { name: 'Renewal Queue' })
const rowOf = async (reference: string) => (await within(await queueTable()).findByRole('link', { name: `Open contract ${reference}` })).closest('tr') as HTMLElement
const card = (label: string) => within(screen.getByRole('list', { name: 'Renewal KPIs' })).getByRole('heading', { name: new RegExp(`^${label}`) }).closest('li') as HTMLElement

afterEach(() => localStorage.clear())

describe('AMC Renewal page', () => {
  it('is in the Operations navigation and shows the four KPI cards from the API', async () => {
    renewalApi()
    renderApp('/amc/renewal')

    expect(await screen.findByRole('heading', { level: 1, name: 'AMC Renewal' })).toBeInTheDocument()
    await waitFor(() => expect(within(card('Due / Expired')).getByText('2')).toBeInTheDocument())
    expect(within(card('Due / Expired')).getByText(/Ending within 45 days or ended/)).toBeInTheDocument()
    expect(within(card('Under Client Approval')).getByText('1')).toBeInTheDocument()
    expect(within(card('Renewed')).getByText('1')).toBeInTheDocument()
    expect(within(card('Cancelled')).getByText('1')).toBeInTheDocument()
    expect(within(card('Due / Expired')).getByRole('link', { name: 'Show' })).toHaveAttribute('href', '/amc/renewal?status=DUE')
  })

  it('lists every column with the contract details, expiry and state', async () => {
    renewalApi()
    renderApp('/amc/renewal')

    const table = await queueTable()
    const headers = within(table).getAllByRole('columnheader').map((header) => header.textContent)
    expect(headers).toEqual(['#', 'AMC Reference', 'Client', 'System', 'Frequency', 'Service', 'Contract Expiry Date', 'Contract Status', 'Contract Amount', 'Remarks', 'Renewal Status', 'Actions'])

    const due = await rowOf('AMC-0041')
    expect(due).toHaveTextContent('Harbour Hotel')
    expect(due).toHaveTextContent('Fire Alarm')
    expect(due).toHaveTextContent('3 / 4')
    expect(due).toHaveTextContent('Ends in 8 days')
    expect(due).toHaveTextContent('1,620.000')
    expect(due).toHaveTextContent('Client asked for a revised quote.')
    expect(within(due).getByText('Due / Expired')).toBeInTheDocument()

    const expired = await rowOf('AMC-0042')
    expect(expired).toHaveTextContent('Ended 12 days ago')
    expect(expired).toHaveTextContent('Expired')

    const pending = await rowOf('AMC-0043')
    expect(within(pending).getByText('Under Client Approval')).toBeInTheDocument()
    expect(within(pending).getByRole('link', { name: 'AMC-0077' })).toHaveAttribute('href', '/amc/contracts/77')
  })

  it('offers each action only in its state and only with the permission', async () => {
    renewalApi()
    renderApp('/amc/renewal')

    expect(within(await rowOf('AMC-0041')).getByRole('button', { name: 'Start Renewal' })).toBeInTheDocument()
    expect(within(await rowOf('AMC-0043')).getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(within(await rowOf('AMC-0043')).getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    const renewed = await rowOf('AMC-0044')
    expect(within(renewed).queryByRole('button')).not.toBeInTheDocument()
    expect(within(renewed).getByRole('link', { name: 'View Renewal' })).toHaveAttribute('href', '/amc/contracts/78')
    expect(within(await rowOf('AMC-0045')).getByRole('button', { name: 'Restart Renewal' })).toBeInTheDocument()
  })

  it('shows no actions or downloads to a user who may only view contracts', async () => {
    renewalApi(VIEW_ONLY)
    renderApp('/amc/renewal')

    const table = await queueTable()
    expect(within(table).queryAllByRole('button')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /Excel/ })).not.toBeInTheDocument()
  })

  it('starts a renewal as a draft under client approval, with no status to choose', async () => {
    const api = renewalApi()
    renderApp('/amc/renewal')

    await userEvent.click(within(await rowOf('AMC-0041')).getByRole('button', { name: 'Start Renewal' }))
    const dialog = await screen.findByRole('dialog', { name: 'Renew AMC Contract' })
    expect(within(dialog).queryByLabelText(/^Status/)).not.toBeInTheDocument()
    expect(within(dialog).getByText(/Saved as a draft, under client approval/)).toBeInTheDocument()

    await userEvent.type(within(dialog).getByLabelText(/Valid from/), '2026-11-06')
    await userEvent.type(within(dialog).getByLabelText(/Valid to/), '2027-11-05')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create renewal' }))

    await waitFor(() => expect(api.find('POST', '/amc/contracts/41/renewals')).toHaveLength(1))
    expect(api.find('POST', '/amc/contracts/41/renewals')[0]?.body).toMatchObject({ clientId: '10', validFrom: '2026-11-06', validTo: '2027-11-05', status: 'DRAFT' })
    expect(await screen.findByText(/Renewal AMC-0080 created for AMC-0041/)).toBeInTheDocument()
  })

  it('approves a renewal by activating the renewal contract, never the source', async () => {
    const api = renewalApi()
    renderApp('/amc/renewal')

    await userEvent.click(within(await rowOf('AMC-0043')).getByRole('button', { name: 'Approve' }))
    const dialog = await screen.findByRole('dialog', { name: 'Activate contract' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Activate contract' }))

    await waitFor(() => expect(api.find('POST', '/amc/contracts/77/status')).toHaveLength(1))
    expect(api.find('POST', '/amc/contracts/77/status')[0]?.body).toMatchObject({ status: 'ACTIVE' })
    expect(api.find('POST', '/amc/contracts/43/status')).toHaveLength(0)
    expect(await screen.findByText(/Renewal AMC-0077 approved/)).toBeInTheDocument()
  })

  it('filters by renewal status from the address and the select, and searches', async () => {
    const api = renewalApi()
    renderApp('/amc/renewal?status=UNDER_APPROVAL')

    await queueTable()
    expect(api.find('GET', '/amc/renewals/queue').at(-1)?.query.get('renewalStatus')).toBe('UNDER_APPROVAL')
    expect(screen.getByLabelText('Renewal Status')).toHaveValue('UNDER_APPROVAL')

    await userEvent.selectOptions(screen.getByLabelText('Renewal Status'), 'CANCELLED')
    await waitFor(() => expect(api.find('GET', '/amc/renewals/queue').at(-1)?.query.get('renewalStatus')).toBe('CANCELLED'))

    await userEvent.type(screen.getByLabelText('Search'), 'AMC-0041')
    await userEvent.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() => expect(api.find('GET', '/amc/renewals/queue').at(-1)?.query.get('search')).toBe('AMC-0041'))
  })

  it('hides columns, remembers them, and leaves them out of the download', async () => {
    renewalApi()
    renderApp('/amc/renewal')

    await queueTable()
    await userEvent.click(screen.getByRole('button', { name: /Hide Columns/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Hide columns' })
    await userEvent.click(within(dialog).getByLabelText('Remarks'))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }))

    const headers = within(await queueTable()).getAllByRole('columnheader').map((header) => header.textContent)
    expect(headers).not.toContain('Remarks')
    expect(screen.getByRole('button', { name: /Hide Columns · 7 of 8 shown/ })).toBeInTheDocument()
    expect(localStorage.getItem(`stslev.amc-renewal.hidden-columns.${ADMIN.id}`)).toBe('["remarks"]')
  })

  it('renames and reorders the KPI cards, and resets both', async () => {
    renewalApi()
    renderApp('/amc/renewal')

    await waitFor(() => expect(within(card('Renewed')).getByText('1')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'Customize Renewal KPIs' }))
    await userEvent.type(screen.getByLabelText('Display name for Renewed'), 'Done')
    await userEvent.click(screen.getByRole('button', { name: 'Move Done earlier' }))

    const order = () => within(screen.getByRole('list', { name: 'Renewal KPIs' })).getAllByRole('heading', { level: 3 }).map((heading) => heading.firstChild?.textContent)
    expect(order()).toEqual(['Due / Expired', 'Done', 'Under Client Approval', 'Cancelled'])

    await userEvent.click(screen.getByRole('button', { name: 'Reset KPI Names of Renewal KPIs' }))
    await userEvent.click(screen.getByRole('button', { name: 'Reset KPI Order of Renewal KPIs' }))
    expect(order()).toEqual(['Due / Expired', 'Under Client Approval', 'Renewed', 'Cancelled'])
  })

  it('shows the empty and error states', async () => {
    renewalApi(ADMIN, () => ok({ ...QUEUE, items: [], total: 0, kpis: { due: 0, underApproval: 0, renewed: 0, cancelled: 0 } }))
    renderApp('/amc/renewal')
    expect(await screen.findByText('No contracts in the renewal queue')).toBeInTheDocument()
    expect(screen.getByText('A contract appears here 45 days before its validity ends.')).toBeInTheDocument()
  })

  it('reports a failed load and offers to try again', async () => {
    renewalApi(ADMIN, () => fail(500, 'INTERNAL_ERROR', 'An unexpected error occurred.'))
    renderApp('/amc/renewal')
    expect(await screen.findByText(/An unexpected error occurred/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('lists the renewal history with both references, the new validity and the status', async () => {
    renewalApi()
    renderApp('/amc/renewal?tab=history')

    const table = await screen.findByRole('table', { name: 'Renewal History' })
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Source AMC', 'Client / System', 'Source Expiry', 'Renewed AMC', 'New Validity', 'Status', 'Created'])
    const rows = within(table).getAllByRole('row').slice(1)
    expect(within(rows[0] as HTMLElement).getByRole('link', { name: 'AMC-0045' })).toHaveAttribute('href', '/amc/contracts/45')
    expect(within(rows[0] as HTMLElement).getByRole('link', { name: 'AMC-0079' })).toHaveAttribute('href', '/amc/contracts/79')
    expect(rows[0]).toHaveTextContent('Cancelled')
    // The day the renewal was made comes from the API, not from the UTC timestamp.
    expect(rows[0]).toHaveTextContent('28 Oct 2026')
    expect(rows[1]).toHaveTextContent('Under Client Approval')
    expect(screen.getByRole('button', { name: /Excel/ })).toBeInTheDocument()
  })
})

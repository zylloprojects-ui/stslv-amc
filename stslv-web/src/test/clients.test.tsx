import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Client, ClientSummary, SessionUser } from '../lib/types'
import { ACCOUNTANT, ADMIN, fail, makeClient, mockApi, ok, renderApp, signIn, type MockRequest } from './helpers'

/** A small in-memory stand-in for the client API, so add/edit/deactivate are reflected in later list requests. */
function clientApi(user: SessionUser, initial: Client[], override?: (request: MockRequest) => ReturnType<typeof ok> | undefined) {
  const clients = [...initial]

  signIn()

  return mockApi((request) => {
    const overridden = override?.(request)
    if (overridden) return overridden

    if (request.path === '/auth/me') return ok({ user })

    if (request.method === 'GET' && request.path === '/clients') {
      const status = request.query.get('status')
      const search = (request.query.get('search') ?? '').toLowerCase()
      const items = clients
        .filter((client) => status === 'all' || client.isActive === (status === 'active'))
        .filter((client) => client.name.toLowerCase().includes(search))

      return ok({ items, total: items.length, page: 1, pageSize: 25 })
    }

    const id = /^\/clients\/(\d+)/.exec(request.path)?.[1]
    const index = clients.findIndex((client) => client.id === id)

    if (request.method === 'POST' && request.path === '/clients') {
      const body = request.body as Partial<Client>
      const created = makeClient({ id: '99', contactPerson: null, email: null, phone: null, ...body })
      clients.push(created)
      return ok(created, 201)
    }
    if (index >= 0 && request.method === 'GET') return ok(clients[index])
    if (index >= 0 && request.method === 'PATCH') {
      clients[index] = { ...(clients[index] as Client), ...(request.body as Partial<Client>) }
      return ok(clients[index])
    }
    if (index >= 0 && request.method === 'POST' && request.path.endsWith('/deactivate')) {
      clients[index] = { ...(clients[index] as Client), isActive: false }
      return ok(clients[index])
    }

    return undefined
  })
}

const ONE = makeClient()
const TWO = makeClient({ id: '11', name: 'Test Client Two', contactPerson: null, email: null, phone: null })
const OLD = makeClient({ id: '12', name: 'Old Test Client', isActive: false })

describe('client list', () => {
  it('lists the clients returned by the API with their status', async () => {
    const api = clientApi(ADMIN, [ONE, TWO, OLD])
    renderApp('/clients')

    const table = await screen.findByRole('table', { name: 'Clients' })
    const rows = within(table).getAllByRole('row').slice(1)

    expect(rows).toHaveLength(2)
    expect(within(rows[0] as HTMLElement).getByText('Test Client One')).toBeInTheDocument()
    expect(within(rows[0] as HTMLElement).getByText('Front Desk')).toBeInTheDocument()
    expect(within(rows[0] as HTMLElement).getByText('Active')).toBeInTheDocument()
    expect(screen.getByText('Showing 1–2 of 2')).toBeInTheDocument()
    // The default view asks for active clients only.
    expect(api.find('GET', '/clients')[0]?.query.get('status')).toBe('active')
  })

  it('shows a loading state, then an empty state when there are no clients', async () => {
    clientApi(ADMIN, [])
    renderApp('/clients')

    expect(await screen.findByText(/Loading clients/)).toBeInTheDocument()
    expect(await screen.findByText('No clients yet')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('searches through the API', async () => {
    const api = clientApi(ADMIN, [ONE, TWO])
    renderApp('/clients')
    await screen.findByRole('table', { name: 'Clients' })

    await userEvent.type(screen.getByLabelText('Search'), 'two')

    await waitFor(() => expect(screen.queryByText('Test Client One')).not.toBeInTheDocument())
    expect(screen.getByText('Test Client Two')).toBeInTheDocument()
    expect(api.find('GET', '/clients').at(-1)?.query.get('search')).toBe('two')
  })

  it('filters by status through the API', async () => {
    const api = clientApi(ADMIN, [ONE, OLD])
    renderApp('/clients')
    await screen.findByRole('table', { name: 'Clients' })

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'inactive')

    expect(await screen.findByText('Old Test Client')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('Test Client One')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Reactivate Old Test Client' })).toBeInTheDocument()
    expect(screen.getByText('Disabled', { selector: 'span' })).toBeInTheDocument()
    expect(api.find('GET', '/clients').at(-1)?.query.get('status')).toBe('inactive')
  })

  it('shows an error with a retry when the list cannot be loaded', async () => {
    let failing = true
    clientApi(ADMIN, [ONE], (request) =>
      failing && request.path === '/clients' ? fail(500, 'INTERNAL_ERROR', 'An unexpected error occurred.') : undefined,
    )
    renderApp('/clients')

    expect(await screen.findByRole('alert')).toHaveTextContent('An unexpected error occurred.')

    failing = false
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('Test Client One')).toBeInTheDocument()
  })

  it('shows the stored details of a client', async () => {
    const api = clientApi(ADMIN, [makeClient({ address: '12 Test Street', notes: 'Call before visiting' })])
    renderApp('/clients')

    await userEvent.click(await screen.findByRole('button', { name: 'View Test Client One' }))

    const dialog = await screen.findByRole('dialog', { name: 'Client details' })
    expect(await within(dialog).findByText('12 Test Street')).toBeInTheDocument()
    expect(within(dialog).getByText('Call before visiting')).toBeInTheDocument()
    expect(within(dialog).getByText('desk@example.com')).toBeInTheDocument()
    expect(api.find('GET', '/clients/10')).toHaveLength(1)
  })
})

describe('add client', () => {
  it('validates the form before calling the API', async () => {
    const api = clientApi(ADMIN, [])
    renderApp('/clients')

    await userEvent.click(await screen.findByRole('button', { name: 'Add Client' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add Client' })

    await userEvent.type(within(dialog).getByLabelText('Email'), 'not-an-email')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add client' }))

    expect(await within(dialog).findByText('Client name is required.')).toBeInTheDocument()
    expect(within(dialog).getByText('Enter a valid email address.')).toBeInTheDocument()
    expect(within(dialog).getByLabelText(/Client name/)).toHaveAttribute('aria-invalid', 'true')
    expect(api.find('POST', '/clients')).toHaveLength(0)
  })

  it('saves a new client and shows it in the list', async () => {
    const api = clientApi(ADMIN, [ONE])
    renderApp('/clients')

    await userEvent.click(await screen.findByRole('button', { name: 'Add Client' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add Client' })

    await userEvent.type(within(dialog).getByLabelText(/Client name/), '  New Test Client ')
    await userEvent.type(within(dialog).getByLabelText('Phone'), '555')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add client' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('POST', '/clients')[0]?.body).toEqual({
      name: 'New Test Client',
      contactPerson: '',
      email: '',
      phone: '555',
      address: '',
      notes: '',
    })
    expect(screen.getByRole('status')).toHaveTextContent('New Test Client was added.')
    // The list is read again from the API.
    expect(await screen.findByRole('button', { name: 'View New Test Client' })).toBeInTheDocument()
  })

  it('shows a duplicate-name error from the API on the name field', async () => {
    clientApi(ADMIN, [ONE], (request) =>
      request.method === 'POST' && request.path === '/clients'
        ? fail(409, 'CONFLICT', 'A client named "Test Client One" already exists.', [
            { field: 'name', message: 'A client with this name already exists.' },
          ])
        : undefined,
    )
    renderApp('/clients')

    await userEvent.click(await screen.findByRole('button', { name: 'Add Client' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add Client' })
    await userEvent.type(within(dialog).getByLabelText(/Client name/), 'Test Client One')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add client' }))

    expect(await within(dialog).findByText('A client with this name already exists.')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Add Client' })).toBeInTheDocument()
  })

  it('shows an API error for a field the form is not showing, and checks again for that field', async () => {
    // The form believes client type is unavailable; the API (now updated) requires it.
    let refusals = 0
    const api = clientApi(ADMIN, [], (request) => {
      if (request.path === '/clients/features') return ok({ clientDetails: false })
      if (request.method === 'POST' && request.path === '/clients') {
        refusals += 1
        return fail(400, 'VALIDATION_ERROR', 'Some fields are invalid.', [{ field: 'clientType', message: 'Select Company or Individual.' }])
      }
      return undefined
    })
    renderApp('/clients')

    await userEvent.click(await screen.findByRole('button', { name: 'Add Client' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add Client' })
    expect(within(dialog).queryByLabelText(/Client type/)).not.toBeInTheDocument()
    await userEvent.type(within(dialog).getByLabelText(/Client name/), 'Hidden Field Client')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add client' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Client type: Select Company or Individual.')
    expect(refusals).toBe(1)
    // The features check is made again, so an updated database shows the field.
    await waitFor(() => expect(api.find('GET', '/clients/features').length).toBeGreaterThan(1))
  })
})

describe('edit client', () => {
  it('opens with the current values, saves the changes and shows the updated record', async () => {
    const api = clientApi(ADMIN, [ONE])
    renderApp('/clients')

    await userEvent.click(await screen.findByRole('button', { name: 'Edit Test Client One' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit Client' })
    const name = within(dialog).getByLabelText(/Client name/)

    expect(name).toHaveValue('Test Client One')
    expect(within(dialog).getByLabelText('Contact person')).toHaveValue('Front Desk')

    await userEvent.clear(name)
    await userEvent.type(name, 'Renamed Test Client')
    await userEvent.clear(within(dialog).getByLabelText('Phone'))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('PATCH', '/clients/10')[0]?.body).toMatchObject({ name: 'Renamed Test Client', phone: '', contactPerson: 'Front Desk' })
    expect(await screen.findByRole('button', { name: 'View Renamed Test Client' })).toBeInTheDocument()
    expect(screen.queryByText('Test Client One')).not.toBeInTheDocument()
  })
})

describe('change client status inline', () => {
  it('shows the status as a badge and offers a deactivate icon action, with no select', async () => {
    const api = clientApi(ADMIN, [ONE])
    renderApp('/clients')

    const deactivate = await screen.findByRole('button', { name: 'Deactivate Test Client One' })
    expect(deactivate).toHaveAttribute('title', 'Deactivate Test Client One')
    expect(deactivate).toHaveTextContent('')
    expect(screen.queryByLabelText(/^Status of /)).not.toBeInTheDocument()
    expect(screen.getByText('Active', { selector: 'span' })).toBeInTheDocument()
    expect(api.find('POST', '/clients/10/deactivate')).toHaveLength(0)
  })

  it('disables on Apply and removes the client from the active list', async () => {
    const api = clientApi(ADMIN, [ONE, TWO])
    renderApp('/clients')

    await userEvent.click(await screen.findByRole('button', { name: 'Deactivate Test Client One' }))

    await waitFor(() => expect(api.find('POST', '/clients/10/deactivate')).toHaveLength(1))
    expect(await screen.findByRole('status')).toHaveTextContent('Test Client One is now Disabled.')
    await waitFor(() => expect(screen.queryByRole('button', { name: 'View Test Client One' })).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'View Test Client Two' })).toBeInTheDocument()
  })
})

describe('list tools', () => {
  it('hides and shows optional columns, never the client name', async () => {
    clientApi(ADMIN, [ONE])
    renderApp('/clients')

    const table = await screen.findByRole('table', { name: 'Clients' })
    expect(within(table).getByRole('columnheader', { name: 'Phone' })).toBeInTheDocument()
    expect(within(table).getByText('CL-00010')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Columns/ }))
    expect(screen.queryByRole('checkbox', { name: 'Client name' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('checkbox', { name: 'Phone' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Client code' }))

    expect(within(table).queryByRole('columnheader', { name: 'Phone' })).not.toBeInTheDocument()
    expect(within(table).queryByText('CL-00010')).not.toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: 'Client name' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('checkbox', { name: 'Phone' }))
    expect(within(table).getByRole('columnheader', { name: 'Phone' })).toBeInTheDocument()
  })

  it('exports the list with its current filters, for a role that may export', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:test', revokeObjectURL: () => undefined }))
    const api = clientApi(ADMIN, [ONE, OLD], (request) => (request.path === '/clients/export' ? ok('file') : undefined))
    renderApp('/clients')
    await screen.findByRole('table', { name: 'Clients' })

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'all')
    await userEvent.type(screen.getByLabelText('Search'), 'old')
    await waitFor(() => expect(api.find('GET', '/clients').at(-1)?.query.get('search')).toBe('old'))
    await userEvent.click(screen.getByRole('button', { name: 'Export clients to Excel' }))

    await waitFor(() => expect(api.find('GET', '/clients/export')).toHaveLength(1))
    const query = api.find('GET', '/clients/export')[0]?.query
    expect(query?.get('format')).toBe('xlsx')
    expect(query?.get('status')).toBe('all')
    expect(query?.get('search')).toBe('old')
  })
})

describe('client type', () => {
  it('is required on a database that stores it', async () => {
    const api = clientApi(ADMIN, [], (request) => (request.path === '/clients/features' ? ok({ clientDetails: true }) : undefined))
    renderApp('/clients')

    await userEvent.click(await screen.findByRole('button', { name: 'Add Client' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add Client' })
    await userEvent.type(within(dialog).getByLabelText(/Client name/), 'Typed Test Client')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add client' }))

    expect(await within(dialog).findByText('Select Company or Individual.')).toBeInTheDocument()
    expect(api.find('POST', '/clients')).toHaveLength(0)

    await userEvent.selectOptions(within(dialog).getByLabelText(/Client type/), 'COMPANY')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add client' }))

    await waitFor(() => expect(api.find('POST', '/clients')).toHaveLength(1))
    expect(api.find('POST', '/clients')[0]?.body).toMatchObject({ name: 'Typed Test Client', clientType: 'COMPANY', vatNumber: '' })
  })
})

const SUMMARY: ClientSummary = {
  asOf: '2026-10-27',
  contracts: { total: 4, active: 2, draft: 1, expired: 0, cancelled: 1, activeValue: '6480.000', nonCancelledValue: '6980.000', finalCreditTotal: '100.000', finalCreditRecorded: 1 },
  renewals: { windowDays: 90, total: 1, items: [{ id: '100', systemDescription: 'FIRE ALARM', validFrom: '2025-01-01', validTo: '2025-12-31', daysLeft: -300, contractValue: '4860.000' }] },
  visits: { upcoming: 4, overdue: 9, completed: 3, readyForInvoice: 2, nextVisitDate: '2030-02-15' },
  invoices: { issued: 1, cancelled: 1, issuedExclVat: '405.000', issuedTotal: '425.250', lastInvoiceDate: '2026-09-01' },
  paymentTracking: false,
}

/** The Client 360 page's requests; the summary leaves out what the role cannot see, as the API does. */
function client360(user: SessionUser, summary: ClientSummary) {
  return clientApi(user, [ONE], (request) => {
    if (request.path === '/clients/10/summary') return ok(summary)
    if (request.path === '/clients/10/history') return ok({ items: [], total: 0, page: 1, pageSize: 20 })
    if (request.path === '/amc/visits') return ok({ items: [], total: 0, page: 1, pageSize: 10, totals: { visitAmount: '0.000', amountMissingCount: 0 } })
    if (request.path === '/amc/contracts') return ok({ items: [], total: 0, page: 1, pageSize: 50 })
    if (request.path === '/invoices') return ok({ items: [], total: 0, page: 1, pageSize: 10 })
    return undefined
  })
}

describe('Client 360', () => {
  it('shows the figures from the API and says what is not available', async () => {
    const api = client360(ADMIN, SUMMARY)
    renderApp('/clients/10')

    expect(await screen.findByRole('heading', { name: 'Test Client One', level: 1 })).toBeInTheDocument()
    const figures = within(await screen.findByRole('region', { name: 'Client figures' }))

    expect(await figures.findByText('6,480.000')).toBeInTheDocument()
    expect(figures.getByText('All contracts except cancelled: 6,980.000')).toBeInTheDocument()
    expect(figures.getByText('Payments are not recorded in STSLV AMC.')).toBeInTheDocument()
    expect(figures.getByText('Next on 15 Feb 2030')).toBeInTheDocument()
    expect(screen.getByText('CL-00010', { selector: 'span' })).toBeInTheDocument()

    // Upcoming visits are asked for from the API's current date, open statuses only.
    await waitFor(() => expect(api.find('GET', '/amc/visits')).toHaveLength(1))
    expect(api.find('GET', '/amc/visits')[0]?.query.get('from')).toBe('2026-10-27')
    expect(api.find('GET', '/amc/visits')[0]?.query.get('status')).toBe('SCHEDULED,IN_PROGRESS,POSTPONED')
    // The renewals, the invoices and the contracts are tabs, read when they are opened.
    await userEvent.click(screen.getByRole('tab', { name: /^Renewals/ }))
    expect(await screen.findByText('Ended 300 days ago')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: /^Invoices/ }))
    await waitFor(() => expect(api.find('GET', '/invoices')).toHaveLength(1))
    expect(api.find('GET', '/invoices')[0]?.query.get('clientId')).toBe('10')
    await userEvent.click(screen.getByRole('tab', { name: /^AMC contracts/ }))
    expect(await screen.findByRole('button', { name: 'Export AMC contracts to Excel' })).toBeInTheDocument()
  })

  it('shows "Not available" for sections the role cannot see, and no exports', async () => {
    client360(ACCOUNTANT, { ...SUMMARY, contracts: null, renewals: null, visits: null, invoices: null })
    renderApp('/clients/10')

    const figures = within(await screen.findByRole('region', { name: 'Client figures' }))
    await waitFor(() => expect(figures.getAllByText('Not available')).toHaveLength(8))
    await userEvent.click(screen.getByRole('tab', { name: /^Invoices/ }))
    expect(within(screen.getByRole('tabpanel')).getByText('Your role does not include invoices.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Export / })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument()
  })
})

describe('client permissions', () => {
  it('offers a view-only role no way to add, edit, change status or export', async () => {
    clientApi(ACCOUNTANT, [ONE])
    renderApp('/clients')

    expect(await screen.findByRole('button', { name: 'View Test Client One' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add Client' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/^Status of /)).not.toBeInTheDocument()
    expect(screen.getByText('Active', { selector: 'span' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Export clients/ })).not.toBeInTheDocument()

    // The details dialog has no Edit button either.
    await userEvent.click(screen.getByRole('button', { name: 'View Test Client One' }))
    const dialog = await screen.findByRole('dialog', { name: 'Client details' })
    await within(dialog).findByText('desk@example.com')
    expect(within(dialog).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
  })

  it('shows the message from the API when an action is refused', async () => {
    // The screen believes the user may deactivate; the API is the authority and says no.
    clientApi(ADMIN, [ONE], (request) =>
      request.path === '/clients/10/deactivate' ? fail(403, 'FORBIDDEN', 'You do not have permission to perform this action.') : undefined,
    )
    renderApp('/clients')

    await userEvent.click(await screen.findByRole('button', { name: 'Deactivate Test Client One' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission to perform this action.')
    expect(screen.getByRole('button', { name: 'View Test Client One' })).toBeInTheDocument()
  })
})

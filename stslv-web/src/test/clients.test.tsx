import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { Client, SessionUser } from '../lib/types'
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
    expect(screen.getByText('Inactive', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reactivate Old Test Client' })).toBeInTheDocument()
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

describe('deactivate client', () => {
  it('asks for confirmation and does nothing when cancelled', async () => {
    const api = clientApi(ADMIN, [ONE])
    renderApp('/clients')

    await userEvent.click(await screen.findByRole('button', { name: 'Deactivate Test Client One' }))
    const dialog = await screen.findByRole('dialog', { name: 'Deactivate client' })

    expect(dialog).toHaveTextContent('Deactivate Test Client One?')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(api.find('POST', '/clients/10/deactivate')).toHaveLength(0)
    expect(screen.getByText('Test Client One')).toBeInTheDocument()
  })

  it('deactivates after confirmation and removes the client from the active list', async () => {
    const api = clientApi(ADMIN, [ONE, TWO])
    renderApp('/clients')

    await userEvent.click(await screen.findByRole('button', { name: 'Deactivate Test Client One' }))
    const dialog = await screen.findByRole('dialog', { name: 'Deactivate client' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Deactivate' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('POST', '/clients/10/deactivate')).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent('Test Client One was deactivated.')
    await waitFor(() => expect(screen.queryByRole('button', { name: 'View Test Client One' })).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'View Test Client Two' })).toBeInTheDocument()
  })
})

describe('client permissions', () => {
  it('offers a view-only role no way to add, edit or deactivate', async () => {
    clientApi(ACCOUNTANT, [ONE])
    renderApp('/clients')

    expect(await screen.findByRole('button', { name: 'View Test Client One' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add Client' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Deactivate / })).not.toBeInTheDocument()

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
    const dialog = await screen.findByRole('dialog', { name: 'Deactivate client' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Deactivate' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('You do not have permission to perform this action.')
    expect(screen.getByRole('button', { name: 'View Test Client One' })).toBeInTheDocument()
  })
})

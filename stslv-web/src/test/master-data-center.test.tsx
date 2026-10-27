import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { Client, SessionUser } from '../lib/types'
import type { SalesEngineer } from '../pages/masters/masterTypes'
import { ACCOUNTANT, ADMIN, fail, makeClient, mockApi, ok, renderApp, signIn, type MockReply, type MockRequest } from './helpers'
import { makeContract } from './amc-helpers'

// Master Data Center: Clients and Sales Engineers. Every record here is invented.

const stamp = { createdAt: '2026-10-20T08:00:00.000Z', updatedAt: '2026-10-21T08:00:00.000Z' }
const ALPHA: Client = makeClient({ id: '10', name: 'Alpha Test Co', clientType: 'COMPANY', vatNumber: 'OM1100223344' })
const BETA: Client = makeClient({ id: '11', name: 'Beta Test Person', clientType: null, vatNumber: null, contactPerson: null, email: null, phone: null })
const ENGINEER: SalesEngineer = {
  id: '5',
  name: 'Test Engineer',
  employeeNo: 'E-001',
  email: 'engineer@example.com',
  phone: '111',
  department: null,
  user: null,
  notes: null,
  contractCount: 1,
  isActive: true,
  ...stamp,
}

interface Options {
  details?: boolean
  override?: (request: MockRequest) => MockReply | undefined
}

function masterApi(user: SessionUser = ADMIN, options: Options = {}) {
  signIn()
  const clients = [ALPHA, BETA]

  return mockApi((request) => {
    const overridden = options.override?.(request)
    if (overridden) return overridden
    const { method, path, query, body } = request
    if (path === '/auth/me') return ok({ user })
    if (path === '/clients/features') return ok({ clientDetails: options.details ?? true })
    if (method === 'GET' && path === '/clients') {
      const type = query.get('clientType')
      const items = clients.filter((client) => !type || client.clientType === type)
      return ok({ items, total: items.length, page: 1, pageSize: 25 })
    }
    const client = /^\/clients\/(\d+)(\/\w+)?$/.exec(path)
    if (client) {
      const index = clients.findIndex((item) => item.id === client[1])
      const found = clients[index]
      if (!found) return fail(404, 'NOT_FOUND', 'Client not found.')
      if (method === 'GET' && !client[2]) return ok(found)
      if (method === 'GET' && client[2] === '/history') {
        return ok({
          items: [{ id: '1', action: 'client.updated', description: `Client "${found.name}" updated.`, user: { id: '1', fullName: 'Asha Admin' }, changes: { clientType: { from: null, to: 'COMPANY' } }, reason: null, createdAt: stamp.updatedAt }],
          total: 1,
          page: 1,
          pageSize: 20,
        })
      }
      if (method === 'PATCH') {
        clients[index] = { ...found, ...(body as Partial<Client>) }
        return ok(clients[index])
      }
      if (method === 'POST' && client[2] === '/deactivate') {
        clients[index] = { ...found, isActive: false }
        return ok(clients[index])
      }
    }
    if (method === 'GET' && path === '/amc/contracts') {
      const items = query.get('clientId') === '10' || query.get('salesEngineerId') === '5' ? [makeContract({ client: { id: '10', name: 'Alpha Test Co', isActive: true } })] : []
      return ok({ items, total: items.length, page: 1, pageSize: 50 })
    }
    if (method === 'GET' && path === '/masters/sales-engineers') return ok({ items: [ENGINEER], total: 1, page: 1, pageSize: 25 })
    if (method === 'GET' && path === '/masters/sales-engineers/5') return ok(ENGINEER)
    if (method === 'GET' && path === '/masters/sales-engineers/5/history') return ok({ items: [], total: 0, page: 1, pageSize: 20 })
    if (method === 'GET' && path === '/masters/sales-engineers/options') return ok([ENGINEER])
    if (method === 'GET' && path === '/amc/contracts/systems') return ok(['FIRE'])
    if (method === 'POST' && path === '/amc/contracts') return ok({ ...makeContract({ id: '199' }), scheduleChange: null }, 201)

    return undefined
  })
}

describe('Master Data Center navigation', () => {
  it('groups Clients and Sales Engineers under Master Data Center', async () => {
    masterApi()
    renderApp('/clients')

    const nav = await screen.findByRole('navigation', { name: 'Main' })
    expect(within(nav).getByRole('link', { name: 'Master Data Center' })).toHaveAttribute('href', '/master-data')
    expect(within(nav).getByRole('button', { name: 'Master Data Center pages' })).toHaveAttribute('aria-expanded', 'true')
    expect(within(nav).getByRole('link', { name: 'Clients' })).toHaveAttribute('href', '/clients')
    expect(within(nav).getByRole('link', { name: 'Sales Engineers' })).toHaveAttribute('href', '/master-data/sales-engineers')
  })
})

describe('clients', () => {
  it('shows client type and VAT number, filters by type and sends the chosen sort', async () => {
    const api = masterApi()
    renderApp('/clients')

    const table = await screen.findByRole('table', { name: 'Clients' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows[0]).toHaveTextContent('Company')
    expect(rows[0]).toHaveTextContent('OM1100223344')
    expect(rows[0]).toHaveTextContent('CL-00010')
    expect(within(table).getByRole('columnheader', { name: 'VAT number' })).toBeInTheDocument()

    await userEvent.selectOptions(screen.getByLabelText('Type'), 'COMPANY')
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Clients' })).getAllByRole('row')).toHaveLength(2))
    await userEvent.selectOptions(screen.getByLabelText('Sort'), 'created-desc')
    await waitFor(() => expect(api.find('GET', '/clients').at(-1)?.query.get('sort')).toBe('createdAt'))
    expect(api.find('GET', '/clients').at(-1)?.query.get('direction')).toBe('desc')
    expect(api.find('GET', '/clients').at(-1)?.query.get('clientType')).toBe('COMPANY')
  })

  it('offers no type or VAT number on a database without the update, and still works', async () => {
    const api = masterApi(ADMIN, { details: false })
    renderApp('/clients')

    const table = await screen.findByRole('table', { name: 'Clients' })
    expect(within(table).queryByRole('columnheader', { name: 'VAT number' })).not.toBeInTheDocument()
    expect(within(table).queryByRole('columnheader', { name: 'Type' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Type')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Add Client' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add Client' })
    expect(within(dialog).queryByLabelText('VAT number')).not.toBeInTheDocument()
    await userEvent.type(within(dialog).getByLabelText(/Client name/), 'Gamma Test')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add client' }))
    await waitFor(() => expect(api.find('POST', '/clients')).toHaveLength(1))
    expect(api.find('POST', '/clients')[0]?.body).not.toHaveProperty('vatNumber')
  })

  it('opens the client page with details, contracts and history', async () => {
    masterApi()
    renderApp('/clients')

    await userEvent.click(await screen.findByRole('link', { name: 'Alpha Test Co' }))
    expect(await screen.findByRole('heading', { name: 'Alpha Test Co', level: 1 })).toBeInTheDocument()

    const details = within(screen.getByRole('region', { name: 'Client details' }))
    expect(details.getByText('Company')).toBeInTheDocument()
    expect(details.getByText('OM1100223344')).toBeInTheDocument()

    const contracts = within(screen.getByRole('region', { name: 'AMC contracts' }))
    expect(await contracts.findByRole('link', { name: 'Alpha Test Co — FIRE' })).toHaveAttribute('href', '/amc/contracts/100')

    const history = within(screen.getByRole('region', { name: 'History' }))
    expect(await history.findByText('Client updated')).toBeInTheDocument()
    expect(history.getByText(/Client type:/).parentElement).toHaveTextContent('Client type: — → Company')
  })

  it('edits the type and VAT number from the client page', async () => {
    const api = masterApi()
    renderApp('/clients/11')

    await screen.findByRole('heading', { name: 'Beta Test Person', level: 1 })
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit Client' })
    await userEvent.selectOptions(await within(dialog).findByLabelText(/Client type/), 'INDIVIDUAL')
    await userEvent.type(within(dialog).getByLabelText('VAT number'), 'VAT-77')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(api.find('PATCH', '/clients/11')).toHaveLength(1))
    expect(api.find('PATCH', '/clients/11')[0]?.body).toMatchObject({ clientType: 'INDIVIDUAL', vatNumber: 'VAT-77' })
    expect(await screen.findByRole('status')).toHaveTextContent('Beta Test Person was updated.')
  })

  it('disables a client after confirmation, never deletes it', async () => {
    const api = masterApi()
    renderApp('/clients/10')

    await screen.findByRole('heading', { name: 'Alpha Test Co', level: 1 })
    expect(screen.queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Disable' }))
    const confirm = await screen.findByRole('dialog', { name: 'Disable client' })
    await userEvent.click(within(confirm).getByRole('button', { name: 'Disable' }))

    await waitFor(() => expect(api.find('POST', '/clients/10/deactivate')).toHaveLength(1))
    expect(await screen.findByText(/This client is disabled/)).toBeInTheDocument()
  })

  it('shows a not-found page for an unknown client', async () => {
    masterApi()
    renderApp('/clients/999')

    expect(await screen.findByText('Client not found')).toBeInTheDocument()
  })

  it('offers a view-only role no edit or disable', async () => {
    masterApi({ ...ACCOUNTANT, permissions: [...ACCOUNTANT.permissions] })
    renderApp('/clients/10')

    await screen.findByRole('heading', { name: 'Alpha Test Co', level: 1 })
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'AMC contracts' })).getByText('Your role does not include access to AMC contracts.')).toBeInTheDocument()
  })
})

describe('sales engineers', () => {
  it('lists engineers and opens an engineer page with linked contracts', async () => {
    masterApi()
    renderApp('/master-data/sales-engineers')

    const table = await screen.findByRole('table', { name: 'Sales engineers' })
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('E-001')
    await userEvent.click(within(table).getByRole('link', { name: 'View Test Engineer' }))

    expect(await screen.findByRole('heading', { name: 'Test Engineer', level: 1 })).toBeInTheDocument()
    const contracts = within(screen.getByRole('region', { name: 'AMC contracts' }))
    expect(await contracts.findByRole('link', { name: 'Alpha Test Co — FIRE' })).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'History' })).getByText('No history recorded for this engineer')).toBeInTheDocument()
  })

  it('explains that the database update is needed, without offering to add', async () => {
    masterApi(ADMIN, { override: (request) => (request.path.startsWith('/masters/sales-engineers') ? fail(503, 'FEATURE_UNAVAILABLE', 'Not applied.') : undefined) })
    renderApp('/master-data/sales-engineers')

    expect(await screen.findByText(/migration 0070/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add sales engineer' })).not.toBeInTheDocument()
  })

  it('is selected on a new AMC contract, filling an empty typed engineer', async () => {
    const api = masterApi()
    renderApp('/amc/contracts')

    await userEvent.click(await screen.findByRole('button', { name: 'Add Contract' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add AMC Contract' })
    const picker = await within(dialog).findByLabelText('Sales engineer (master list)')
    await userEvent.selectOptions(picker, '5')
    expect(within(dialog).getByLabelText('Responsible engineer')).toHaveValue('Test Engineer')

    await userEvent.selectOptions(within(dialog).getByLabelText(/^Client/), '10')
    await userEvent.type(within(dialog).getByLabelText(/^System/), 'FIRE')
    await userEvent.type(within(dialog).getByLabelText(/Valid from/), '2027-01-01')
    await userEvent.type(within(dialog).getByLabelText(/Valid to/), '2027-12-31')
    await userEvent.selectOptions(within(dialog).getByLabelText(/Maintenance frequency/), 'QUARTERLY')
    await userEvent.type(within(dialog).getByLabelText(/Contract value/), '1620')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add contract' }))

    await waitFor(() => expect(api.find('POST', '/amc/contracts')).toHaveLength(1))
    expect(api.find('POST', '/amc/contracts')[0]?.body).toMatchObject({ salesEngineerId: '5', responsibleEngineer: 'Test Engineer' })
  })

  it('is not offered on the contract form when the master list is unavailable', async () => {
    masterApi(ADMIN, { override: (request) => (request.path === '/masters/sales-engineers/options' ? fail(503, 'FEATURE_UNAVAILABLE', 'Not applied.') : undefined) })
    renderApp('/amc/contracts')

    await userEvent.click(await screen.findByRole('button', { name: 'Add Contract' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add AMC Contract' })
    await within(dialog).findByLabelText(/^Client/)
    expect(within(dialog).queryByLabelText('Sales engineer (master list)')).not.toBeInTheDocument()
  })

  it('is refused to a role without Settings access', async () => {
    const api = masterApi(ACCOUNTANT)
    renderApp('/master-data/sales-engineers')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(api.find('GET', '/masters/sales-engineers')).toHaveLength(0)
  })
})

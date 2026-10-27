import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { SessionUser } from '../lib/types'
import type { Department, SalesEngineer, SystemType } from '../pages/masters/masterTypes'
import { ADMIN, fail, mockApi, ok, renderApp, signIn, type MockReply, type MockRequest } from './helpers'
import { amcApi, EXECUTION, makeContract } from './amc-helpers'

// Master Data page and the contract page's master links. Every record here is invented.

const SETTINGS_VIEWER: SessionUser = { ...ADMIN, id: '9', roles: [{ id: '9', code: 'CUSTOM', name: 'Custom' }], permissions: ['DASHBOARD:VIEW', 'SETTINGS:VIEW'] }

const stamp = { createdAt: '2026-10-20T08:00:00.000Z', updatedAt: '2026-10-20T08:00:00.000Z' }
const DEPARTMENT: Department = { id: '1', code: 'AMC', name: 'AMC Team', description: null, engineerCount: 1, isActive: true, ...stamp }
const ENGINEER: SalesEngineer = {
  id: '5',
  name: 'Test Engineer',
  employeeNo: 'E-001',
  email: 'engineer@example.com',
  phone: '111',
  department: { id: '1', code: 'AMC', name: 'AMC Team' },
  user: null,
  notes: null,
  contractCount: 2,
  isActive: true,
  ...stamp,
}
const TYPE: SystemType = { id: '7', code: 'FA', name: 'Fire alarm', description: null, sortOrder: 1, contractCount: 0, isActive: true, ...stamp }

function mastersApi(user: SessionUser, override?: (request: MockRequest) => MockReply | undefined) {
  signIn()
  const engineers = [ENGINEER]

  return mockApi((request) => {
    const overridden = override?.(request)
    if (overridden) return overridden
    const { method, path, body } = request
    if (path === '/auth/me') return ok({ user })
    if (path === '/users') return ok([])
    if (method === 'GET' && path === '/masters/sales-engineers') return ok({ items: engineers, total: engineers.length, page: 1, pageSize: 25 })
    if (method === 'GET' && path === '/masters/system-types') return ok({ items: [TYPE], total: 1, page: 1, pageSize: 25 })
    if (method === 'GET' && path === '/masters/departments') return ok({ items: [DEPARTMENT], total: 1, page: 1, pageSize: 25 })
    if (method === 'GET' && path === '/masters/departments/options') return ok([DEPARTMENT])
    if (method === 'POST' && path === '/masters/sales-engineers') {
      const created = { ...ENGINEER, id: '6', ...(body as object), department: null, contractCount: 0 } as SalesEngineer
      engineers.push(created)

      return ok(created, 201)
    }
    if (method === 'POST' && path === '/masters/sales-engineers/5/status') {
      const saved = { ...ENGINEER, isActive: (body as { isActive: boolean }).isActive }
      engineers[0] = saved

      return ok(saved)
    }

    return undefined
  })
}

describe('Master Data page', () => {
  it('lists sales engineers with department, contact and contract count', async () => {
    mastersApi(ADMIN)
    renderApp('/master-data/sales-engineers')

    const table = await screen.findByRole('table', { name: 'Sales engineers' })
    const row = within(table).getAllByRole('row')[1] as HTMLElement
    expect(row).toHaveTextContent('Test Engineer')
    expect(row).toHaveTextContent('E-001')
    expect(row).toHaveTextContent('AMC — AMC Team')
    expect(row).toHaveTextContent('Not linked')
    expect(row).toHaveTextContent('Active')
  })

  it('gives system types and departments a page each in the Master Data Center', async () => {
    mastersApi(ADMIN)
    renderApp('/master-data/system-types')

    expect(await screen.findByRole('heading', { name: 'System Types', level: 1 })).toBeInTheDocument()
    expect(within(await screen.findByRole('table', { name: 'System types' })).getByText('Fire alarm')).toBeInTheDocument()

    const nav = screen.getByRole('navigation', { name: 'Main' })
    await userEvent.click(within(nav).getByRole('link', { name: 'Departments' }))
    expect(await screen.findByRole('heading', { name: 'Departments', level: 1 })).toBeInTheDocument()
    expect(within(await screen.findByRole('table', { name: 'Departments' })).getByText('AMC Team')).toBeInTheDocument()
  })

  // Adding, editing and disabling sales engineers: see sales-engineers.test.tsx.

  it('offers a view-only Settings role no add, edit or deactivate', async () => {
    mastersApi(SETTINGS_VIEWER)
    renderApp('/master-data/sales-engineers')

    await screen.findByRole('table', { name: 'Sales engineers' })
    expect(screen.queryByRole('button', { name: /^Add / })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Deactivate / })).not.toBeInTheDocument()
  })

  it('explains that the database update is needed when the API says so', async () => {
    mastersApi(ADMIN, (request) =>
      request.path.startsWith('/masters/') ? fail(503, 'FEATURE_UNAVAILABLE', 'This feature needs a database update that has not been applied yet.') : undefined,
    )
    renderApp('/master-data/sales-engineers')

    expect(await screen.findByText(/migration 0070/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add sales engineer' })).not.toBeInTheDocument()
  })

  it('is refused to a role without Settings access', async () => {
    const api = mastersApi(EXECUTION)
    renderApp('/master-data/sales-engineers')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(api.find('GET', '/masters/sales-engineers')).toHaveLength(0)
  })
})

describe('contract master links', () => {
  it('shows the linked records and links new ones from the contract page', async () => {
    let links: unknown = { salesEngineer: null, systemType: null }
    const api = amcApi(ADMIN, {
      contracts: [makeContract()],
      override: (request) => {
        if (request.path === '/amc/contracts/100/masters' && request.method === 'GET') return ok(links)
        if (request.path === '/amc/contracts/100/masters' && request.method === 'PUT') {
          links = { salesEngineer: { id: '5', name: 'Test Engineer', employeeNo: 'E-001', isActive: true }, systemType: null }
          return ok(links)
        }
        if (request.path === '/masters/sales-engineers/options') return ok([ENGINEER])
        if (request.path === '/masters/system-types/options') return ok([TYPE])
        return undefined
      },
    })
    renderApp('/amc/contracts/100')

    await userEvent.click(await screen.findByRole('tab', { name: 'Details' }))
    const overview = within(await screen.findByRole('tabpanel'))
    expect(await overview.findAllByText('Not linked')).toHaveLength(2)

    await userEvent.click(overview.getByRole('button', { name: 'Link master records' }))
    const dialog = await screen.findByRole('dialog', { name: 'Link master records' })
    await within(dialog).findByRole('option', { name: 'Test Engineer (E-001)' })
    await userEvent.selectOptions(within(dialog).getByLabelText('Sales engineer'), '5')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save links' }))

    await waitFor(() => expect(api.find('PUT', '/amc/contracts/100/masters')[0]?.body).toEqual({ salesEngineerId: '5', systemTypeId: null }))
    expect(await overview.findByText(/Test Engineer \(E-001\)/)).toBeInTheDocument()
  })

  it('hides the master links on a database without the update', async () => {
    amcApi(ADMIN, {
      contracts: [makeContract()],
      override: (request) => (request.path === '/amc/contracts/100/masters' ? fail(503, 'FEATURE_UNAVAILABLE', 'Not applied.') : undefined),
    })
    renderApp('/amc/contracts/100')

    await userEvent.click(await screen.findByRole('tab', { name: 'Details' }))
    const overview = within(await screen.findByRole('tabpanel'))
    await waitFor(() => expect(overview.queryByText('Loading master records')).not.toBeInTheDocument())
    expect(overview.queryByText('Master records')).not.toBeInTheDocument()
    // The engineer named on the contract is in the profile bar.
    expect(screen.getByText('Test Engineer')).toBeInTheDocument()
  })
})

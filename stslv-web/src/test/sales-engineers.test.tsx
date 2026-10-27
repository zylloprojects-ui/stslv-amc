import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '../lib/types'
import type { Department, EngineerRecord, EngineerSummary, EngineerUserOption } from '../pages/masters/masterTypes'
import { ADMIN, fail, mockApi, ok, renderApp, signIn, type MockReply, type MockRequest } from './helpers'
import { makeContract } from './amc-helpers'

// Sales Engineers list, form and Engineer 360. Every record here is invented.

const SETTINGS_VIEWER: SessionUser = { ...ADMIN, id: '9', roles: [{ id: '9', code: 'CUSTOM', name: 'Custom' }], permissions: ['DASHBOARD:VIEW', 'SETTINGS:VIEW'] }

const stamp = { createdAt: '2026-10-20T08:00:00.000Z', updatedAt: '2026-10-20T08:00:00.000Z' }
const DEPARTMENT: Department = { id: '1', code: 'AMC', name: 'AMC Team', description: null, engineerCount: 1, isActive: true, ...stamp }

function makeEngineer(overrides: Partial<EngineerRecord> = {}): EngineerRecord {
  return {
    id: '5',
    code: 'SE-0005',
    name: 'Test Engineer',
    employeeNo: 'E-001',
    email: 'engineer@example.com',
    phone: '+968 1111',
    department: { id: '1', code: 'AMC', name: 'AMC Team' },
    user: null,
    notes: null,
    contractCount: 3,
    activeContractCount: 2,
    isActive: true,
    ...stamp,
    ...overrides,
  }
}

const ACCOUNTS: EngineerUserOption[] = [{ id: '21', fullName: 'Field Account', email: 'field@example.com' }]

const SUMMARY: EngineerSummary = {
  asOf: '2026-10-27',
  contracts: { total: 3, active: 2, draft: 1, expired: 0, cancelled: 0, activeValue: '4620.000' },
  visits: { upcoming: 7, overdue: 2, nextVisitDate: '2026-11-03' },
  upcoming: {
    total: 7,
    items: [{ id: '70', scheduledDate: '2026-11-03', sequenceNo: 2, status: 'SCHEDULED', assignedTo: null, contract: { id: '100', systemDescription: 'Fire alarm', clientName: 'Harbour Towers' } }],
  },
}

function engineersApi(user: SessionUser, engineers: EngineerRecord[], override?: (request: MockRequest) => MockReply | undefined) {
  signIn()

  return mockApi((request) => {
    const overridden = override?.(request)
    if (overridden) return overridden
    const { method, path, body } = request
    if (path === '/auth/me') return ok({ user })
    if (method === 'GET' && path === '/masters/sales-engineers') return ok({ items: engineers, total: engineers.length, page: Number(request.query.get('page') ?? 1), pageSize: 25 })
    if (method === 'GET' && path === '/masters/departments') return ok({ items: [DEPARTMENT], total: 1, page: 1, pageSize: 100 })
    if (method === 'GET' && path === '/masters/departments/options') return ok([DEPARTMENT])
    if (method === 'GET' && path === '/masters/sales-engineers/user-options') return ok(ACCOUNTS)
    if (method === 'POST' && path === '/masters/sales-engineers') {
      const input = body as { name: string; isActive: boolean }
      return ok(makeEngineer({ id: '6', code: 'SE-0006', name: input.name, isActive: input.isActive, contractCount: 0, activeContractCount: 0 }), 201)
    }
    const status = /^\/masters\/sales-engineers\/(\d+)\/status$/.exec(path)
    if (method === 'POST' && status) {
      const engineer = engineers.find((item) => item.id === status[1]) as EngineerRecord
      return ok({ ...engineer, isActive: (body as { isActive: boolean }).isActive })
    }
    const one = /^\/masters\/sales-engineers\/(\d+)$/.exec(path)
    if (method === 'GET' && one) return ok(engineers.find((item) => item.id === one[1]))
    if (method === 'PATCH' && one) return ok({ ...engineers.find((item) => item.id === one[1]), ...(body as object) })
    if (method === 'GET' && /\/summary$/.test(path)) return ok(SUMMARY)
    if (method === 'GET' && /\/history$/.test(path)) return ok({ items: [], total: 0, page: 1, pageSize: 10 })
    if (method === 'GET' && path === '/amc/contracts') return ok({ items: [makeContract()], total: 1, page: 1, pageSize: 50 })

    return undefined
  })
}

const table = () => screen.findByRole('table', { name: 'Sales engineers' })

describe('Sales Engineers list', () => {
  it('shows a clear empty state when there are no engineers', async () => {
    engineersApi(ADMIN, [])
    renderApp('/master-data/sales-engineers')

    expect(await screen.findByText('No sales engineers yet')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Add sales engineer' })).toHaveLength(2)
  })

  it('lists code, name, employee no., department, contact, linked account and status', async () => {
    engineersApi(ADMIN, [makeEngineer(), makeEngineer({ id: '8', code: 'SE-0008', name: 'Linked Engineer', user: { id: '21', fullName: 'Field Account', email: 'field@example.com' }, department: null })])
    renderApp('/master-data/sales-engineers')

    const rows = within(await table()).getAllByRole('row')
    expect(rows[1]).toHaveTextContent('SE-0005')
    expect(rows[1]).toHaveTextContent('Test Engineer')
    expect(rows[1]).toHaveTextContent('E-001')
    expect(rows[1]).toHaveTextContent('AMC — AMC Team')
    expect(rows[1]).toHaveTextContent('engineer@example.com')
    expect(rows[1]).toHaveTextContent('Not linked')
    expect(rows[2]).toHaveTextContent('Field Account')
    expect(within(rows[1] as HTMLElement).getByRole('combobox', { name: 'Status of Test Engineer' })).toHaveValue('active')
    expect(within(rows[1] as HTMLElement).getByRole('link', { name: 'View Test Engineer' })).toHaveAttribute('href', '/master-data/sales-engineers/5')
  })

  it('sends search, status, department and paging to the API', async () => {
    const many = Array.from({ length: 25 }, (_, index) => makeEngineer({ id: String(index + 1), code: `SE-${String(index + 1).padStart(4, '0')}`, name: `Engineer ${index + 1}` }))
    const api = engineersApi(ADMIN, many, (request) =>
      request.path === '/masters/sales-engineers' ? ok({ items: many, total: 30, page: Number(request.query.get('page') ?? 1), pageSize: 25 }) : undefined,
    )
    renderApp('/master-data/sales-engineers')
    await table()

    await userEvent.type(screen.getByLabelText('Search'), 'SE-0003')
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'inactive')
    await userEvent.selectOptions(screen.getByLabelText('Department'), 'none')
    await waitFor(() => {
      const last = api.find('GET', '/masters/sales-engineers').at(-1)?.query
      expect(last?.get('search')).toBe('SE-0003')
      expect(last?.get('status')).toBe('inactive')
      expect(last?.get('departmentId')).toBe('none')
    })

    await userEvent.click(await screen.findByRole('button', { name: 'Next' }))
    await waitFor(() => expect(api.find('GET', '/masters/sales-engineers').at(-1)?.query.get('page')).toBe('2'))
  })

  it('hides and shows optional columns', async () => {
    engineersApi(ADMIN, [makeEngineer()])
    renderApp('/master-data/sales-engineers')
    await table()

    expect(screen.getByRole('columnheader', { name: 'Employee no.' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Columns/ }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Employee no.' }))
    expect(screen.queryByRole('columnheader', { name: 'Employee no.' })).not.toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Engineer name' })).toBeInTheDocument()
  })

  it('exports the filtered list as Excel or PDF for a role that may export', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:test', revokeObjectURL: () => undefined }))
    const api = engineersApi(ADMIN, [makeEngineer()], (request) => (request.path === '/masters/sales-engineers/export' ? ok('file') : undefined))
    renderApp('/master-data/sales-engineers')
    await table()

    await userEvent.selectOptions(screen.getByLabelText('Department'), '1')
    await userEvent.click(screen.getByRole('button', { name: 'Export sales engineers to PDF' }))

    await waitFor(() => expect(api.find('GET', '/masters/sales-engineers/export')).toHaveLength(1))
    const query = api.find('GET', '/masters/sales-engineers/export')[0]?.query
    expect(query?.get('format')).toBe('pdf')
    expect(query?.get('departmentId')).toBe('1')
    expect(query?.get('status')).toBe('active')
  })

  it('explains that the database update is needed when the API says so', async () => {
    engineersApi(ADMIN, [], (request) => (request.path.startsWith('/masters/') ? fail(503, 'FEATURE_UNAVAILABLE', 'This feature needs a database update that has not been applied yet.') : undefined))
    renderApp('/master-data/sales-engineers')

    expect(await screen.findByText(/migration 0070/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add sales engineer' })).not.toBeInTheDocument()
  })

  it('offers a view-only Settings role no add, edit, status change or export', async () => {
    engineersApi(SETTINGS_VIEWER, [makeEngineer()])
    renderApp('/master-data/sales-engineers')
    await table()

    expect(screen.queryByRole('button', { name: /^Add / })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: /^Status of / })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Export / })).not.toBeInTheDocument()
    expect(within(await table()).getByText('Active')).toBeInTheDocument()
  })
})

describe('status Apply and Cancel', () => {
  it('does nothing until Apply, and Cancel puts the status back', async () => {
    const api = engineersApi(ADMIN, [makeEngineer({ activeContractCount: 0 })])
    renderApp('/master-data/sales-engineers')
    await table()

    const select = screen.getByRole('combobox', { name: 'Status of Test Engineer' })
    await userEvent.selectOptions(select, 'inactive')
    expect(api.find('POST', '/masters/sales-engineers/5/status')).toHaveLength(0)

    await userEvent.click(screen.getByRole('button', { name: 'Keep Test Engineer Active' }))
    expect(select).toHaveValue('active')
    expect(screen.queryByRole('button', { name: /^Apply / })).not.toBeInTheDocument()

    await userEvent.selectOptions(select, 'inactive')
    await userEvent.click(screen.getByRole('button', { name: 'Apply Disabled to Test Engineer' }))
    await waitFor(() => expect(api.find('POST', '/masters/sales-engineers/5/status')[0]?.body).toEqual({ isActive: false }))
    expect(await screen.findByRole('status')).toHaveTextContent('Test Engineer is now Disabled.')
  })

  it('warns about active AMC assignments before disabling, and changes nothing on Cancel', async () => {
    const api = engineersApi(ADMIN, [makeEngineer({ activeContractCount: 2 })])
    renderApp('/master-data/sales-engineers')
    await table()

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status of Test Engineer' }), 'inactive')
    await userEvent.click(screen.getByRole('button', { name: 'Apply Disabled to Test Engineer' }))

    const dialog = await screen.findByRole('dialog', { name: 'Disable sales engineer' })
    expect(dialog).toHaveTextContent('Test Engineer is assigned to 2 active AMC contracts.')
    expect(dialog).toHaveTextContent('nothing is reassigned')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(api.find('POST', '/masters/sales-engineers/5/status')).toHaveLength(0)

    await userEvent.click(screen.getByRole('button', { name: 'Apply Disabled to Test Engineer' }))
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Disable sales engineer' })).getByRole('button', { name: 'Disable' }))
    await waitFor(() => expect(api.find('POST', '/masters/sales-engineers/5/status')).toHaveLength(1))
  })
})

describe('create and edit form', () => {
  it('requires a name, checks the email and sends the chosen account and status', async () => {
    const api = engineersApi(ADMIN, [])
    renderApp('/master-data/sales-engineers')

    await userEvent.click((await screen.findAllByRole('button', { name: 'Add sales engineer' }))[0] as HTMLElement)
    const dialog = await screen.findByRole('dialog', { name: 'Add sales engineer' })

    await userEvent.type(within(dialog).getByLabelText('Email'), 'not-an-email')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add sales engineer' }))
    expect(await within(dialog).findByText('Engineer name is required.')).toBeInTheDocument()
    expect(within(dialog).getByText('Enter a valid email address.')).toBeInTheDocument()
    expect(api.find('POST', '/masters/sales-engineers')).toHaveLength(0)

    await userEvent.type(within(dialog).getByLabelText(/Engineer name/), 'New Engineer')
    await userEvent.clear(within(dialog).getByLabelText('Email'))
    await userEvent.type(within(dialog).getByLabelText('Email'), 'new@example.com')
    await userEvent.selectOptions(within(dialog).getByLabelText('Department'), '1')
    await userEvent.selectOptions(await within(dialog).findByLabelText('User account'), '21')
    await userEvent.selectOptions(within(dialog).getByLabelText('Status'), 'inactive')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add sales engineer' }))

    await waitFor(() => expect(api.find('POST', '/masters/sales-engineers')).toHaveLength(1))
    expect(api.find('POST', '/masters/sales-engineers')[0]?.body).toMatchObject({ name: 'New Engineer', email: 'new@example.com', departmentId: '1', userId: '21', isActive: false })
    expect(await screen.findByRole('status')).toHaveTextContent('New Engineer was added as SE-0006.')
  })

  it('offers no way to create a login account, and lists accounts from the eligible list only', async () => {
    const api = engineersApi(ADMIN, [])
    renderApp('/master-data/sales-engineers')

    await userEvent.click((await screen.findAllByRole('button', { name: 'Add sales engineer' }))[0] as HTMLElement)
    const dialog = await screen.findByRole('dialog', { name: 'Add sales engineer' })
    const account = within(dialog).getByLabelText('User account')

    await waitFor(() => expect(within(account).getAllByRole('option').map((option) => option.textContent)).toEqual(['Not linked', 'Field Account (field@example.com)']))
    expect(within(dialog).queryByLabelText(/Password/)).not.toBeInTheDocument()
    expect(api.find('GET', '/users')).toHaveLength(0)
  })

  it('shows a refused duplicate account link on the field', async () => {
    engineersApi(ADMIN, [], (request) =>
      request.method === 'POST' && request.path === '/masters/sales-engineers'
        ? fail(409, 'CONFLICT', 'That user is already linked to another sales engineer.', [{ field: 'userId', message: 'That user is already linked to another sales engineer.' }])
        : undefined,
    )
    renderApp('/master-data/sales-engineers')

    await userEvent.click((await screen.findAllByRole('button', { name: 'Add sales engineer' }))[0] as HTMLElement)
    const dialog = await screen.findByRole('dialog', { name: 'Add sales engineer' })
    await userEvent.type(within(dialog).getByLabelText(/Engineer name/), 'Duplicate Link')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add sales engineer' }))

    expect(await within(dialog).findByText('That user is already linked to another sales engineer.')).toBeInTheDocument()
  })

  it('sends only the changed fields on edit and keeps a since-disabled account link', async () => {
    const linked = makeEngineer({ user: { id: '30', fullName: 'Old Account', email: 'old@example.com' } })
    const api = engineersApi(ADMIN, [linked])
    renderApp('/master-data/sales-engineers')
    await table()

    await userEvent.click(screen.getByRole('button', { name: 'Edit Test Engineer' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit Test Engineer' })
    expect(dialog).toHaveTextContent('Engineer code SE-0005')
    await waitFor(() => expect(within(dialog).getByLabelText('User account')).toHaveValue('30'))

    await userEvent.clear(within(dialog).getByLabelText('Phone'))
    await userEvent.type(within(dialog).getByLabelText('Phone'), '+968 9999')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(api.find('PATCH', '/masters/sales-engineers/5')).toHaveLength(1))
    expect(api.find('PATCH', '/masters/sales-engineers/5')[0]?.body).toEqual({ phone: '+968 9999' })
    expect(api.find('GET', '/masters/sales-engineers/user-options')[0]?.query.get('engineerId')).toBe('5')
  })

  it('warns in the form before disabling an engineer with active contracts', async () => {
    engineersApi(ADMIN, [makeEngineer()])
    renderApp('/master-data/sales-engineers')
    await table()

    await userEvent.click(screen.getByRole('button', { name: 'Edit Test Engineer' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit Test Engineer' })
    expect(within(dialog).queryByRole('note')).not.toBeInTheDocument()
    await userEvent.selectOptions(within(dialog).getByLabelText('Status'), 'inactive')
    expect(within(dialog).getByRole('note')).toHaveTextContent('assigned to 2 active AMC contracts')
  })
})

describe('Engineer 360', () => {
  it('shows the details, figures, assigned contracts and upcoming work', async () => {
    engineersApi(ADMIN, [makeEngineer()])
    renderApp('/master-data/sales-engineers/5')

    expect(await screen.findByRole('heading', { name: 'Test Engineer', level: 1 })).toBeInTheDocument()
    expect(screen.getByText('SE-0005', { selector: 'span' })).toBeInTheDocument()

    const strip = await screen.findByLabelText('Engineer figures')
    expect(strip).toHaveTextContent('Assigned AMC contracts3')
    expect(strip).toHaveTextContent('1 draft · 0 expired · 0 cancelled')
    expect(strip).toHaveTextContent('Active AMC contracts2')
    expect(strip).toHaveTextContent('4,620.000')
    expect(strip).toHaveTextContent('Upcoming visits7')
    expect(strip).toHaveTextContent('Overdue visits2')

    const schedule = await screen.findByRole('table', { name: 'Upcoming work schedule' })
    expect(schedule).toHaveTextContent('Harbour Towers')
    expect(within(schedule).getByRole('link', { name: 'Fire alarm' })).toHaveAttribute('href', '/amc/contracts/100')
    expect(await screen.findByRole('heading', { name: 'AMC contracts' })).toBeInTheDocument()
    expect(screen.getByText('Showing the next 1 of 7 upcoming visits. The full list is in the AMC Schedule.')).toBeInTheDocument()
  })

  it('says a figure is not available when the role cannot see its module, never zero', async () => {
    engineersApi(SETTINGS_VIEWER, [makeEngineer()], (request) => (request.path.endsWith('/summary') ? ok({ asOf: '2026-10-27', contracts: null, visits: null, upcoming: null }) : undefined))
    renderApp('/master-data/sales-engineers/5')

    const strip = await screen.findByLabelText('Engineer figures')
    expect(within(strip).getAllByText('Not available')).toHaveLength(5)
    expect(screen.getByText('Your role does not include access to AMC contracts.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument()
  })

  it('disables from the page after showing the assignment warning', async () => {
    const api = engineersApi(ADMIN, [makeEngineer()])
    renderApp('/master-data/sales-engineers/5')

    await userEvent.click(await screen.findByRole('button', { name: 'Disable' }))
    const dialog = await screen.findByRole('dialog', { name: 'Disable sales engineer' })
    expect(dialog).toHaveTextContent('assigned to 2 active AMC contracts')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Disable' }))

    await waitFor(() => expect(api.find('POST', '/masters/sales-engineers/5/status')[0]?.body).toEqual({ isActive: false }))
  })
})

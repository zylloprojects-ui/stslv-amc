import { QueryClient } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppProviders } from '../App'
import type { SessionUser } from '../lib/types'
import type { DepartmentRecord } from '../pages/masters/departmentDialogs'
import { DepartmentsPage } from '../pages/masters/DepartmentsPage'
import { afterPageSplit, ADMIN, fail, mockApi, ok, signIn, type MockReply, type MockRequest } from './helpers'

// The Departments page. It is rendered on its own here: its route is added in
// App.tsx as a separate, approved step. Every record is invented.

const SETTINGS_VIEWER: SessionUser = { ...ADMIN, id: '9', roles: [{ id: '9', code: 'CUSTOM', name: 'Custom' }], permissions: afterPageSplit(['DASHBOARD:VIEW', 'SETTINGS:VIEW']) }

const stamp = { createdAt: '2026-10-20T08:00:00.000Z', updatedAt: '2026-10-20T08:00:00.000Z' }
const AMC: DepartmentRecord = { id: '1', code: 'AMC', name: 'AMC', description: 'Annual Maintenance Contract operations', engineerCount: 3, activeEngineerCount: 2, isActive: true, ...stamp }
const FIN: DepartmentRecord = { id: '2', code: 'FIN', name: 'Finance', description: 'Finance and invoicing team', engineerCount: 0, activeEngineerCount: 0, isActive: true, ...stamp }
const SALES: DepartmentRecord = { id: '3', code: 'SALES', name: 'Sales', description: null, engineerCount: 0, activeEngineerCount: 0, isActive: false, ...stamp }

function departmentsApi(user: SessionUser, items: DepartmentRecord[], override?: (request: MockRequest) => MockReply | undefined) {
  signIn()

  return mockApi((request) => {
    const overridden = override?.(request)
    if (overridden) return overridden
    if (request.path === '/auth/me') return ok({ user })
    if (request.method === 'GET' && request.path === '/masters/departments') return ok({ items, total: items.length, page: 1, pageSize: 25 })

    return undefined
  })
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(
    <MemoryRouter>
      <AppProviders client={client}>
        <DepartmentsPage />
      </AppProviders>
    </MemoryRouter>,
  )
}

const table = () => screen.findByRole('table', { name: 'Departments' })

afterEach(() => {
  try {
    localStorage.clear()
  } catch {
    // Storage may be unavailable.
  }
})

describe('list', () => {
  it('shows a clear empty state with an add action', async () => {
    departmentsApi(ADMIN, [])
    renderPage()

    expect(await screen.findByText('No departments yet')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Add Department' }).length).toBeGreaterThan(0)
  })

  it('shows name with description, code, status, linked engineers and only an Edit action', async () => {
    departmentsApi(ADMIN, [AMC, FIN, SALES])
    renderPage()

    const rows = within(await table()).getAllByRole('row')
    expect(within(rows[0] as HTMLElement).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['#', 'Department', 'Code', 'Status', 'Linked engineers', 'Actions'])
    const amc = rows[1] as HTMLElement
    expect(within(amc).getByText('Annual Maintenance Contract operations')).toBeInTheDocument()
    expect(within(amc).getByText('Active', { selector: 'span' })).toBeInTheDocument()
    expect(within(amc).getByRole('button', { name: 'Deactivate AMC' })).toBeInTheDocument()
    expect(within(amc).getByRole('button', { name: 'View the 3 sales engineers in AMC' })).toHaveTextContent('3')
    expect(within(rows[3] as HTMLElement).getByText('Disabled', { selector: 'span' })).toBeInTheDocument()
    expect(within(rows[3] as HTMLElement).getByRole('button', { name: 'Reactivate Sales' })).toBeInTheDocument()

    // Departments are never deleted.
    expect(screen.queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument()
    expect(within(amc).getByRole('button', { name: 'Edit AMC' })).toBeInTheDocument()
  })

  it('sends search, status and sort to the API, and the same filters to the export', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:test', revokeObjectURL: () => undefined }))
    const api = departmentsApi(ADMIN, [FIN], (request) => (request.path === '/masters/departments/export' ? ok('file') : undefined))
    renderPage()
    await table()

    // The default order is the API's own (name, then code): no sort is sent.
    expect(api.find('GET', '/masters/departments')[0]?.query.get('sort')).toBeNull()

    await userEvent.type(screen.getByLabelText('Search'), 'invoic')
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'inactive')
    await userEvent.selectOptions(screen.getByLabelText('Sort'), 'engineers-desc')
    await waitFor(() => {
      const query = api.find('GET', '/masters/departments').at(-1)?.query
      expect([query?.get('search'), query?.get('status'), query?.get('sort'), query?.get('direction')]).toEqual(['invoic', 'inactive', 'engineers', 'desc'])
    })

    await userEvent.click(screen.getByRole('button', { name: 'Export departments to Excel' }))
    await waitFor(() => expect(api.find('GET', '/masters/departments/export')).toHaveLength(1))
    const query = api.find('GET', '/masters/departments/export')[0]?.query
    expect([query?.get('format'), query?.get('search'), query?.get('status'), query?.get('sort')]).toEqual(['xlsx', 'invoic', 'inactive', 'engineers'])
  })

  it('hides and shows optional columns, but never the name', async () => {
    departmentsApi(ADMIN, [AMC])
    renderPage()
    const list = await table()

    await userEvent.click(screen.getByRole('button', { name: /Columns/ }))
    expect(screen.queryByRole('checkbox', { name: 'Department' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('checkbox', { name: 'Linked engineers' }))

    expect(within(list).queryByRole('columnheader', { name: 'Linked engineers' })).not.toBeInTheDocument()
    expect(within(list).getByRole('columnheader', { name: 'Department' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('checkbox', { name: 'Linked engineers' }))
    expect(within(list).getByRole('columnheader', { name: 'Linked engineers' })).toBeInTheDocument()
  })

  it('pages the list', async () => {
    const api = departmentsApi(ADMIN, [], (request) =>
      request.method === 'GET' && request.path === '/masters/departments'
        ? ok({ items: request.query.get('page') === '2' ? [SALES] : [AMC], total: 26, page: Number(request.query.get('page')), pageSize: 25 })
        : undefined,
    )
    renderPage()
    await table()

    await userEvent.click(screen.getByRole('button', { name: /Next/ }))
    expect(await screen.findByText('Sales')).toBeInTheDocument()
    expect(api.find('GET', '/masters/departments').at(-1)?.query.get('page')).toBe('2')
  })

  it('explains when the database update is missing', async () => {
    departmentsApi(ADMIN, [], (request) =>
      request.path === '/masters/departments' ? fail(503, 'FEATURE_UNAVAILABLE', 'This feature needs a database update that has not been applied yet.') : undefined,
    )
    renderPage()

    expect(await screen.findByText(/Departments needs migration 0070/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add Department' })).not.toBeInTheDocument()
  })
})

describe('form', () => {
  it('validates required fields and the code format before saving', async () => {
    const api = departmentsApi(ADMIN, [])
    renderPage()
    await userEvent.click((await screen.findAllByRole('button', { name: 'Add Department' }))[0] as HTMLElement)

    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add department' }))
    expect(within(dialog).getByText('Department code is required.')).toBeInTheDocument()
    expect(within(dialog).getByText('Department name is required.')).toBeInTheDocument()

    await userEvent.type(within(dialog).getByLabelText(/Department code/), 'BAD<code>')
    await userEvent.type(within(dialog).getByLabelText(/Department name/), 'Bad')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add department' }))
    expect(within(dialog).getByText(/may use letters, digits/)).toBeInTheDocument()
    expect(api.find('POST', '/masters/departments')).toHaveLength(0)
  })

  it('creates a department and shows a duplicate code against the field', async () => {
    const api = departmentsApi(ADMIN, [], (request) =>
      request.method === 'POST' && request.path === '/masters/departments'
        ? (request.body as { code: string }).code === 'FIN'
          ? fail(409, 'CONFLICT', 'A department with code "FIN" already exists.', [{ field: 'code', message: 'A department with code "FIN" already exists.' }])
          : ok({ ...AMC, engineerCount: 0 }, 201)
        : undefined,
    )
    renderPage()
    await userEvent.click((await screen.findAllByRole('button', { name: 'Add Department' }))[0] as HTMLElement)
    const dialog = await screen.findByRole('dialog')

    await userEvent.type(within(dialog).getByLabelText(/Department code/), 'FIN')
    await userEvent.type(within(dialog).getByLabelText(/Department name/), 'Finance')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add department' }))
    expect(await within(dialog).findByText('A department with code "FIN" already exists.')).toBeInTheDocument()

    await userEvent.clear(within(dialog).getByLabelText(/Department code/))
    await userEvent.type(within(dialog).getByLabelText(/Department code/), 'AMC')
    await userEvent.type(within(dialog).getByLabelText('Description'), 'Annual Maintenance Contract operations')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add department' }))

    expect(await screen.findByText('The department "AMC" was added.')).toBeInTheDocument()
    expect(api.find('POST', '/masters/departments').at(-1)?.body).toEqual({ code: 'AMC', name: 'Finance', description: 'Annual Maintenance Contract operations' })
  })

  it('warns that linked engineers will show a changed code', async () => {
    const api = departmentsApi(ADMIN, [AMC], (request) => (request.method === 'PATCH' ? ok({ ...AMC, code: 'AMC-OPS' }) : undefined))
    renderPage()
    await userEvent.click(within(await table()).getByRole('button', { name: 'Edit AMC' }))
    const dialog = await screen.findByRole('dialog')

    expect(within(dialog).queryByText(/linked to this department/)).not.toBeInTheDocument()
    await userEvent.type(within(dialog).getByLabelText(/Department code/), '-OPS')
    expect(within(dialog).getByText(/3 sales engineers are linked to this department/)).toBeInTheDocument()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(api.find('PATCH', '/masters/departments/1')).toHaveLength(1))
  })
})

describe('status', () => {
  it('confirms a disable with the linked engineer count, and Cancel keeps the department active', async () => {
    const api = departmentsApi(ADMIN, [AMC])
    renderPage()
    const row = within(await table()).getAllByRole('row')[1] as HTMLElement

    await userEvent.click(within(row).getByRole('button', { name: 'Deactivate AMC' }))

    const dialog = await screen.findByRole('dialog', { name: 'Disable AMC — AMC?' })
    expect(within(dialog).getByText('3 sales engineers')).toBeInTheDocument()
    expect(within(dialog).getByText(/\(2 active\)/)).toBeInTheDocument()
    expect(within(dialog).getByText(/None is moved or reassigned/)).toBeInTheDocument()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(within(row).getByText('Active', { selector: 'span' })).toBeInTheDocument()
    expect(api.find('POST', '/masters/departments/1/status')).toHaveLength(0)
  })

  it('disables after confirmation and says engineers keep it', async () => {
    const api = departmentsApi(ADMIN, [AMC], (request) => (request.path === '/masters/departments/1/status' ? ok({ ...AMC, isActive: false }) : undefined))
    renderPage()
    const row = within(await table()).getAllByRole('row')[1] as HTMLElement

    await userEvent.click(within(row).getByRole('button', { name: 'Deactivate AMC' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disable department' }))

    expect(await screen.findByText(/AMC is now Disabled. Engineers already in it keep it/)).toBeInTheDocument()
    expect(api.find('POST', '/masters/departments/1/status')[0]?.body).toEqual({ isActive: false })
  })

  it('shows a failed status change inside the confirmation', async () => {
    departmentsApi(ADMIN, [AMC], (request) => (request.path === '/masters/departments/1/status' ? fail(403, 'FORBIDDEN', 'You do not have permission to do that.') : undefined))
    renderPage()
    const row = within(await table()).getAllByRole('row')[1] as HTMLElement

    await userEvent.click(within(row).getByRole('button', { name: 'Deactivate AMC' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Disable department' }))

    expect(await within(dialog).findByText('You do not have permission to do that.')).toBeInTheDocument()
  })

  it('reactivates only after confirmation', async () => {
    const api = departmentsApi(ADMIN, [SALES], (request) => (request.path === '/masters/departments/3/status' ? ok({ ...SALES, isActive: true }) : undefined))
    renderPage()
    const row = within(await table()).getAllByRole('row')[1] as HTMLElement

    await userEvent.click(within(row).getByRole('button', { name: 'Reactivate Sales' }))
    let dialog = await screen.findByRole('dialog', { name: 'Reactivate department' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(api.find('POST', '/masters/departments/3/status')).toHaveLength(0)

    await userEvent.click(within(row).getByRole('button', { name: 'Reactivate Sales' }))
    dialog = await screen.findByRole('dialog', { name: 'Reactivate department' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reactivate' }))

    expect(await screen.findByText(/Sales is now Active/)).toBeInTheDocument()
    expect(api.find('POST', '/masters/departments/3/status')[0]?.body).toEqual({ isActive: true })
  })
})

describe('linked engineers', () => {
  it('lists the linked engineers read only, from the Sales Engineers list filtered by department', async () => {
    const api = departmentsApi(ADMIN, [AMC], (request) =>
      request.path === '/masters/sales-engineers'
        ? ok({
            items: [{ id: '42', code: 'SE-0042', name: 'Alpha Field', employeeNo: 'EMP-1', isActive: true }, { id: '43', code: 'SE-0043', name: 'Bravo Field', employeeNo: null, isActive: false }],
            total: 2,
            page: 1,
            pageSize: 10,
          })
        : undefined,
    )
    renderPage()
    await userEvent.click(within(await table()).getByRole('button', { name: 'View the 3 sales engineers in AMC' }))

    const dialog = await screen.findByRole('dialog', { name: 'Sales engineers in AMC — AMC' })
    const rows = within(await within(dialog).findByRole('table')).getAllByRole('row')
    expect(within(rows[1] as HTMLElement).getByRole('link', { name: 'Alpha Field' })).toHaveAttribute('href', '/master-data/sales-engineers/42')
    expect(within(rows[1] as HTMLElement).getByText('SE-0042')).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('EMP-1')).toBeInTheDocument()
    expect(within(rows[2] as HTMLElement).getByText('Disabled')).toBeInTheDocument()

    const query = api.find('GET', '/masters/sales-engineers')[0]?.query
    expect([query?.get('departmentId'), query?.get('status')]).toEqual(['1', 'all'])
    expect(within(dialog).queryByRole('button', { name: /Edit|Delete/ })).not.toBeInTheDocument()
  })
})

describe('permissions', () => {
  it('shows a read-only list to a user who may only view settings', async () => {
    departmentsApi(SETTINGS_VIEWER, [AMC])
    renderPage()
    const row = within(await table()).getAllByRole('row')[1] as HTMLElement

    expect(within(row).getByText('Active')).toBeInTheDocument()
    expect(within(row).queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit AMC' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add Department' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Export departments/ })).not.toBeInTheDocument()
  })
})

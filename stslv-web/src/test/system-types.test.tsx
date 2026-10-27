import { QueryClient } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppProviders } from '../App'
import type { SessionUser } from '../lib/types'
import type { SystemType } from '../pages/masters/masterTypes'
import { SystemTypesPage } from '../pages/masters/SystemTypesPage'
import { ADMIN, fail, mockApi, ok, signIn, type MockReply, type MockRequest } from './helpers'

// The System Types page. It is rendered on its own here: its route is added in
// App.tsx as a separate, approved step. Every record is invented.

const SETTINGS_VIEWER: SessionUser = { ...ADMIN, id: '9', roles: [{ id: '9', code: 'CUSTOM', name: 'Custom' }], permissions: ['DASHBOARD:VIEW', 'SETTINGS:VIEW'] }

const stamp = { createdAt: '2026-10-20T08:00:00.000Z', updatedAt: '2026-10-20T08:00:00.000Z' }
const FA: SystemType = { id: '4', code: 'FA', name: 'Fire Alarm', description: 'Addressable panels', sortOrder: 40, contractCount: 2, isActive: true, ...stamp }
const CCTV: SystemType = { id: '2', code: 'CCTV', name: 'CCTV', description: null, sortOrder: 20, contractCount: 0, isActive: true, ...stamp }

function typesApi(user: SessionUser, items: SystemType[], override?: (request: MockRequest) => MockReply | undefined) {
  signIn()

  return mockApi((request) => {
    const overridden = override?.(request)
    if (overridden) return overridden
    if (request.path === '/auth/me') return ok({ user })
    if (request.method === 'GET' && request.path === '/masters/system-types') return ok({ items, total: items.length, page: 1, pageSize: 25 })

    return undefined
  })
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(
    <MemoryRouter>
      <AppProviders client={client}>
        <SystemTypesPage />
      </AppProviders>
    </MemoryRouter>,
  )
}

const table = () => screen.findByRole('table', { name: 'System types' })

afterEach(() => {
  try {
    localStorage.clear()
  } catch {
    // Storage may be unavailable.
  }
})

describe('list', () => {
  it('shows a clear empty state with an add action', async () => {
    typesApi(ADMIN, [])
    renderPage()

    expect(await screen.findByText('No system types yet')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Add System Type' }).length).toBeGreaterThan(0)
  })

  it('shows name with description, code, sort order, status and linked contracts', async () => {
    typesApi(ADMIN, [CCTV, FA])
    renderPage()

    const rows = within(await table()).getAllByRole('row')
    expect(within(rows[0] as HTMLElement).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      '#',
      'System type',
      'Code',
      'Sort order',
      'Status',
      'Linked AMC',
      'Actions',
    ])
    const fa = rows[2] as HTMLElement
    expect(within(fa).getByText('Fire Alarm')).toBeInTheDocument()
    expect(within(fa).getByText('Addressable panels')).toBeInTheDocument()
    expect(within(fa).getByText('FA')).toBeInTheDocument()
    expect(within(fa).getByText('40')).toBeInTheDocument()
    expect(within(fa).getByRole('combobox', { name: 'Status of Fire Alarm' })).toHaveValue('active')
  })

  it('sends search, status and sort to the API, and the same filters to the export', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:test', revokeObjectURL: () => undefined }))
    const api = typesApi(ADMIN, [FA], (request) => (request.path === '/masters/system-types/export' ? ok('file') : undefined))
    renderPage()
    await table()

    // The default order is the API's own (sort order, then code): no sort is sent.
    expect(api.find('GET', '/masters/system-types')[0]?.query.get('sort')).toBeNull()

    await userEvent.type(screen.getByLabelText('Search'), 'alarm')
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'inactive')
    await userEvent.selectOptions(screen.getByLabelText('Sort'), 'name-desc')
    await waitFor(() => {
      const query = api.find('GET', '/masters/system-types').at(-1)?.query
      expect([query?.get('search'), query?.get('status'), query?.get('sort'), query?.get('direction')]).toEqual(['alarm', 'inactive', 'name', 'desc'])
    })

    await userEvent.click(screen.getByRole('button', { name: 'Export system types to PDF' }))
    await waitFor(() => expect(api.find('GET', '/masters/system-types/export')).toHaveLength(1))
    const query = api.find('GET', '/masters/system-types/export')[0]?.query
    expect([query?.get('format'), query?.get('search'), query?.get('status'), query?.get('sort')]).toEqual(['pdf', 'alarm', 'inactive', 'name'])
  })

  it('hides and shows optional columns, but never the name', async () => {
    typesApi(ADMIN, [FA])
    renderPage()
    const list = await table()

    await userEvent.click(screen.getByRole('button', { name: /Columns/ }))
    expect(screen.queryByRole('checkbox', { name: 'System type' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('checkbox', { name: 'Sort order' }))

    expect(within(list).queryByRole('columnheader', { name: 'Sort order' })).not.toBeInTheDocument()
    expect(within(list).getByRole('columnheader', { name: 'System type' })).toBeInTheDocument()
  })

  it('explains that the database update is needed when migration 0070 is absent', async () => {
    typesApi(ADMIN, [], (request) =>
      request.path === '/masters/system-types' ? fail(503, 'FEATURE_UNAVAILABLE', 'This feature needs a database update that has not been applied yet.') : undefined,
    )
    renderPage()

    expect(await screen.findByText(/System Types needs migration 0070/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add System Type' })).not.toBeInTheDocument()
  })
})

describe('form', () => {
  it('requires code and name, and shows the server message for a duplicate code', async () => {
    const api = typesApi(ADMIN, [FA], (request) =>
      request.method === 'POST' && request.path === '/masters/system-types'
        ? fail(409, 'CONFLICT', 'A system type with code "fa" already exists.', [{ field: 'code', message: 'A system type with code "fa" already exists.' }])
        : undefined,
    )
    renderPage()
    await table()

    await userEvent.click(screen.getByRole('button', { name: 'Add System Type' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add system type' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add system type' }))
    expect(within(dialog).getByText('Code is required.')).toBeInTheDocument()
    expect(within(dialog).getByText('Name is required.')).toBeInTheDocument()
    expect(api.find('POST', '/masters/system-types')).toHaveLength(0)

    await userEvent.type(within(dialog).getByLabelText(/Code/), 'fa')
    await userEvent.type(within(dialog).getByLabelText(/^Name/), 'Duplicate')
    await userEvent.clear(within(dialog).getByLabelText(/Sort order/))
    await userEvent.type(within(dialog).getByLabelText(/Sort order/), '45')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add system type' }))

    expect(await within(dialog).findByText('A system type with code "fa" already exists.')).toBeInTheDocument()
    expect(api.find('POST', '/masters/system-types')[0]?.body).toEqual({ code: 'fa', name: 'Duplicate', sortOrder: 45, description: '' })
  })
})

describe('status', () => {
  it('changes status only on Apply, and Cancel puts the select back', async () => {
    const api = typesApi(ADMIN, [FA], (request) => (request.path === '/masters/system-types/4/status' ? ok({ ...FA, isActive: false }) : undefined))
    renderPage()
    await table()

    const select = screen.getByRole('combobox', { name: 'Status of Fire Alarm' })
    await userEvent.selectOptions(select, 'inactive')
    await userEvent.click(screen.getByRole('button', { name: 'Keep Fire Alarm Active' }))
    expect(select).toHaveValue('active')
    expect(api.find('POST', '/masters/system-types/4/status')).toHaveLength(0)

    await userEvent.selectOptions(select, 'inactive')
    await userEvent.click(screen.getByRole('button', { name: 'Apply Disabled to Fire Alarm' }))

    await waitFor(() => expect(api.find('POST', '/masters/system-types/4/status')[0]?.body).toEqual({ isActive: false }))
    expect(await screen.findByText(/Fire Alarm is now Disabled\. Contracts that use it keep it/)).toBeInTheDocument()
  })
})

describe('linked contracts and deletion', () => {
  it('lists the linked AMC contracts read-only', async () => {
    typesApi(ADMIN, [FA], (request) =>
      request.path === '/masters/system-types/4/contracts'
        ? ok({
            items: [{ id: '31', client: { id: '3', name: 'Harbour Towers' }, systemDescription: 'Fire alarm panels', validFrom: '2027-01-01', validTo: '2027-12-31', status: 'ACTIVE' }],
            total: 1,
            page: 1,
            pageSize: 10,
          })
        : undefined,
    )
    renderPage()
    await table()

    await userEvent.click(screen.getByRole('button', { name: 'View the 2 AMC contracts using Fire Alarm' }))
    const dialog = await screen.findByRole('dialog', { name: 'AMC contracts using FA — Fire Alarm' })
    expect(await within(dialog).findByRole('link', { name: 'Harbour Towers' })).toHaveAttribute('href', '/amc/contracts/31')
    expect(within(dialog).queryByRole('button', { name: /Edit|Delete/ })).not.toBeInTheDocument()
  })

  it('explains why a linked type cannot be deleted, without calling delete', async () => {
    const api = typesApi(ADMIN, [FA])
    renderPage()
    await table()

    await userEvent.click(screen.getByRole('button', { name: 'Delete Fire Alarm' }))
    const dialog = await screen.findByRole('dialog', { name: 'This system type cannot be deleted' })
    expect(within(dialog).getByText(/is used by 2 AMC contracts/)).toBeInTheDocument()
    expect(within(dialog).getByText(/Disable it instead/)).toBeInTheDocument()
    expect(api.find('DELETE', '/masters/system-types/4')).toHaveLength(0)
  })

  it('deletes an unused type after confirmation, and shows a refusal from the server', async () => {
    let refuse = true
    const api = typesApi(ADMIN, [CCTV], (request) => {
      if (request.method !== 'DELETE') return undefined
      return refuse ? fail(409, 'CONFLICT', '"CCTV" is used by 1 AMC contract and cannot be deleted.') : ok({ deleted: true })
    })
    renderPage()
    await table()

    await userEvent.click(screen.getByRole('button', { name: 'Delete CCTV' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete system type' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(await within(dialog).findByText('"CCTV" is used by 1 AMC contract and cannot be deleted.')).toBeInTheDocument()

    refuse = false
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('The system type "CCTV" was deleted.')).toBeInTheDocument()
    expect(api.find('DELETE', '/masters/system-types/2')).toHaveLength(2)
  })
})

describe('permissions', () => {
  it('offers a view-only role no add, edit, status change, delete or export', async () => {
    typesApi(SETTINGS_VIEWER, [FA])
    renderPage()
    const list = await table()

    expect(within(list).getByText('Active')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add System Type' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: /Status of/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^(Edit|Delete) / })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Export/ })).not.toBeInTheDocument()
    // Without contract view permission the count is shown, not opened.
    expect(screen.queryByRole('button', { name: /View the 2 AMC contracts/ })).not.toBeInTheDocument()
  })
})

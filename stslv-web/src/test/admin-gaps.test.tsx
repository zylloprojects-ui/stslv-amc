import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser, User } from '../lib/types'
import { AuthContext, type AuthValue } from '../auth/context'
import { actionLabel, moduleLabel } from '../pages/admin/auditTypes'
import { ModulePlaceholderPage } from '../pages/ModulePlaceholderPage'
import { ACCOUNTANT, ADMIN, fail, mockApi, ok, renderApp, signIn, type MockReply, type MockRequest } from './helpers'
import { MemoryRouter } from 'react-router-dom'

// Users search and edit, Login History, Audit Log, Deletion Log, Backup & Restore and the sign-out event.
// Every record here is invented test data.

/** Holds USERS:VIEW but is not an administrator. */
const MANAGER: SessionUser = { ...ACCOUNTANT, id: '7', permissions: [...ACCOUNTANT.permissions, 'USERS:VIEW'] }

const USERS: User[] = [
  { id: '1', email: 'admin@example.com', fullName: 'Asha Admin', isActive: true, approvalStatus: 'APPROVED', lastLoginAt: null, createdAt: '2026-10-01T07:00:00.000Z', roles: [{ id: '1', code: 'ADMIN', name: 'Super Admin' }] },
  { id: '2', email: 'staff@example.com', fullName: 'Sam Staff', isActive: true, approvalStatus: 'APPROVED', lastLoginAt: null, createdAt: '2026-10-01T07:00:00.000Z', roles: [{ id: '2', code: 'ACCOUNTANT', name: 'Accountant' }] },
]

function api(user: SessionUser, handler: (request: MockRequest) => MockReply | undefined = () => undefined) {
  signIn()

  return mockApi((request) => {
    const own = handler(request)
    if (own) return own
    if (request.path === '/auth/me') return ok({ user })
    if (request.path === '/auth/logout') return ok(null)
    if (request.path === '/roles') return ok({ roles: [], modules: [], actions: [] })
    if (request.path === '/users') return ok({ items: USERS, total: 60, pendingTotal: 0, page: Number(request.query.get('page') ?? 1), pageSize: 25 })
    if (request.path === '/audit/logins') {
      return ok({
        items: [
          { id: '2', outcome: 'SUCCESS', user: { id: '5', fullName: 'Sam Staff', email: 'staff@example.com' }, ip: '203.0.113.5', userAgent: '<script>alert(1)</script> Browser/1', reason: null, createdAt: '2026-10-20T08:00:00.000Z' },
          { id: '1', outcome: 'SUCCESS', user: { id: '5', fullName: 'Sam Staff', email: 'staff@example.com' }, ip: '203.0.113.5', userAgent: null, reason: null, createdAt: '2026-10-19T08:00:00.000Z' },
        ],
        total: 2,
        failedTotal: 0,
        page: 1,
        pageSize: 25,
      })
    }
    if (request.path === '/audit/activity/options') return ok({ modules: ['AUTH'], entityTypes: ['users'], users: [] })
    if (request.path === '/audit/activity') {
      return ok({
        items: [
          { id: '9', action: 'auth.login', module: 'AUTH', entityType: 'users', entityId: '5', description: 'Sam Staff signed in.', user: { id: '5', fullName: 'Sam Staff' }, changes: null, reason: null, ip: '203.0.113.5', createdAt: '2026-10-20T08:00:00.000Z' },
        ],
        total: 1,
        page: 1,
        pageSize: 25,
      })
    }
    if (request.path === '/security/recycle-bin') {
      return ok({ items: [], total: 0, page: 1, pageSize: 25, counts: { AMC_CONTRACT: 0, CLIENT: 0, SYSTEM_TYPE: 0, SALES_ENGINEER: 0 }, options: { deletedBy: [] } })
    }
    if (request.path === '/security/deletions') {
      return ok({
        items: [{ id: '3', kind: 'DELETED', action: 'holiday.deleted', entityType: 'holidays', entityId: '44', description: 'Holiday removed.', reason: null, user: 'Asha Admin', createdAt: '2026-10-20T08:00:00.000Z' }],
        total: 1,
        page: 1,
        pageSize: 25,
        options: { entityTypes: [], users: [] },
      })
    }

    return undefined
  })
}

const exportFile = () => new Response(new Blob(['file']), { status: 200, headers: { 'Content-Disposition': 'attachment; filename="x.xlsx"' } })

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('small wording', () => {
  it('has no phase wording on the placeholder page', () => {
    render(
      <AuthContext.Provider value={{ can: () => false } as unknown as AuthValue}>
        <MemoryRouter>
          <ModulePlaceholderPage title="Something" />
        </MemoryRouter>
      </AuthContext.Provider>,
    )
    expect(screen.getByText(/Something has not been built yet/)).toBeInTheDocument()
    expect(screen.queryByText(/Phase/)).not.toBeInTheDocument()
  })

  it('labels the module Service Sales in the logs', () => {
    expect(moduleLabel('SERVICES_SALES')).toBe('Service Sales')
    expect(actionLabel('services_sales.exported')).toMatch(/^Service sales exported$/i)
    expect(actionLabel('deletion_log.exported')).toMatch(/^Recycle bin exported$/i)
    expect(actionLabel('amc_visit.quotation_changed')).toMatch(/quotation changed/i)
  })
})

describe('Users page', () => {
  it('sends search, status and page to the API, and pages', async () => {
    const calls = api(ADMIN)
    renderApp('/admin/users')

    expect(await screen.findByText('Sam Staff')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Search'), 'sam')
    await waitFor(() => expect(calls.find('GET', '/users').at(-1)?.query.get('search')).toBe('sam'))
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'INACTIVE')
    await waitFor(() => expect(calls.find('GET', '/users').at(-1)?.query.get('status')).toBe('INACTIVE'))
    await userEvent.click(screen.getByRole('button', { name: /next/i }))
    await waitFor(() => expect(calls.find('GET', '/users').at(-1)?.query.get('page')).toBe('2'))
  })

  it('edits a full name and shows a refusal from the API', async () => {
    const calls = api(ADMIN, (request) => {
      if (request.method !== 'PATCH' || request.path !== '/users/2') return undefined
      const { fullName } = request.body as { fullName: string }

      return fullName === 'Refused' ? fail(403, 'FORBIDDEN', 'You cannot manage this user.') : ok({ ...USERS[1], fullName })
    })
    renderApp('/admin/users')

    await userEvent.click(await screen.findByRole('button', { name: 'Edit Sam Staff' }))
    const dialog = await screen.findByRole('dialog')
    const name = within(dialog).getByLabelText(/Full name/)
    await userEvent.clear(name)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await within(dialog).findByText('Full name is required.')).toBeInTheDocument()

    await userEvent.type(name, 'Refused')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await within(dialog).findByText('You cannot manage this user.')).toBeInTheDocument()

    await userEvent.clear(name)
    await userEvent.type(name, 'Samuel Staff')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Samuel Staff was updated.')).toBeInTheDocument()
    expect(calls.find('PATCH', '/users/2').at(-1)?.body).toEqual({ fullName: 'Samuel Staff' })
  })

  it('hides a column and remembers it', async () => {
    api(ADMIN)
    const first = renderApp('/admin/users')

    expect(await screen.findByRole('columnheader', { name: 'Email' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Columns/ }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Email' }))
    expect(screen.queryByRole('columnheader', { name: 'Email' })).not.toBeInTheDocument()
    expect(screen.queryByText('staff@example.com')).not.toBeInTheDocument()
    first.unmount()

    renderApp('/admin/users')
    expect(await screen.findByRole('columnheader', { name: 'Role' })).toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: 'Email' })).not.toBeInTheDocument()
  })

  it('offers export to administrators only, with the page filters', async () => {
    const calls: string[] = []
    api(ADMIN)
    const mocked = vi.mocked(fetch)
    const original = mocked.getMockImplementation()
    mocked.mockImplementation(async (input, init) => {
      if (String(input).includes('/users/export')) {
        calls.push(String(input))
        return exportFile()
      }
      return (original as typeof fetch)(input, init)
    })
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined }))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    renderApp('/admin/users')

    await screen.findByText('Sam Staff')
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'ACTIVE')
    await userEvent.click(screen.getByRole('button', { name: 'Export Users to Excel' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toContain('status=ACTIVE')
    expect(calls[0]).toContain('format=xlsx')
  })

  it('offers no export to a user manager who is not an administrator', async () => {
    api(MANAGER)
    renderApp('/admin/users')

    await screen.findByText('Sam Staff')
    expect(screen.queryByRole('group', { name: 'Export Users' })).not.toBeInTheDocument()
  })
})

describe('Login History', () => {
  it('shows the user agent as plain text, blank on an older entry', async () => {
    api(ADMIN)
    renderApp('/admin/login-history')

    const cell = await screen.findByText('<script>alert(1)</script> Browser/1')
    expect(cell.querySelector('script')).toBeNull()
    expect(screen.getByRole('columnheader', { name: 'Browser / device' })).toBeInTheDocument()
    const rows = screen.getAllByRole('row')
    expect(within(rows[2] as HTMLElement).getAllByRole('cell').at(-1)?.textContent).toBe('')
    expect(screen.getByRole('group', { name: 'Export Login History' })).toBeInTheDocument()
  })

  it('hides a column', async () => {
    api(ADMIN)
    renderApp('/admin/login-history')

    await screen.findByRole('columnheader', { name: 'Network address' })
    await userEvent.click(screen.getByRole('button', { name: /Columns/ }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Network address' }))
    expect(screen.queryByRole('columnheader', { name: 'Network address' })).not.toBeInTheDocument()
  })

  it('offers no export to a user manager', async () => {
    api(MANAGER)
    renderApp('/admin/login-history')

    await screen.findByRole('columnheader', { name: 'Browser / device' })
    expect(screen.queryByRole('group', { name: 'Export Login History' })).not.toBeInTheDocument()
  })
})

describe('Audit Log', () => {
  it('shows the network address, can hide it, and offers export', async () => {
    api(ADMIN)
    renderApp('/admin/audit-log')

    expect(await screen.findByText(/203\.0\.113\.5/)).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Export Audit Log' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Columns/ }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Network address' }))
    expect(screen.queryByText(/203\.0\.113\.5/)).not.toBeInTheDocument()
  })
})

describe('Deletion Log', () => {
  it('hides a column', async () => {
    api(ADMIN)
    // Super Admin opens on the Recycle Bin; the history is its own view.
    renderApp('/admin/deletion-log?view=history')

    await screen.findByRole('columnheader', { name: 'Record no.' })
    await userEvent.click(screen.getByRole('button', { name: /Columns/ }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Record no.' }))
    expect(screen.queryByRole('columnheader', { name: 'Record no.' })).not.toBeInTheDocument()
    expect(screen.queryByText('44')).not.toBeInTheDocument()
  })
})

describe('Backup & Restore', () => {
  const STATUS = { available: true, unavailableReason: null, automaticSchedule: false, storageConfigured: true, storageDeclaredDurable: false, toolVersion: '17.11', checks: [] }
  const SHA = 'b'.repeat(64)
  const VERIFIED = { id: 'backup_1', state: 'VERIFIED', startedAt: '2026-10-31T10:00:00.000Z', finishedAt: '2026-10-31T10:00:05.000Z', startedBy: 'Asha', sizeBytes: 2048, sha256: SHA, tableEntries: 40, failure: null }

  it('states what is not provided, shows the full checksum and the download check, and offers no delete, schedule or restore', async () => {
    api(ADMIN, (request) => (request.path === '/security/backups' ? ok({ status: STATUS, items: [VERIFIED] }) : undefined))
    renderApp('/admin/backups')

    expect(await screen.findByRole('heading', { name: 'Not provided by this application' })).toBeInTheDocument()
    // Each gap is stated with its own explanation, in the same item: title and meaning are never separated.
    const gaps = within(screen.getByRole('list', { name: 'Not provided' })).getAllByRole('listitem')
    expect(gaps).toHaveLength(3)
    // The title and its meaning are one sentence in one item ("Title: meaning").
    const gap = (index: number, title: string, text: string) => {
      expect(within(gaps[index] as HTMLElement).getByText(`${title}: ${text}`)).toBeInTheDocument()
    }
    gap(0, 'Automatic backups', 'no backup runs on a schedule.')
    gap(1, 'Retention', 'no backup is removed or expired automatically, and no retention period applies.')
    gap(2, 'Restore from this screen', 'no page or button restores a database.')
    expect(screen.getByText(/await approval/)).toBeInTheDocument()
    // The status figures: no schedule is offered, and only Super Admin runs and downloads backups.
    const figure = (label: string) => screen.getAllByText(label).find((element) => element.tagName === 'DT')?.nextElementSibling
    expect(figure('Automatic backups')).toHaveTextContent('Not provided. Awaiting approval.')
    expect(figure('Manual backups')).toHaveTextContent('Available')
    expect(figure('Backup tool')).toHaveTextContent('pg_dump 17.11')
    expect(figure('Who can run and download')).toHaveTextContent('Super Admin only')
    expect(screen.getByText(SHA)).toBeInTheDocument()
    expect(screen.getByText(/recalculates the file's SHA-256/)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /delete|schedule|retention|restore/i }).map((button) => button.textContent)).toEqual(['Backup & Restore']) // Only the Settings item: no such action.
  })
})

describe('Sign-out', () => {
  it('records the sign-out without blocking it, even when the API never answers', async () => {
    const calls: { url: string; authorization: string | undefined; keepalive: boolean | undefined }[] = []
    api(ADMIN)
    const mocked = vi.mocked(fetch)
    const original = mocked.getMockImplementation()
    mocked.mockImplementation(async (input, init) => {
      if (String(input).includes('/auth/logout')) {
        calls.push({ url: String(input), authorization: ((init?.headers ?? {}) as Record<string, string>).Authorization, keepalive: init?.keepalive })
        return new Promise<Response>(() => undefined)
      }
      return (original as typeof fetch)(input, init)
    })
    renderApp('/account')

    await userEvent.click(await screen.findByRole('button', { name: /account menu/i }))
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }))
    expect(await screen.findByLabelText(/Email/)).toBeInTheDocument()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.authorization).toMatch(/^Bearer /)
    expect(calls[0]?.keepalive).toBe(true)
  })

  it('still signs out when the call fails, and does not call it for a session the API ended', async () => {
    const calls = api(ADMIN, (request) => (request.path === '/auth/logout' ? fail(500, 'INTERNAL', 'Failed') : undefined))
    renderApp('/account')

    await userEvent.click(await screen.findByRole('button', { name: /account menu/i }))
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }))
    expect(await screen.findByLabelText(/Email/)).toBeInTheDocument()
    expect(calls.find('POST', '/auth/logout')).toHaveLength(1)
  })

  it('does not record a sign-out when the API refuses the session', async () => {
    const calls = api(ADMIN, (request) => (request.path === '/auth/me' ? fail(401, 'UNAUTHORIZED', 'Sign in again.') : undefined))
    renderApp('/account')

    expect(await screen.findByLabelText(/Email/)).toBeInTheDocument()
    expect(calls.find('POST', '/auth/logout')).toHaveLength(0)
  })
})

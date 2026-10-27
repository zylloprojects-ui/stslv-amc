import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { SessionUser } from '../lib/types'
import type { ActivityRecord, LoginRecord } from '../pages/admin/auditTypes'
import { ACCOUNTANT, ADMIN, fail, mockApi, ok, renderApp, signIn, type MockRequest } from './helpers'

// Login History and Audit Log pages. Every record here is invented test data.

/** Holds USERS:VIEW but is not an Admin: sees Login History, not the Audit Log. */
const USER_MANAGER: SessionUser = { ...ACCOUNTANT, id: '7', permissions: [...ACCOUNTANT.permissions, 'USERS:VIEW'] }

const LOGINS: LoginRecord[] = [
  { id: '3', outcome: 'FAILED', user: null, ip: '203.0.113.7', reason: 'unknown_account', createdAt: '2026-10-20T08:05:00.000Z' },
  { id: '2', outcome: 'FAILED', user: { id: '5', fullName: 'Staff Member', email: 'staff@example.com' }, ip: '203.0.113.5', reason: 'wrong_password', createdAt: '2026-10-20T08:01:00.000Z' },
  { id: '1', outcome: 'SUCCESS', user: { id: '5', fullName: 'Staff Member', email: 'staff@example.com' }, ip: '203.0.113.5', reason: null, createdAt: '2026-10-20T08:00:00.000Z' },
]

const ACTIVITY: ActivityRecord[] = [
  {
    id: '20',
    action: 'amc_contract.updated',
    module: 'AMC_CONTRACTS',
    entityType: 'amc_contracts',
    entityId: '100',
    description: 'AMC contract for "Test Hotel" (FIRE) updated.',
    user: { id: '1', fullName: 'Asha Admin' },
    changes: { contractValue: { from: '1500.000', to: '1620.000' } },
    reason: null,
    createdAt: '2026-10-20T09:00:00.000Z',
  },
  {
    id: '10',
    action: 'client.created',
    module: 'CLIENTS',
    entityType: 'clients',
    entityId: '7',
    description: 'Client "Test Hotel" created.',
    user: null,
    changes: null,
    reason: null,
    createdAt: '2026-10-19T09:00:00.000Z',
  },
]

function auditApi(user: SessionUser, override?: (request: MockRequest) => ReturnType<typeof ok> | undefined) {
  signIn()

  return mockApi((request) => {
    const overridden = override?.(request)
    if (overridden) return overridden
    if (request.path === '/auth/me') return ok({ user })
    if (request.path === '/audit/logins') {
      const outcome = request.query.get('outcome')
      const items = LOGINS.filter((login) => !outcome || login.outcome === outcome)

      return ok({ items, total: items.length, failedTotal: items.filter((login) => login.outcome === 'FAILED').length, page: 1, pageSize: 25 })
    }
    if (request.path === '/audit/activity/options') {
      return ok({ modules: ['AMC_CONTRACTS', 'CLIENTS'], entityTypes: ['amc_contracts', 'clients'], users: [{ id: '1', fullName: 'Asha Admin' }] })
    }
    if (request.path === '/audit/activity') {
      const module = request.query.get('module')
      const items = ACTIVITY.filter((entry) => !module || entry.module === module)

      return ok({ items, total: items.length, page: 1, pageSize: 25 })
    }

    return undefined
  })
}

describe('Login History', () => {
  it('lists sign-ins with user, outcome, failure reason and address', async () => {
    auditApi(ADMIN)
    renderApp('/admin/login-history')

    const table = await screen.findByRole('table', { name: 'Sign-ins' })
    const rows = within(table).getAllByRole('row').slice(1)

    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('No account (email not recorded)')
    expect(rows[0]).toHaveTextContent('No account with this email')
    expect(rows[1]).toHaveTextContent('Staff Member')
    expect(rows[1]).toHaveTextContent('Wrong password')
    expect(rows[2]).toHaveTextContent('Successful')
    expect(rows[2]).toHaveTextContent('203.0.113.5')
    expect(screen.getByText('3 sign-ins, 2 failed.')).toBeInTheDocument()
  })

  it('filters by outcome and sends the filter to the API', async () => {
    const api = auditApi(ADMIN)
    renderApp('/admin/login-history')

    await screen.findByRole('table', { name: 'Sign-ins' })
    await userEvent.selectOptions(screen.getByLabelText('Outcome'), 'SUCCESS')

    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Sign-ins' })).getAllByRole('row')).toHaveLength(2))
    expect(api.requests.filter((request) => request.path === '/audit/logins').at(-1)?.query.get('outcome')).toBe('SUCCESS')
  })

  it('refuses a date range that ends before it starts, without asking the API', async () => {
    const api = auditApi(ADMIN)
    renderApp('/admin/login-history')

    await screen.findByRole('table', { name: 'Sign-ins' })
    const before = api.find('GET', '/audit/logins').length
    await userEvent.type(screen.getByLabelText('From'), '2026-10-20')
    await userEvent.type(screen.getByLabelText('To'), '2026-10-01')

    expect(await screen.findByText('The From date is after the To date.')).toBeInTheDocument()
    expect(api.requests.filter((request) => request.path === '/audit/logins' && request.query.get('to') === '2026-10-01')).toHaveLength(0)
    expect(api.find('GET', '/audit/logins').length).toBeGreaterThanOrEqual(before)
  })

  it('shows the error from the API with a way to try again', async () => {
    auditApi(ADMIN, (request) => (request.path === '/audit/logins' ? fail(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.') : undefined))
    renderApp('/admin/login-history')

    expect(await screen.findByText(/Something went wrong/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('is open to a user manager, and the Audit Log is not offered to them', async () => {
    auditApi(USER_MANAGER)
    renderApp('/admin/login-history')

    expect(await screen.findByRole('table', { name: 'Sign-ins' })).toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: 'Main' })
    expect(within(nav).queryByRole('link', { name: /Audit Log/ })).not.toBeInTheDocument()
  })

  it('is refused to a role without user management', async () => {
    const api = auditApi(ACCOUNTANT)
    renderApp('/admin/login-history')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(api.find('GET', '/audit/logins')).toHaveLength(0)
  })
})

describe('Audit Log', () => {
  it('lists activity with module, user, record, changes in words and "System" for unattended actions', async () => {
    auditApi(ADMIN)
    renderApp('/admin/audit-log')

    const list = await screen.findByRole('list', { name: 'Activity, newest first' })
    const entries = Array.from(list.children) as HTMLElement[]

    expect(entries).toHaveLength(2)
    expect(entries[0]).toHaveTextContent('Amc contract updated')
    expect(entries[0]).toHaveTextContent('AMC contracts')
    expect(entries[0]).toHaveTextContent('Asha Admin')
    expect(entries[0]).toHaveTextContent('Contract value: 1500.000 → 1620.000')
    expect(entries[0]).toHaveTextContent('Record: Amc contracts #100')
    expect(entries[1]).toHaveTextContent('System')
  })

  it('filters by module', async () => {
    const api = auditApi(ADMIN)
    renderApp('/admin/audit-log')

    await screen.findByRole('list', { name: 'Activity, newest first' })
    await userEvent.selectOptions(await screen.findByLabelText('Module'), 'CLIENTS')

    await waitFor(() => expect(Array.from(screen.getByRole('list', { name: 'Activity, newest first' }).children)).toHaveLength(1))
    expect(api.requests.filter((request) => request.path === '/audit/activity').at(-1)?.query.get('module')).toBe('CLIENTS')
  })

  it('is shown in the navigation to an Admin', async () => {
    auditApi(ADMIN)
    renderApp('/admin/audit-log')

    await screen.findByRole('list', { name: 'Activity, newest first' })
    const nav = screen.getByRole('navigation', { name: 'Main' })
    expect(within(nav).getByRole('link', { name: /Audit Log/ })).toHaveAttribute('href', '/admin/audit-log')
    expect(within(nav).getByRole('link', { name: /Login History/ })).toHaveAttribute('href', '/admin/login-history')
  })

  it('is refused to a user manager who is not an Admin, without requesting the log', async () => {
    const api = auditApi(USER_MANAGER)
    renderApp('/admin/audit-log')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(api.find('GET', '/audit/activity')).toHaveLength(0)
  })
})

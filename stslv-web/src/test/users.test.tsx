import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ACTIONS, MODULES, type Role, type SessionUser, type User } from '../lib/types'
import { ADMIN, mockApi, ok, renderApp, signIn } from './helpers'

const ROLES: Role[] = [
  {
    id: '1',
    code: 'ADMIN',
    name: 'Admin',
    description: 'Full access.',
    isActive: true,
    userCount: 1,
    permissions: MODULES.flatMap((module) => ACTIONS.map((action) => ({ module, action }))),
    permissionsEditable: false,
  },
  {
    id: '2',
    code: 'ACCOUNTANT',
    name: 'Accountant',
    description: 'Records project expenses.',
    isActive: true,
    userCount: 1,
    permissions: [
      { module: 'CLIENTS', action: 'VIEW' },
      { module: 'EXPENSES', action: 'CREATE' },
    ],
    permissionsEditable: true,
  },
]

const USERS: User[] = [
  { id: '1', email: 'admin@example.com', fullName: 'Asha Admin', isActive: true, approvalStatus: 'APPROVED', lastLoginAt: '2026-10-01T08:00:00.000Z', createdAt: '2026-10-01T07:00:00.000Z', roles: [{ id: '1', code: 'ADMIN', name: 'Admin' }] },
  { id: '2', email: 'accountant@example.com', fullName: 'Arun Accountant', isActive: true, approvalStatus: 'APPROVED', lastLoginAt: null, createdAt: '2026-10-01T07:00:00.000Z', roles: [{ id: '2', code: 'ACCOUNTANT', name: 'Accountant' }] },
]

function usersApi(user: SessionUser = ADMIN) {
  const users = USERS.map((entry) => ({ ...entry }))

  signIn()

  return mockApi((request) => {
    if (request.path === '/auth/me') return ok({ user })
    if (request.method === 'GET' && request.path === '/users') return ok(users)
    if (request.method === 'GET' && request.path === '/roles') return ok({ roles: ROLES, modules: MODULES, actions: ACTIONS })
    if (request.method === 'POST' && request.path === '/users') {
      const body = request.body as { email: string; fullName: string; roleIds: string[] }
      const created: User = {
        id: '3',
        email: body.email,
        fullName: body.fullName,
        isActive: true,
        approvalStatus: 'APPROVED',
        lastLoginAt: null,
        createdAt: '2026-10-01T09:00:00.000Z',
        roles: ROLES.filter((role) => body.roleIds.includes(role.id)),
      }
      users.push(created)
      return ok(created, 201)
    }
    if (request.method === 'POST' && request.path === '/users/2/deactivate') {
      users[1] = { ...(users[1] as User), isActive: false }
      return ok(users[1])
    }
    if (request.method === 'PUT' && request.path === '/users/2/roles') {
      const { roleIds } = request.body as { roleIds: string[] }
      users[1] = { ...(users[1] as User), roles: ROLES.filter((role) => roleIds.includes(role.id)) }
      return ok(users[1])
    }
    if (request.method === 'PUT' && request.path === '/roles/2/permissions') {
      return ok({ ...(ROLES[1] as Role), permissions: (request.body as { permissions: Role['permissions'] }).permissions })
    }
    return undefined
  })
}

describe('users', () => {
  it('lists users with their roles and status, and protects the signed-in user from themselves', async () => {
    usersApi()
    renderApp('/admin/users')

    const table = await screen.findByRole('table', { name: 'Users' })
    const rows = within(table).getAllByRole('row').slice(1)

    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Asha Admin(you)')
    expect(rows[1]).toHaveTextContent('Arun Accountant')
    expect(within(rows[1] as HTMLElement).getByText('Accountant')).toBeInTheDocument()
    expect(rows[1]).toHaveTextContent('Never')

    expect(screen.getByRole('button', { name: 'Deactivate Asha Admin' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Change roles of Asha Admin' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Deactivate Arun Accountant' })).toBeEnabled()
  })

  it('creates a user with the chosen role', async () => {
    const api = usersApi()
    renderApp('/admin/users')

    await userEvent.click(await screen.findByRole('button', { name: 'Create User' }))
    const dialog = await screen.findByRole('dialog', { name: 'Create User' })

    // Too short a password is refused before anything is sent.
    await userEvent.type(within(dialog).getByLabelText(/Full name/), 'Test Person')
    await userEvent.type(within(dialog).getByLabelText(/Email/), 'test.person@example.com')
    await userEvent.type(within(dialog).getByLabelText(/Temporary password/), 'short')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create user' }))
    expect(await within(dialog).findByText('Password must be at least 10 characters.')).toBeInTheDocument()
    expect(api.find('POST', '/users')).toHaveLength(0)

    await userEvent.type(within(dialog).getByLabelText(/Temporary password/), '-but-now-long-enough')
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /Accountant/ }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create user' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('POST', '/users')[0]?.body).toEqual({
      fullName: 'Test Person',
      email: 'test.person@example.com',
      password: 'short-but-now-long-enough',
      roleIds: ['2'],
    })
    expect(await screen.findByText('Test Person')).toBeInTheDocument()
  })

  it('deactivates a user after confirmation', async () => {
    const api = usersApi()
    renderApp('/admin/users')

    await userEvent.click(await screen.findByRole('button', { name: 'Deactivate Arun Accountant' }))
    const dialog = await screen.findByRole('dialog', { name: 'Deactivate user' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Deactivate' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('POST', '/users/2/deactivate')).toHaveLength(1)
    expect(await screen.findByRole('button', { name: 'Activate Arun Accountant' })).toBeInTheDocument()
  })

  it('assigns and removes roles', async () => {
    const api = usersApi()
    renderApp('/admin/users')

    await userEvent.click(await screen.findByRole('button', { name: 'Change roles of Arun Accountant' }))
    const dialog = await screen.findByRole('dialog', { name: 'Roles for Arun Accountant' })

    expect(within(dialog).getByRole('checkbox', { name: /Accountant/ })).toBeChecked()
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /Accountant/ }))
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /Admin/ }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save roles' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('PUT', '/users/2/roles')[0]?.body).toEqual({ roleIds: ['1'] })
  })

  it('hides management actions from a user who may only view', async () => {
    usersApi({ ...ADMIN, permissions: ['USERS:VIEW'] })
    renderApp('/admin/users')

    await screen.findByRole('table', { name: 'Users' })

    expect(screen.queryByRole('button', { name: 'Create User' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Deactivate / })).not.toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).not.toBeInTheDocument()
  })
})

describe('sign-up requests', () => {
  const PENDING: User = {
    id: '7',
    email: 'new.person@example.com',
    fullName: 'Nadia Newcomer',
    isActive: false,
    approvalStatus: 'PENDING',
    lastLoginAt: null,
    createdAt: '2026-10-01T09:30:00.000Z',
    roles: [],
  }

  function pendingApi(user: SessionUser = ADMIN) {
    const users: User[] = [...USERS.map((entry) => ({ ...entry })), { ...PENDING }]

    signIn()

    return mockApi((request) => {
      if (request.path === '/auth/me') return ok({ user })
      if (request.method === 'GET' && request.path === '/users') return ok(users)
      if (request.method === 'GET' && request.path === '/roles') return ok({ roles: ROLES, modules: MODULES, actions: ACTIONS })
      if (request.method === 'PUT' && request.path === '/users/7/roles') {
        const { roleIds } = request.body as { roleIds: string[] }
        users[2] = { ...(users[2] as User), roles: ROLES.filter((role) => roleIds.includes(role.id)) }
        return ok(users[2])
      }
      if (request.method === 'POST' && request.path === '/users/7/activate') {
        users[2] = { ...(users[2] as User), isActive: true, approvalStatus: 'APPROVED' }
        return ok(users[2])
      }
      return undefined
    })
  }

  it('marks a self-registered account as pending and offers to approve it', async () => {
    pendingApi()
    renderApp('/admin/users')

    const table = await screen.findByRole('table', { name: 'Users' })
    const row = within(table).getByRole('row', { name: /Nadia Newcomer/ })

    expect(within(row).getByText('Pending approval')).toBeInTheDocument()
    expect(within(row).getByText('No role')).toBeInTheDocument()
    expect(within(row).queryByText('Inactive')).not.toBeInTheDocument()
    expect(within(row).getByRole('button', { name: 'Approve Nadia Newcomer' })).toBeEnabled()
    expect(screen.getByRole('status')).toHaveTextContent('1 sign-up request is waiting for approval. A pending account cannot sign in. Assign a role, then approve it.')
  })

  it('shows no pending notice when nobody is waiting', async () => {
    usersApi()
    renderApp('/admin/users')

    await screen.findByRole('table', { name: 'Users' })

    expect(screen.queryByText(/waiting for approval/)).not.toBeInTheDocument()
    expect(screen.queryByText('Pending approval')).not.toBeInTheDocument()
  })

  it('warns before approving an account that has no role', async () => {
    const api = pendingApi()
    renderApp('/admin/users')

    await userEvent.click(await screen.findByRole('button', { name: 'Approve Nadia Newcomer' }))
    const dialog = await screen.findByRole('dialog', { name: 'Approve sign-up request' })

    expect(dialog).toHaveTextContent('new.person@example.com')
    expect(dialog).toHaveTextContent('No role is assigned yet')

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(api.find('POST', '/users/7/activate')).toHaveLength(0)
  })

  it('lets an administrator assign a role and then approve the request', async () => {
    const api = pendingApi()
    renderApp('/admin/users')

    await userEvent.click(await screen.findByRole('button', { name: 'Change roles of Nadia Newcomer' }))
    const roles = await screen.findByRole('dialog', { name: 'Roles for Nadia Newcomer' })
    await userEvent.click(within(roles).getByRole('checkbox', { name: /Accountant/ }))
    await userEvent.click(within(roles).getByRole('button', { name: 'Save roles' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('PUT', '/users/7/roles')[0]?.body).toEqual({ roleIds: ['2'] })

    // Still pending: a role alone does not open the account.
    const row = screen.getByRole('row', { name: /Nadia Newcomer/ })
    await waitFor(() => expect(within(row).getByText('Accountant')).toBeInTheDocument())
    expect(within(row).getByText('Pending approval')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Approve Nadia Newcomer' }))
    const dialog = await screen.findByRole('dialog', { name: 'Approve sign-up request' })
    expect(dialog).toHaveTextContent('They will have the access of: Accountant.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('POST', '/users/7/activate')).toHaveLength(1)
    expect(await screen.findByText('The sign-up request of Nadia Newcomer was approved. They can now sign in.')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Deactivate Nadia Newcomer' })).toBeInTheDocument()
    expect(screen.queryByText('Pending approval')).not.toBeInTheDocument()
  })

  it('shows a view-only user the pending request without a way to approve it', async () => {
    pendingApi({ ...ADMIN, permissions: ['USERS:VIEW'] })
    renderApp('/admin/users')

    await screen.findByRole('table', { name: 'Users' })

    expect(screen.getByText('Pending approval')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Approve / })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('1 sign-up request is waiting for approval. A pending account cannot sign in.')
    expect(screen.getByRole('status')).not.toHaveTextContent('Assign a role')
  })
})

describe('roles and permissions', () => {
  it('shows each role\'s permissions and keeps the Admin role read-only', async () => {
    usersApi()
    renderApp('/admin/users')

    await userEvent.click(await screen.findByRole('tab', { name: 'Roles & Permissions' }))

    // Admin is selected first: everything ticked, nothing editable.
    const adminBox = await screen.findByRole('checkbox', { name: 'Clients: Edit' })
    expect(adminBox).toBeChecked()
    expect(adminBox).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save permissions' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Accountant' }))

    expect(await screen.findByRole('checkbox', { name: 'Clients: View' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Clients: Edit' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Clients: Edit' })).toBeEnabled()
  })

  it('saves a changed permission set', async () => {
    const api = usersApi()
    renderApp('/admin/users')

    await userEvent.click(await screen.findByRole('tab', { name: 'Roles & Permissions' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Accountant' }))

    expect(screen.getByRole('button', { name: 'Save permissions' })).toBeDisabled()
    await userEvent.click(screen.getByRole('checkbox', { name: 'Clients: Edit' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save permissions' }))

    await waitFor(() => expect(api.find('PUT', '/roles/2/permissions')).toHaveLength(1))
    expect(api.find('PUT', '/roles/2/permissions')[0]?.body).toEqual({
      permissions:
      expect.arrayContaining([
        { module: 'CLIENTS', action: 'VIEW' },
        { module: 'EXPENSES', action: 'CREATE' },
        { module: 'CLIENTS', action: 'EDIT' },
      ]),
    })
  })

  it('does not let a user tick a permission they do not hold themselves', async () => {
    usersApi({ ...ADMIN, permissions: ['USERS:VIEW', 'USERS:EDIT', 'CLIENTS:VIEW'] })
    renderApp('/admin/users')

    await userEvent.click(await screen.findByRole('tab', { name: 'Roles & Permissions' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Accountant' }))

    expect(await screen.findByRole('checkbox', { name: 'Clients: View' })).toBeEnabled()
    expect(screen.getByRole('checkbox', { name: 'Clients: Edit' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Settings: Edit' })).toBeDisabled()
  })
})

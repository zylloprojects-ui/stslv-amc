import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ACTIONS, MODULES, type Role, type SessionUser, type User } from '../lib/types'
import { ADMIN, fail, mockApi, ok, renderApp, signIn, type MockReply } from './helpers'

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

type ResetReply = () => MockReply | Promise<MockReply>

function usersApi(user: SessionUser = ADMIN, onReset: ResetReply = () => ok(null)) {
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
    if (request.method === 'POST' && request.path === '/users/2/reset-password') return onReset()
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

  describe('reset password', () => {
    const NEW_PASSWORD = 'a-good-long-password'

    const resetApi = (onReset?: ResetReply) => usersApi(ADMIN, onReset)

    async function openConfirmation() {
      renderApp('/admin/users')
      await userEvent.click(await screen.findByRole('button', { name: 'Reset password of Arun Accountant' }))

      return screen.findByRole('dialog', { name: 'Reset Password?' })
    }

    async function confirmAndFill() {
      await userEvent.click(within(await openConfirmation()).getByRole('button', { name: 'Yes, Reset Password' }))
      const form = await screen.findByRole('dialog', { name: 'Reset password for Arun Accountant' })

      await userEvent.type(within(form).getByLabelText(/^New password/), NEW_PASSWORD)
      await userEvent.type(within(form).getByLabelText(/^Repeat new password/), NEW_PASSWORD)

      return form
    }

    it('asks for confirmation first, naming the user', async () => {
      const api = resetApi()
      const dialog = await openConfirmation()

      expect(dialog).toHaveTextContent('Are you sure you want to reset the password for this user?')
      expect(dialog).toHaveTextContent('Arun Accountant')
      expect(dialog).toHaveTextContent('accountant@example.com')
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled()
      expect(within(dialog).getByRole('button', { name: 'Yes, Reset Password' })).toBeEnabled()
      expect(api.requests.filter((request) => request.method !== 'GET')).toHaveLength(0)
    })

    it('changes nothing when cancelled', async () => {
      const api = resetApi()
      const dialog = await openConfirmation()

      await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(api.requests.filter((request) => request.method !== 'GET')).toHaveLength(0)
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
    })

    it('resets the password of the chosen user exactly once, and confirms only after the API does', async () => {
      let release: (reply: MockReply) => void = () => {}
      const api = resetApi(
        () =>
          new Promise<MockReply>((resolve) => {
            release = resolve
          }),
      )
      const form = await confirmAndFill()

      await userEvent.click(within(form).getByRole('button', { name: 'Reset password' }))

      await waitFor(() => expect(api.find('POST', '/users/2/reset-password')).toHaveLength(1))
      expect(screen.queryByText(/Password reset successfully/)).not.toBeInTheDocument()

      release(ok(null))

      expect(await screen.findByRole('status')).toHaveTextContent(
        'Password reset successfully for Arun Accountant. They have been signed out and must sign in again using the new password.',
      )
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(api.requests.filter((request) => request.path.endsWith('/reset-password'))).toHaveLength(1)
      expect(api.find('POST', '/users/2/reset-password')[0]?.body).toEqual({ password: NEW_PASSWORD })
      // The administrator stays signed in, on the same page.
      expect(localStorage.getItem('stslv-amc.token')).not.toBeNull()
      expect(screen.getByRole('table', { name: 'Users' })).toBeInTheDocument()
    })

    it('shows a failed reset and lets the administrator retry', async () => {
      let failing = true
      const api = resetApi(() => (failing ? fail(403, 'FORBIDDEN', 'You cannot manage a user who holds permissions you do not hold.') : ok(null)))
      const form = await confirmAndFill()

      await userEvent.click(within(form).getByRole('button', { name: 'Reset password' }))

      expect(await within(form).findByRole('alert')).toHaveTextContent('You cannot manage a user who holds permissions you do not hold.')
      expect(screen.queryByText(/Password reset successfully/)).not.toBeInTheDocument()

      failing = false
      await userEvent.click(within(form).getByRole('button', { name: 'Reset password' }))

      expect(await screen.findByRole('status')).toHaveTextContent('Password reset successfully for Arun Accountant.')
      expect(api.find('POST', '/users/2/reset-password')).toHaveLength(2)
    })
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

describe('rejecting a sign-up request', () => {
  const pending = (id: string, fullName: string, email: string, roles: User['roles'] = []): User => ({
    id,
    email,
    fullName,
    isActive: false,
    approvalStatus: 'PENDING',
    lastLoginAt: null,
    createdAt: '2026-10-01T09:30:00.000Z',
    roles,
  })

  const DEACTIVATED: User = {
    id: '5',
    email: 'leaver@example.com',
    fullName: 'Lena Leaver',
    isActive: false,
    approvalStatus: 'APPROVED',
    lastLoginAt: '2026-09-01T08:00:00.000Z',
    createdAt: '2026-08-01T07:00:00.000Z',
    roles: [{ id: '2', code: 'ACCOUNTANT', name: 'Accountant' }],
  }

  const REJECTED: User = { ...pending('6', 'Rita Rejected', 'rita@example.com'), approvalStatus: 'REJECTED' }

  function rejectionApi(options: { user?: SessionUser; refuse?: boolean } = {}) {
    const users: User[] = [
      ...USERS.map((entry) => ({ ...entry })),
      { ...DEACTIVATED },
      { ...REJECTED },
      pending('7', 'Nadia Newcomer', 'new.person@example.com'),
      pending('8', 'Omar Other', 'omar@example.com', [{ id: '2', code: 'ACCOUNTANT', name: 'Accountant' }]),
    ]

    signIn()

    return mockApi((request) => {
      if (request.path === '/auth/me') return ok({ user: options.user ?? ADMIN })
      if (request.method === 'GET' && request.path === '/users') return ok(users)
      if (request.method === 'GET' && request.path === '/roles') return ok({ roles: ROLES, modules: MODULES, actions: ACTIONS })

      const match = /^\/users\/(\d+)\/reject$/.exec(request.path)

      if (request.method === 'POST' && match) {
        if (options.refuse) return fail(409, 'CONFLICT', 'Only a pending sign-up request can be rejected.')

        const index = users.findIndex((entry) => entry.id === match[1])
        users[index] = { ...(users[index] as User), approvalStatus: 'REJECTED', roles: [] }
        return ok(users[index])
      }
      return undefined
    })
  }

  const row = (name: string) => screen.getByRole('row', { name: new RegExp(name) })

  it('offers Reject only for a pending registration', async () => {
    rejectionApi()
    renderApp('/admin/users')

    await screen.findByRole('table', { name: 'Users' })

    expect(screen.getAllByRole('button', { name: /^Reject / }).map((button) => button.getAttribute('aria-label'))).toEqual([
      'Reject Nadia Newcomer',
      'Reject Omar Other',
    ])
    // Pending: roles, approve and reject.
    for (const action of ['Change roles of Nadia Newcomer', 'Approve Nadia Newcomer', 'Reject Nadia Newcomer']) {
      expect(within(row('Nadia Newcomer')).getByRole('button', { name: action })).toBeEnabled()
    }
    // The signed-in Admin, an active Admin-created user and a deactivated approved user: no Reject.
    for (const name of ['Asha Admin', 'Arun Accountant', 'Lena Leaver']) {
      expect(within(row(name)).queryByRole('button', { name: /Reject/ })).not.toBeInTheDocument()
      expect(within(row(name)).queryByText('Pending approval')).not.toBeInTheDocument()
    }
    expect(within(row('Lena Leaver')).getByRole('button', { name: 'Activate Lena Leaver' })).toBeInTheDocument()
  })

  it('shows an already rejected registration as rejected, with nothing to click', async () => {
    rejectionApi()
    renderApp('/admin/users')

    await screen.findByRole('table', { name: 'Users' })

    expect(within(row('Rita Rejected')).getByText('Rejected')).toBeInTheDocument()
    expect(within(row('Rita Rejected')).getByText('No role')).toBeInTheDocument()
    expect(within(row('Rita Rejected')).queryByText('Inactive')).not.toBeInTheDocument()
    expect(within(row('Rita Rejected')).queryByRole('button')).not.toBeInTheDocument()
    // It is not counted as waiting.
    expect(screen.getByRole('status')).toHaveTextContent('2 sign-up requests are waiting for approval.')
  })

  it('asks for confirmation, naming the person, and sends nothing on Cancel', async () => {
    const api = rejectionApi()
    renderApp('/admin/users')

    await userEvent.click(await screen.findByRole('button', { name: 'Reject Nadia Newcomer' }))
    const dialog = await screen.findByRole('dialog', { name: 'Reject registration?' })

    expect(dialog).toHaveTextContent('Nadia Newcomer')
    expect(dialog).toHaveTextContent('new.person@example.com')
    expect(dialog).toHaveTextContent('This registration request will be rejected and the user will not receive access to STSLEV AMC.')
    expect(dialog).not.toHaveTextContent('Omar Other')
    expect(within(dialog).getByRole('button', { name: 'Reject' })).toBeEnabled()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(api.requests.filter((request) => request.path.endsWith('/reject'))).toHaveLength(0)
    expect(within(row('Nadia Newcomer')).getByText('Pending approval')).toBeInTheDocument()
  })

  it('rejects the request and updates the list and the pending count without a reload', async () => {
    const api = rejectionApi()
    renderApp('/admin/users')

    await userEvent.click(await screen.findByRole('button', { name: 'Reject Nadia Newcomer' }))
    const dialog = await screen.findByRole('dialog', { name: 'Reject registration?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reject' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('POST', '/users/7/reject')).toHaveLength(1)
    expect(api.find('POST', '/users/7/reject')[0]?.authorization).toBe('Bearer test-token')
    expect(api.find('POST', '/users/7/activate')).toHaveLength(0)
    expect(await screen.findByText('The sign-up request of Nadia Newcomer was rejected. They cannot sign in.')).toBeInTheDocument()

    // The row stays, now rejected and without actions; the other request is untouched.
    await waitFor(() => expect(within(row('Nadia Newcomer')).getByText('Rejected')).toBeInTheDocument())
    expect(within(row('Nadia Newcomer')).queryByText('Pending approval')).not.toBeInTheDocument()
    expect(within(row('Nadia Newcomer')).queryByRole('button')).not.toBeInTheDocument()
    expect(within(row('Omar Other')).getByText('Pending approval')).toBeInTheDocument()
    expect(screen.getByText(/waiting for approval/)).toHaveTextContent('1 sign-up request is waiting for approval.')
    // The list was fetched again rather than the page reloaded.
    expect(api.find('GET', '/users').length).toBeGreaterThan(1)
    expect(api.find('GET', '/auth/me')).toHaveLength(1)
  })

  it('removes the pending notice when the last request is rejected, and says which role is removed', async () => {
    rejectionApi()
    renderApp('/admin/users')

    await userEvent.click(await screen.findByRole('button', { name: 'Reject Nadia Newcomer' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reject' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: 'Reject Omar Other' }))
    const dialog = await screen.findByRole('dialog', { name: 'Reject registration?' })
    expect(dialog).toHaveTextContent('The role given while it was pending (Accountant) is removed.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reject' }))

    await waitFor(() => expect(screen.queryByText(/waiting for approval/)).not.toBeInTheDocument())
    expect(screen.queryByText('Pending approval')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^(Reject|Approve) / })).not.toBeInTheDocument()
    expect(within(row('Omar Other')).getByText('No role')).toBeInTheDocument()
  })

  it('shows the reason when the API refuses, and changes nothing', async () => {
    rejectionApi({ refuse: true })
    renderApp('/admin/users')

    await userEvent.click(await screen.findByRole('button', { name: 'Reject Nadia Newcomer' }))
    const dialog = await screen.findByRole('dialog', { name: 'Reject registration?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reject' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Only a pending sign-up request can be rejected.')
    expect(within(row('Nadia Newcomer')).getByText('Pending approval')).toBeInTheDocument()
    expect(screen.queryByText(/was rejected/)).not.toBeInTheDocument()
  })

  it('does not offer Reject to a user who may only view', async () => {
    rejectionApi({ user: { ...ADMIN, permissions: ['USERS:VIEW'] } })
    renderApp('/admin/users')

    await screen.findByRole('table', { name: 'Users' })

    expect(screen.getAllByText('Pending approval')).toHaveLength(2)
    expect(screen.getByText('Rejected')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^(Reject|Approve) / })).not.toBeInTheDocument()
  })
})

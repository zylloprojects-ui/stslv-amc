import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ACTIONS, MODULES, type PermissionSection, type Role, type SessionUser, type User } from '../lib/types'
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
    if (request.method === 'POST' && request.path === '/users/2/temporary-password') return onReset()
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
    expect(screen.getByRole('button', { name: 'Change role of Asha Admin' })).toBeDisabled()
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
    // No role chosen: refused before anything is sent.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create user' }))
    expect(await within(dialog).findByText('Select exactly one role.')).toBeInTheDocument()
    expect(api.find('POST', '/users')).toHaveLength(0)

    // One role, chosen with a radio button: picking another replaces it.
    await userEvent.click(within(dialog).getByRole('radio', { name: /Admin/ }))
    await userEvent.click(within(dialog).getByRole('radio', { name: /Accountant/ }))
    expect(within(dialog).getByRole('radio', { name: /Admin/ })).not.toBeChecked()
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument()
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

  describe('temporary password', () => {
    const TEMPORARY = 'Kp7r-Xw2m-Tq9a-Hd4e'
    const ISSUED = { temporaryPassword: TEMPORARY, expiresAt: '2026-10-29T10:15:00.000Z' }

    const issueApi = (onIssue?: ResetReply) => usersApi(ADMIN, onIssue ?? (() => ok(ISSUED)))

    async function openDialog() {
      renderApp('/admin/users')
      await userEvent.click(await screen.findByRole('button', { name: 'Generate temporary password for Arun Accountant' }))

      return screen.findByRole('dialog', { name: 'Generate temporary password' })
    }

    it('names the user and requires the identity check before anything is sent', async () => {
      const api = issueApi()
      const dialog = await openDialog()

      expect(dialog).toHaveTextContent('Arun Accountant')
      expect(dialog).toHaveTextContent('accountant@example.com')
      expect(dialog).toHaveTextContent('It works for 15 minutes')

      const generate = within(dialog).getByRole('button', { name: 'Generate temporary password' })

      expect(generate).toBeDisabled()
      await userEvent.click(within(dialog).getByRole('checkbox', { name: /I have verified that the person asking is Arun Accountant/ }))
      expect(generate).toBeEnabled()
      expect(api.requests.filter((request) => request.method !== 'GET')).toHaveLength(0)
    })

    it('changes nothing when cancelled', async () => {
      const api = issueApi()
      const dialog = await openDialog()

      await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(api.requests.filter((request) => request.method !== 'GET')).toHaveLength(0)
    })

    it('issues it once, shows it once with Copy, and forgets it when closed', async () => {
      let release: (reply: MockReply) => void = () => {}
      const api = issueApi(
        () =>
          new Promise<MockReply>((resolve) => {
            release = resolve
          }),
      )
      const writeText = vi.fn(async () => {})
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
      const dialog = await openDialog()

      await userEvent.click(within(dialog).getByRole('checkbox'))
      await userEvent.click(within(dialog).getByRole('button', { name: 'Generate temporary password' }))

      await waitFor(() => expect(api.find('POST', '/users/2/temporary-password')).toHaveLength(1))
      expect(api.find('POST', '/users/2/temporary-password')[0]?.body).toEqual({ identityVerified: true })
      expect(screen.queryByText(TEMPORARY)).not.toBeInTheDocument()

      release(ok(ISSUED))

      const shown = await screen.findByRole('dialog', { name: 'Temporary password issued' })

      expect(within(shown).getByLabelText('Temporary password')).toHaveTextContent(TEMPORARY)
      expect(shown).toHaveTextContent('It is shown only now')
      await userEvent.click(within(shown).getByRole('button', { name: 'Copy' }))
      expect(writeText).toHaveBeenCalledWith(TEMPORARY)
      expect(await within(shown).findByRole('button', { name: 'Copied' })).toBeInTheDocument()

      await userEvent.click(within(shown).getByRole('button', { name: 'Done' }))

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(screen.getByRole('status')).toHaveTextContent(
        'A temporary password was issued for Arun Accountant. They have been signed out and must change it at sign-in.',
      )
      // Gone from the page once the dialog is closed.
      expect(document.body).not.toHaveTextContent(TEMPORARY)
      // The administrator stays signed in, on the same page.
      expect(localStorage.getItem('stslv-amc.token')).not.toBeNull()
      expect(api.find('POST', '/users/2/temporary-password')).toHaveLength(1)
    })

    it('shows a refusal and lets the administrator retry', async () => {
      let failing = true
      const api = issueApi(() => (failing ? fail(403, 'FORBIDDEN', 'You cannot manage a user who holds permissions you do not hold.') : ok(ISSUED)))
      const dialog = await openDialog()

      await userEvent.click(within(dialog).getByRole('checkbox'))
      await userEvent.click(within(dialog).getByRole('button', { name: 'Generate temporary password' }))

      expect(await within(dialog).findByRole('alert')).toHaveTextContent('You cannot manage a user who holds permissions you do not hold.')

      failing = false
      await userEvent.click(within(dialog).getByRole('button', { name: 'Generate temporary password' }))

      expect(await screen.findByRole('dialog', { name: 'Temporary password issued' })).toBeInTheDocument()
      expect(api.find('POST', '/users/2/temporary-password')).toHaveLength(2)
    })

    it('is not offered for your own account, and only to Admins', async () => {
      usersApi()
      const view = renderApp('/admin/users')

      expect(await screen.findByRole('button', { name: 'Generate temporary password for Asha Admin' })).toBeDisabled()
      view.unmount()

      // A non-Admin role holding user editing does not see the action at all.
      usersApi({ ...ADMIN, roles: [{ id: '9', code: 'USER_EDITOR', name: 'User editor' }] })
      renderApp('/admin/users')

      expect(await screen.findByRole('button', { name: 'Change roles of Arun Accountant' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Generate temporary password/ })).not.toBeInTheDocument()
    })

    it('shows an outstanding temporary password in the user list', async () => {
      const future = new Date(Date.now() + 10 * 60_000).toISOString()

      USERS[1] = { ...(USERS[1] as User), temporaryCredentialExpiresAt: future }
      try {
        usersApi()
        renderApp('/admin/users')

        expect(await screen.findByText(/Temporary password · expires/)).toBeInTheDocument()
      } finally {
        USERS[1] = { ...(USERS[1] as User), temporaryCredentialExpiresAt: null }
      }
    })
  })

  it('replaces the current role with the one chosen', async () => {
    const api = usersApi()
    renderApp('/admin/users')

    await userEvent.click(await screen.findByRole('button', { name: 'Change role of Arun Accountant' }))
    const dialog = await screen.findByRole('dialog', { name: 'Role for Arun Accountant' })

    expect(within(dialog).getByText('Accountant', { selector: 'strong' })).toBeInTheDocument()
    expect(within(dialog).getByRole('radio', { name: /Accountant/ })).toBeChecked()
    // Unchanged: nothing to save.
    expect(within(dialog).getByRole('button', { name: 'Save role' })).toBeDisabled()
    await userEvent.click(within(dialog).getByRole('radio', { name: /Admin/ }))
    expect(within(dialog).getByRole('radio', { name: /Accountant/ })).not.toBeChecked()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save role' }))

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

  function pendingApi(user: SessionUser = ADMIN, options: { pending?: Partial<User>; activate?: () => MockReply } = {}) {
    const users: User[] = [...USERS.map((entry) => ({ ...entry })), { ...PENDING, ...options.pending }]

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
        if (options.activate) return options.activate()
        users[2] ={ ...(users[2] as User), isActive: true, approvalStatus: 'APPROVED' }
        return ok(users[2])
      }
      return undefined
    })
  }

  it('marks a self-registered account as pending, with Approve disabled until it has a role', async () => {
    pendingApi()
    renderApp('/admin/users')

    const table = await screen.findByRole('table', { name: 'Users' })
    const row = within(table).getByRole('row', { name: /Nadia Newcomer/ })

    expect(within(row).getByText('Pending approval')).toBeInTheDocument()
    expect(within(row).getByText('No role')).toBeInTheDocument()
    expect(within(row).queryByText('Inactive')).not.toBeInTheDocument()
    expect(within(row).getByRole('button', { name: 'Approve Nadia Newcomer' })).toBeDisabled()
    expect(within(row).getByRole('button', { name: 'Approve Nadia Newcomer' })).toHaveAttribute('title', 'Assign a role before approving this user.')
    expect(within(row).getByText('Assign a role before approving this user.')).toBeInTheDocument()
    // Reject and Change roles stay available.
    expect(within(row).getByRole('button', { name: 'Reject Nadia Newcomer' })).toBeEnabled()
    expect(within(row).getByRole('button', { name: 'Change role of Nadia Newcomer' })).toBeEnabled()
    expect(screen.getByRole('status')).toHaveTextContent('1 sign-up request is waiting for approval. A pending account cannot sign in. Assign a role, then approve it.')
  })

  it('shows no pending notice when nobody is waiting', async () => {
    usersApi()
    renderApp('/admin/users')

    await screen.findByRole('table', { name: 'Users' })

    expect(screen.queryByText(/waiting for approval/)).not.toBeInTheDocument()
    expect(screen.queryByText('Pending approval')).not.toBeInTheDocument()
  })

  it('does not approve an account that has no role', async () => {
    const api = pendingApi()
    renderApp('/admin/users')

    await userEvent.click(await screen.findByRole('button', { name: 'Approve Nadia Newcomer' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(api.find('POST', '/users/7/activate')).toHaveLength(0)
  })

  it('shows the API refusal when an approval is still rejected for want of a role', async () => {
    pendingApi(ADMIN, {
      pending: { roles: [{ id: '2', code: 'ACCOUNTANT', name: 'Accountant' }] },
      activate: () =>
        fail(409, 'CONFLICT', 'Assign a role before approving this user.', [{ field: 'roleIds', message: 'Assign a role before approving this user.' }]),
    })
    renderApp('/admin/users')

    await userEvent.click(await screen.findByRole('button', { name: 'Approve Nadia Newcomer' }))
    const dialog = await screen.findByRole('dialog', { name: 'Approve sign-up request' })

    expect(dialog).toHaveTextContent('new.person@example.com')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve' }))

    expect(await within(dialog).findByText('Assign a role before approving this user.')).toBeInTheDocument()
    expect(within(screen.getByRole('row', { name: /Nadia Newcomer/ })).getByText('Pending approval')).toBeInTheDocument()
  })

  it('lets an administrator assign a role and then approve the request', async () => {
    const api = pendingApi()
    renderApp('/admin/users')

    await userEvent.click(await screen.findByRole('button', { name: 'Change role of Nadia Newcomer' }))
    const roles = await screen.findByRole('dialog', { name: 'Role for Nadia Newcomer' })
    await userEvent.click(within(roles).getByRole('radio', { name: /Accountant/ }))
    await userEvent.click(within(roles).getByRole('button', { name: 'Save role' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('PUT', '/users/7/roles')[0]?.body).toEqual({ roleIds: ['2'] })

    // Still pending: a role alone does not open the account.
    const row = screen.getByRole('row', { name: /Nadia Newcomer/ })
    await waitFor(() => expect(within(row).getByText('Accountant')).toBeInTheDocument())
    expect(within(row).getByText('Pending approval')).toBeInTheDocument()
    // With a role assigned, Approve becomes available and the hint goes away.
    expect(within(row).getByRole('button', { name: 'Approve Nadia Newcomer' })).toBeEnabled()
    expect(within(row).queryByText('Assign a role before approving this user.')).not.toBeInTheDocument()

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

  it('marks several roles from before the rule and keeps Approve disabled until one is chosen', async () => {
    const api = pendingApi(ADMIN, { pending: { roles: [{ id: '1', code: 'ADMIN', name: 'Admin' }, { id: '2', code: 'ACCOUNTANT', name: 'Accountant' }] } })
    renderApp('/admin/users')

    const row = within(await screen.findByRole('table', { name: 'Users' })).getByRole('row', { name: /Nadia Newcomer/ })
    expect(within(row).getByText('Several roles: choose one')).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: 'Approve Nadia Newcomer' })).toBeDisabled()
    expect(within(row).getByText('This user has more than one role. Choose one role before approving.')).toBeInTheDocument()

    await userEvent.click(within(row).getByRole('button', { name: 'Change role of Nadia Newcomer' }))
    const dialog = await screen.findByRole('dialog', { name: 'Role for Nadia Newcomer' })
    expect(within(dialog).getByText(/holds 2 roles from before the one-role rule/)).toBeInTheDocument()
    // Nothing preselected: an administrator chooses.
    expect(within(dialog).getByRole('button', { name: 'Save role' })).toBeDisabled()
    await userEvent.click(within(dialog).getByRole('radio', { name: /Accountant/ }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save role' }))
    await waitFor(() => expect(api.find('PUT', '/users/7/roles')[0]?.body).toEqual({ roleIds: ['2'] }))
  })

  it('offers approving and rejecting only with Users: Approve, and keeps role and account changes on Users: Edit', async () => {
    // Edit without Approve: roles can be prepared, the request cannot be decided.
    pendingApi({ ...ADMIN, permissions: ['USERS:VIEW', 'USERS:EDIT'] }, { pending: { roles: [{ id: '2', code: 'ACCOUNTANT', name: 'Accountant' }] } })
    const { unmount } = renderApp('/admin/users')
    let row = within(await screen.findByRole('table', { name: 'Users' })).getByRole('row', { name: /Nadia Newcomer/ })

    expect(within(row).getByRole('button', { name: 'Change role of Nadia Newcomer' })).toBeEnabled()
    expect(within(row).queryByRole('button', { name: 'Approve Nadia Newcomer' })).not.toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: 'Reject Nadia Newcomer' })).not.toBeInTheDocument()
    unmount()

    // Approve without Edit: the request can be decided, nothing else changed.
    pendingApi({ ...ADMIN, permissions: ['USERS:VIEW', 'USERS:APPROVE'] }, { pending: { roles: [{ id: '2', code: 'ACCOUNTANT', name: 'Accountant' }] } })
    renderApp('/admin/users')
    row = within(await screen.findByRole('table', { name: 'Users' })).getByRole('row', { name: /Nadia Newcomer/ })

    expect(within(row).getByRole('button', { name: 'Approve Nadia Newcomer' })).toBeEnabled()
    expect(within(row).getByRole('button', { name: 'Reject Nadia Newcomer' })).toBeEnabled()
    expect(within(row).queryByRole('button', { name: 'Change role of Nadia Newcomer' })).not.toBeInTheDocument()
    const arun = within(screen.getByRole('table', { name: 'Users' })).getByRole('row', { name: /Arun Accountant/ })
    expect(within(arun).queryByRole('button', { name: 'Deactivate Arun Accountant' })).not.toBeInTheDocument()
    expect(within(arun).queryByRole('button', { name: 'Generate temporary password for Arun Accountant' })).not.toBeInTheDocument()
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
  it('opens straight on the permissions from the Roles & Permissions link in the sidebar', async () => {
    usersApi()
    renderApp('/admin/roles')

    expect(await screen.findByRole('heading', { name: 'Roles & Permissions' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Roles & Permissions' })).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByRole('checkbox', { name: 'Clients: Edit' })).toBeChecked()
  })

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

describe('roles and permissions drawn from the permission catalog', () => {
  // A part of the API's catalog (shared/permission-catalog.ts): the shapes that matter here.
  const CATALOG: PermissionSection[] = [
    { title: 'Dashboard', modules: [{ module: 'DASHBOARD', label: 'Dashboard', description: '', pages: [{ label: 'Dashboard', path: '/dashboard' }], actions: { VIEW: 'Open the Dashboard' } }] },
    {
      title: 'AMC Operations',
      modules: [
        {
          module: 'AMC_CONTRACTS',
          label: 'AMC Contracts',
          description: 'Contracts and renewals.',
          pages: [
            { label: 'AMC Contracts', path: '/amc/contracts' },
            { label: 'AMC Renewal', path: '/amc/renewal' },
          ],
          actions: { VIEW: 'See contracts', CREATE: 'Add and renew contracts', EDIT: 'Edit contracts', DELETE: 'Cancel contracts (nothing is deleted; also needs Edit)', EXPORT: 'Export renewals' },
        },
      ],
    },
    {
      title: 'Retired modules',
      retired: true,
      modules: [
        { module: 'EXPENSES', label: 'Expenses', description: 'No page.', pages: [], actions: { VIEW: 'Read', CREATE: 'Add', EDIT: 'Edit', DELETE: 'Void' } },
        { module: 'REPORTS', label: 'Reports', description: 'Not checked anywhere.', pages: [], actions: {} },
      ],
    },
  ]
  const ACCOUNTANT: Role = {
    ...(ROLES[1] as Role),
    permissions: [
      { module: 'AMC_CONTRACTS', action: 'VIEW' },
      { module: 'EXPENSES', action: 'CREATE' },
      { module: 'REPORTS', action: 'VIEW' },
    ],
  }

  // Stateful, as the API is: a saved permission set is what the roles list returns next.
  function catalogApi() {
    let accountant = ACCOUNTANT

    signIn()

    return mockApi((request) => {
      if (request.path === '/auth/me') return ok({ user: ADMIN })
      if (request.method === 'GET' && request.path === '/users') return ok(USERS)
      if (request.method === 'GET' && request.path === '/roles') {
        return ok({
          roles: [ROLES[0], accountant],
          modules: MODULES,
          actions: ACTIONS,
          catalog: CATALOG,
          fixedAccess: { adminOnly: [{ label: 'Audit Log', path: '/admin/audit-log' }], everyone: [{ label: 'My account', path: '/account' }] },
        })
      }
      if (request.method === 'PUT' && request.path === '/roles/2/permissions') {
        accountant = { ...accountant, permissions: (request.body as { permissions: Role['permissions'] }).permissions }
        return ok(accountant)
      }
      return undefined
    })
  }

  async function openAccountant() {
    renderApp('/admin/roles')
    await userEvent.click(await screen.findByRole('button', { name: 'Accountant' }))
    await screen.findByRole('checkbox', { name: 'AMC Contracts: View' })
  }

  it('offers only the actions a module uses, with the pages it governs and what each action allows', async () => {
    catalogApi()
    await openAccountant()

    expect(screen.getByRole('checkbox', { name: 'Dashboard: View' })).toBeEnabled()
    expect(screen.queryByRole('checkbox', { name: 'Dashboard: Create' })).not.toBeInTheDocument()
    expect(screen.getByText('Dashboard: Create is not used')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'AMC Contracts: Approve' })).not.toBeInTheDocument()
    expect(screen.getByText('AMC Renewal')).toBeInTheDocument()
    expect(screen.getByText('Cancel contracts (nothing is deleted; also needs Edit)')).toBeInTheDocument()
    expect(screen.getByText(/Admin role only:/).parentElement).toHaveTextContent('Audit Log')
  })

  it('confirms a save after the roles list reloads with the new permissions, and keeps them ticked', async () => {
    catalogApi()
    await openAccountant()

    await userEvent.click(screen.getByRole('checkbox', { name: 'AMC Contracts: Export' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save permissions' }))

    expect(await screen.findByText('Permissions saved. They apply immediately.')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'AMC Contracts: Export' })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Save permissions' })).toBeDisabled()

    // A further change hides the confirmation until it is saved too.
    await userEvent.click(screen.getByRole('checkbox', { name: 'AMC Contracts: Edit' }))
    expect(screen.queryByText('Permissions saved. They apply immediately.')).not.toBeInTheDocument()
  })

  it('keeps grants on retired modules, lets them be removed, and grants nothing new there', async () => {
    const api = catalogApi()
    await openAccountant()

    expect(screen.getByText(/this role holds 2 grants, kept unchanged/)).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Expenses: Create' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Expenses: Create' })).toBeEnabled()
    expect(screen.getByRole('checkbox', { name: 'Expenses: View' })).toBeDisabled()
    // REPORTS uses no action: the grant is shown as having no effect, and can only be removed.
    expect(screen.getByRole('checkbox', { name: 'Reports: View (not used)' })).toBeChecked()
    expect(screen.queryByRole('button', { name: 'Grant all permissions for Expenses' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('checkbox', { name: 'Reports: View (not used)' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save permissions' }))

    await waitFor(() => expect(api.find('PUT', '/roles/2/permissions')).toHaveLength(1))
    expect(api.find('PUT', '/roles/2/permissions')[0]?.body).toEqual({
      permissions: [
        { module: 'AMC_CONTRACTS', action: 'VIEW' },
        { module: 'EXPENSES', action: 'CREATE' },
      ],
    })
  })

  it('grants a whole module with only the actions it uses, and keeps every other grant', async () => {
    const api = catalogApi()
    await openAccountant()

    await userEvent.click(screen.getByRole('button', { name: 'Grant all permissions for AMC Contracts' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save permissions' }))

    await waitFor(() => expect(api.find('PUT', '/roles/2/permissions')).toHaveLength(1))
    const sent = (api.find('PUT', '/roles/2/permissions')[0]?.body as { permissions: Role['permissions'] } | undefined)?.permissions ?? []

    expect(sent).toHaveLength(7)
    expect(sent).toEqual(
      expect.arrayContaining([
        { module: 'AMC_CONTRACTS', action: 'DELETE' },
        { module: 'AMC_CONTRACTS', action: 'EXPORT' },
        { module: 'EXPENSES', action: 'CREATE' },
        { module: 'REPORTS', action: 'VIEW' },
      ]),
    )
    expect(sent).not.toContainEqual({ module: 'AMC_CONTRACTS', action: 'APPROVE' })
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
    // Pending: roles and reject; approve is shown but waits for a role.
    for (const action of ['Change role of Nadia Newcomer', 'Reject Nadia Newcomer']) {
      expect(within(row('Nadia Newcomer')).getByRole('button', { name: action })).toBeEnabled()
    }
    expect(within(row('Nadia Newcomer')).getByRole('button', { name: 'Approve Nadia Newcomer' })).toBeDisabled()
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

import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ACTIONS, MODULES, type PermissionSection, type Role, type SessionUser, type User } from '../lib/types'
import { ADMIN, fail, mockApi, ok, renderApp, signIn, type MockReply, type MockRequest } from './helpers'

// The six-role model (approved 2026-10-29): role tabs, scopes, dependencies, unsaved changes,
// and Admin's limits towards Super Admin and Admin accounts. The API enforces the same rules.

const CATALOG: PermissionSection[] = [
  { title: 'Dashboard', modules: [{ module: 'DASHBOARD', label: 'Dashboard', description: '', pages: [], actions: { VIEW: 'Open the Dashboard' } }] },
  {
    title: 'Master Data Center',
    modules: [{ module: 'CLIENTS', label: 'Clients', description: '', pages: [], actions: { VIEW: 'See', CREATE: 'Add', EDIT: 'Edit', DELETE: 'Deactivate', EXPORT: 'Export', READ: 'Data only: client pickers' } }],
  },
  {
    title: 'AMC Operations',
    modules: [
      { module: 'AMC_CONTRACTS', label: 'AMC Contracts', description: '', pages: [], actions: { VIEW: 'See', CREATE: 'Add', EDIT: 'Edit', DELETE: 'Cancel', EXPORT: 'Export' } },
      { module: 'AMC_SCHEDULE', label: 'AMC Schedule', description: '', pages: [], actions: { VIEW: 'See', EDIT: 'Edit', EXPORT: 'Export', READ: 'Data only: visit details in Accounts' } },
    ],
  },
  { title: 'Finance', modules: [{ module: 'INVOICES', label: 'Invoice Tracking', description: '', pages: [], actions: { VIEW: 'See', CREATE: 'Record', EDIT: 'Edit', EXPORT: 'Export', READ: 'Data only: invoice numbers on AMC pages' } }] },
  { title: 'Administration', modules: [{ module: 'USERS', label: 'Users & Access', description: '', pages: [], actions: { VIEW: 'See', EDIT: 'Edit' } }] },
]

const everything = MODULES.flatMap((module) => ACTIONS.map((action) => ({ module, action })))

function role(id: string, code: string, name: string, extra: Partial<Role> = {}): Role {
  return { id, code, name, description: null, isActive: true, userCount: 0, permissions: [], permissionsEditable: true, lockedReason: null, scope: null, assignable: true, ...extra }
}

const SUPER = role('1', 'ADMIN', 'Super Admin', { permissions: everything, permissionsEditable: false, lockedReason: 'Super Admin always has full access. Its permissions cannot be changed.', assignable: false, userCount: 1 })
const ADMIN_ROLE = role('6', 'ADMINISTRATOR', 'Admin', { permissions: everything.filter((p) => p.module !== 'REPORTS') })
const FINANCE = role('7', 'FINANCE_EXECUTIVE', 'Finance Executive', {
  scope: ['DASHBOARD:VIEW', 'INVOICES:VIEW', 'INVOICES:CREATE', 'INVOICES:EDIT', 'INVOICES:EXPORT', 'AMC_SCHEDULE:READ'],
  permissionsVersion: 'f1f1f1f1f1f1f1f1',
  permissions: [
    { module: 'DASHBOARD', action: 'VIEW' },
    { module: 'INVOICES', action: 'VIEW' },
    { module: 'AMC_SCHEDULE', action: 'READ' },
  ],
})
const OPERATIONS = role('9', 'AMC_OPERATIONS_EXECUTIVE', 'AMC Operations Executive', { permissions: [{ module: 'DASHBOARD', action: 'VIEW' }] })
const LEGACY = role('2', 'ACCOUNTANT', 'Accountant', { isActive: false, assignable: false })

const ROLES = [SUPER, LEGACY, ADMIN_ROLE, FINANCE, OPERATIONS]

const ADMIN_USER: SessionUser = {
  ...ADMIN,
  id: '20',
  email: 'office-admin@example.com',
  fullName: 'Olu Office',
  roles: [{ id: '6', code: 'ADMINISTRATOR', name: 'Admin' }],
}

const user = (id: string, fullName: string, roles: User['roles']): User => ({
  id,
  email: `${id}@example.com`,
  fullName,
  isActive: true,
  approvalStatus: 'APPROVED',
  lastLoginAt: null,
  createdAt: '2026-10-01T07:00:00.000Z',
  roles,
})

const USERS = [
  user('1', 'Sam Super', [{ id: '1', code: 'ADMIN', name: 'Super Admin' }]),
  user('20', 'Olu Office', [{ id: '6', code: 'ADMINISTRATOR', name: 'Admin' }]),
  user('30', 'Fay Finance', [{ id: '7', code: 'FINANCE_EXECUTIVE', name: 'Finance Executive' }]),
]

function rolesApi(session: SessionUser = ADMIN, roles: Role[] = ROLES, onPut?: (request: MockRequest) => MockReply | undefined) {
  signIn()

  return mockApi((request) => {
    if (onPut && request.method === 'PUT') {
      const reply = onPut(request)
      if (reply) return reply
    }
    if (request.path === '/auth/me') return ok({ user: session })
    if (request.method === 'GET' && request.path === '/users') return ok(USERS)
    if (request.method === 'GET' && request.path === '/roles') {
      return ok({ roles, modules: MODULES, actions: ACTIONS, catalog: CATALOG, fixedAccess: { adminOnly: [], everyone: [] } })
    }
    if (request.method === 'PUT' && request.path.startsWith('/roles/')) {
      const id = request.path.split('/')[2]
      const found = roles.find((candidate) => candidate.id === id) as Role
      return ok({ ...found, permissions: (request.body as { permissions: Role['permissions'] }).permissions })
    }
    return undefined
  })
}

async function open(name: string) {
  renderApp('/admin/roles')
  await userEvent.click(await screen.findByRole('tab', { name }))
  return screen.findByRole('heading', { level: 3, name: new RegExp(`^${name}`) })
}

describe('role tabs', () => {
  it('lists the active roles as tabs and the inactive ones apart', async () => {
    rolesApi()
    renderApp('/admin/roles')

    const tablist = await screen.findByRole('tablist', { name: 'Roles' })
    expect(within(tablist).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Super Admin', 'Admin', 'Finance Executive', 'AMC Operations Executive'])
    expect(screen.getByText('Inactive roles (1)')).toBeInTheDocument()
    expect(within(tablist).queryByRole('tab', { name: 'Accountant' })).not.toBeInTheDocument()
  })

  it('moves between roles with the arrow keys', async () => {
    rolesApi()
    renderApp('/admin/roles')

    const first = await screen.findByRole('tab', { name: 'Super Admin' })
    first.focus()
    await userEvent.keyboard('{ArrowRight}')

    expect(screen.getByRole('tab', { name: 'Admin' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Admin' })).toHaveFocus()
    await userEvent.keyboard('{End}')
    expect(screen.getByRole('tab', { name: 'AMC Operations Executive' })).toHaveAttribute('aria-selected', 'true')
  })

  it('shows Super Admin as fixed full access', async () => {
    rolesApi()
    renderApp('/admin/roles')

    expect(await screen.findByText('Super Admin always has full access. Its permissions cannot be changed.')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Clients: Delete' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Clients: Delete' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save permissions' })).not.toBeInTheDocument()
  })
})

describe('a role limited to its section', () => {
  it('shows only the permissions the role may hold', async () => {
    rolesApi()
    await open('Finance Executive')

    expect(screen.getByText('Finance Executive is limited to its part of the application. Only the permissions it may hold are shown.')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Invoice Tracking: Create' })).toBeEnabled()
    expect(screen.getByRole('checkbox', { name: 'AMC Schedule: Data read' })).toBeEnabled()
    expect(screen.queryByRole('checkbox', { name: 'AMC Schedule: View' })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'AMC Schedule: Edit' })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /^Clients:/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('table', { name: /Master Data Center/ })).not.toBeInTheDocument()
  })
})

describe('permission dependencies', () => {
  it('ticks View with any other action, and clears what depends on View when it is cleared', async () => {
    rolesApi()
    await open('AMC Operations Executive')

    await userEvent.click(screen.getByRole('checkbox', { name: 'Clients: Edit' }))
    expect(screen.getByRole('checkbox', { name: 'Clients: View' })).toBeChecked()

    await userEvent.click(screen.getByRole('checkbox', { name: 'Clients: View' }))
    expect(screen.getByRole('checkbox', { name: 'Clients: Edit' })).not.toBeChecked()
  })

  it('ticks Edit and View with cancelling contracts, and clears it with Edit', async () => {
    rolesApi()
    await open('AMC Operations Executive')

    await userEvent.click(screen.getByRole('checkbox', { name: 'AMC Contracts: Delete' }))
    expect(screen.getByRole('checkbox', { name: 'AMC Contracts: Edit' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'AMC Contracts: View' })).toBeChecked()

    await userEvent.click(screen.getByRole('checkbox', { name: 'AMC Contracts: Edit' }))
    expect(screen.getByRole('checkbox', { name: 'AMC Contracts: Delete' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'AMC Contracts: View' })).toBeChecked()
  })

  it('says what each action needs', async () => {
    rolesApi()
    await open('AMC Operations Executive')

    expect(screen.getAllByText('Needs View and Edit.').length).toBeGreaterThan(0)
  })
})

describe('select all, clear all, cancel and save', () => {
  it('selects and clears every permission the role may hold, and saves a consistent set', async () => {
    const api = rolesApi()
    await open('Finance Executive')

    await userEvent.click(screen.getByRole('button', { name: 'Select all' }))
    expect(screen.getByRole('checkbox', { name: 'Invoice Tracking: Export' })).toBeChecked()
    expect(screen.getByRole('heading', { level: 3, name: /Finance Executive/ })).toHaveTextContent('Full')

    await userEvent.click(screen.getByRole('button', { name: 'Clear all' }))
    expect(screen.getByRole('checkbox', { name: 'Invoice Tracking: View' })).not.toBeChecked()

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('checkbox', { name: 'Invoice Tracking: View' })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Save permissions' })).toBeDisabled()

    await userEvent.click(screen.getByRole('checkbox', { name: 'Invoice Tracking: Create' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save permissions' }))

    await waitFor(() => expect(api.find('PUT', '/roles/7/permissions')).toHaveLength(1))
    expect(api.find('PUT', '/roles/7/permissions')[0]?.body).toMatchObject({
      permissions: expect.arrayContaining([
        { module: 'INVOICES', action: 'VIEW' },
        { module: 'INVOICES', action: 'CREATE' },
      ]),
    })
  })
})

describe('unsaved changes', () => {
  it('asks before another role replaces unsaved changes', async () => {
    rolesApi()
    await open('Finance Executive')

    await userEvent.click(screen.getByRole('checkbox', { name: 'Invoice Tracking: Export' }))
    expect(screen.getByText(/You have unsaved changes/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('tab', { name: 'Admin' }))
    const dialog = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' })

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('tab', { name: 'Finance Executive' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('checkbox', { name: 'Invoice Tracking: Export' })).toBeChecked()

    await userEvent.click(screen.getByRole('tab', { name: 'Admin' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Discard changes' }))
    expect(screen.getByRole('tab', { name: 'Admin' })).toHaveAttribute('aria-selected', 'true')
  })

  it('asks before the Users tab replaces unsaved changes', async () => {
    rolesApi()
    await open('Finance Executive')

    await userEvent.click(screen.getByRole('checkbox', { name: 'Invoice Tracking: Export' }))
    await userEvent.click(screen.getByRole('tab', { name: 'Users' }))

    expect(await screen.findByRole('dialog', { name: 'Discard unsaved changes?' })).toBeInTheDocument()
  })
})

describe('Admin and the privileged roles', () => {
  // As the API answers Admin: no role's permissions are editable; the privileged roles are not assignable.
  const asAdmin = ROLES.map((candidate) =>
    candidate.code === 'ADMIN'
      ? candidate
      : {
          ...candidate,
          permissionsEditable: false,
          lockedReason: 'Only Super Admin can change role permissions.',
          assignable: candidate.code === 'ADMINISTRATOR' ? false : candidate.assignable,
        },
  )

  it('cannot change any role’s permissions, not even an Executive role’s', async () => {
    rolesApi(ADMIN_USER, asAdmin)

    for (const name of ['Admin', 'Finance Executive', 'AMC Operations Executive']) {
      if (name === 'Admin') {
        await open(name)
      } else {
        await userEvent.click(screen.getByRole('tab', { name }))
      }
      expect(await screen.findByText('Only Super Admin can change role permissions.')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Save permissions' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Select all' })).not.toBeInTheDocument()
      for (const box of screen.getAllByRole('checkbox')) expect(box).toBeDisabled()
    }
  })

  it('cannot manage Super Admin or Admin accounts, and is not offered those roles', async () => {
    rolesApi(ADMIN_USER, asAdmin)
    renderApp('/admin/users')

    const button = await screen.findByRole('button', { name: 'Change role of Sam Super' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'Only Super Admin can manage Super Admin and Admin accounts.')
    expect(screen.getByRole('button', { name: 'Deactivate Sam Super' })).toBeDisabled()

    await userEvent.click(screen.getByRole('button', { name: 'Change role of Fay Finance' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('radio', { name: /Finance Executive/ })).toBeChecked()
    expect(within(dialog).getByRole('radio', { name: /AMC Operations Executive/ })).toBeEnabled()
    expect(within(dialog).queryByRole('radio', { name: /^Super Admin/ })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('radio', { name: /^Admin/ })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('radio', { name: /Accountant/ })).not.toBeInTheDocument()
  })
})

describe('data-only read in the matrix', () => {
  it('offers Read as its own checkbox, not a column', async () => {
    rolesApi()
    await open('Finance Executive')

    expect(screen.getByRole('checkbox', { name: 'AMC Schedule: Data read' })).toBeChecked()
    expect(screen.queryByRole('checkbox', { name: 'AMC Schedule: View' })).not.toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: 'Data read' })).not.toBeInTheDocument()
    // Invoices has View, so its Read is not offered (View covers it).
    expect(screen.queryByRole('checkbox', { name: 'Invoice Tracking: Data read' })).not.toBeInTheDocument()
  })

  it('sends the version the edit started from', async () => {
    const api = rolesApi()
    await open('Finance Executive')

    await userEvent.click(screen.getByRole('checkbox', { name: 'Invoice Tracking: Export' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save permissions' }))

    await waitFor(() => expect(api.find('PUT', '/roles/7/permissions')).toHaveLength(1))
    expect(api.find('PUT', '/roles/7/permissions')[0]?.body).toMatchObject({ expectedVersion: 'f1f1f1f1f1f1f1f1' })
  })
})

describe('concurrent permission changes', () => {
  it('reports a save refused because someone else changed the role, and keeps the unsaved edit', async () => {
    rolesApi(ADMIN, ROLES, () => fail(409, 'CONFLICT', 'These permissions were changed by someone else since you opened them.'))
    await open('Finance Executive')

    await userEvent.click(screen.getByRole('checkbox', { name: 'Invoice Tracking: Export' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save permissions' }))

    expect(await screen.findByText(/Not saved: someone else changed these permissions/)).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Invoice Tracking: Export' })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Load the latest permissions' })).toBeInTheDocument()
  })

  it('keeps unsaved edits when a newer saved version arrives, then loads it on request', async () => {
    let roles: Role[] = ROLES
    signIn()
    mockApi((request) => {
      if (request.path === '/auth/me') return ok({ user: ADMIN })
      if (request.method === 'GET' && request.path === '/users') return ok(USERS)
      if (request.method === 'GET' && request.path === '/roles') return ok({ roles, modules: MODULES, actions: ACTIONS, catalog: CATALOG, fixedAccess: { adminOnly: [], everyone: [] } })
      return undefined
    })
    const { queryClient } = renderApp('/admin/roles')
    await userEvent.click(await screen.findByRole('tab', { name: 'Finance Executive' }))
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Invoice Tracking: Export' }))

    // Another administrator saves; the roles list is refreshed in the background.
    roles = ROLES.map((candidate) =>
      candidate.id === FINANCE.id ? { ...FINANCE, permissionsVersion: 'b3b3b3b3b3b3b3b3', permissions: [...FINANCE.permissions, { module: 'INVOICES', action: 'EDIT' }] } : candidate,
    )
    await queryClient.invalidateQueries({ queryKey: ['roles'] })

    expect(await screen.findByText(/Someone else saved changes to these permissions/)).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Invoice Tracking: Export' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Invoice Tracking: Edit' })).not.toBeChecked()

    await userEvent.click(screen.getByRole('button', { name: 'Load the latest permissions' }))
    expect(screen.getByRole('checkbox', { name: 'Invoice Tracking: Edit' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Invoice Tracking: Export' })).not.toBeChecked()
  })

  it('shows a newer saved version straight away when nothing is unsaved', async () => {
    let roles: Role[] = ROLES
    signIn()
    mockApi((request) => {
      if (request.path === '/auth/me') return ok({ user: ADMIN })
      if (request.method === 'GET' && request.path === '/roles') return ok({ roles, modules: MODULES, actions: ACTIONS, catalog: CATALOG, fixedAccess: { adminOnly: [], everyone: [] } })
      return undefined
    })
    const { queryClient } = renderApp('/admin/roles')
    await userEvent.click(await screen.findByRole('tab', { name: 'Finance Executive' }))
    expect(await screen.findByRole('checkbox', { name: 'Invoice Tracking: Edit' })).not.toBeChecked()

    roles = ROLES.map((candidate) =>
      candidate.id === FINANCE.id ? { ...FINANCE, permissionsVersion: 'c4c4c4c4c4c4c4c4', permissions: [...FINANCE.permissions, { module: 'INVOICES', action: 'EDIT' }] } : candidate,
    )
    await queryClient.invalidateQueries({ queryKey: ['roles'] })

    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Invoice Tracking: Edit' })).toBeChecked())
    expect(screen.queryByText(/Someone else saved changes/)).not.toBeInTheDocument()
  })
})

describe('unsaved changes and every way out', () => {
  async function dirtyFinance() {
    rolesApi()
    const view = renderApp('/admin/roles')
    await userEvent.click(await screen.findByRole('tab', { name: 'Finance Executive' }))
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Invoice Tracking: Export' }))
    return view
  }

  it('asks before a sidebar link leaves, and stays on Cancel', async () => {
    await dirtyFinance()

    await userEvent.click(screen.getAllByRole('link', { name: 'Dashboard' })[0] as HTMLElement)
    const dialog = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(screen.getByRole('heading', { name: 'Roles & Permissions' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Invoice Tracking: Export' })).toBeChecked()
  })

  it('leaves through a sidebar link once the changes are discarded', async () => {
    await dirtyFinance()

    await userEvent.click(screen.getAllByRole('link', { name: 'Dashboard' })[0] as HTMLElement)
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Discard changes' }))

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Roles & Permissions' })).not.toBeInTheDocument())
  })

  it('asks before Back leaves', async () => {
    rolesApi()
    const { router } = renderApp('/dashboard')
    await screen.findByRole('banner')
    await act(() => router.navigate('/admin/roles'))
    await userEvent.click(await screen.findByRole('tab', { name: 'Finance Executive' }))
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Invoice Tracking: Export' }))

    await act(() => router.navigate(-1))
    expect(await screen.findByRole('dialog', { name: 'Discard unsaved changes?' })).toBeInTheDocument()
  })

  it('asks before signing out, and stays signed in on Cancel', async () => {
    await dirtyFinance()

    await userEvent.click(screen.getByRole('button', { name: 'Sign Out' }))
    const dialog = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(localStorage.getItem('stslv-amc.token')).toBe('test-token')
    expect(screen.getByRole('checkbox', { name: 'Invoice Tracking: Export' })).toBeChecked()
  })

  it('signs out once the changes are discarded', async () => {
    await dirtyFinance()

    await userEvent.click(screen.getByRole('button', { name: 'Sign Out' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Discard changes' }))

    await waitFor(() => expect(localStorage.getItem('stslv-amc.token')).toBeNull())
  })

  it('does not ask when nothing is unsaved', async () => {
    rolesApi()
    renderApp('/admin/roles')
    await screen.findByRole('tab', { name: 'Finance Executive' })

    await userEvent.click(screen.getAllByRole('link', { name: 'Dashboard' })[0] as HTMLElement)
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Roles & Permissions' })).not.toBeInTheDocument())
    expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })).not.toBeInTheDocument()
  })
})

describe('pages and data-only read', () => {
  const session = (permissions: string[]): SessionUser => ({ ...ADMIN, id: '40', roles: [{ id: '7', code: 'FINANCE_EXECUTIVE', name: 'Finance Executive' }], permissions })

  function pageApi(user: SessionUser) {
    signIn()
    return mockApi((request) => (request.path === '/auth/me' ? ok({ user }) : undefined))
  }

  it('Finance Executive opens Accounts with schedule data-only read', async () => {
    pageApi(session(['DASHBOARD:VIEW', 'INVOICES:VIEW', 'AMC_SCHEDULE:READ']))
    renderApp('/finance/accounts')
    await screen.findByRole('banner')
    expect(screen.queryByRole('heading', { name: 'Access denied' })).not.toBeInTheDocument()
  })

  it('denies the AMC Schedule page to data-only read', async () => {
    pageApi(session(['DASHBOARD:VIEW', 'INVOICES:VIEW', 'AMC_SCHEDULE:READ']))
    renderApp('/amc/schedule')
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
  })

  it('AMC Operations Executive opens Master AMC Status with invoice data-only read', async () => {
    pageApi(session(['DASHBOARD:VIEW', 'AMC_SCHEDULE:VIEW', 'SERVICES_SALES:VIEW', 'INVOICES:READ', 'CLIENTS:READ']))
    renderApp('/amc/master-status')
    await screen.findByRole('banner')
    expect(screen.queryByRole('heading', { name: 'Access denied' })).not.toBeInTheDocument()
  })

  it.each(['/invoices', '/finance/accounts', '/clients'])('denies %s to AMC Operations Executive', async (path) => {
    pageApi(session(['DASHBOARD:VIEW', 'AMC_SCHEDULE:VIEW', 'SERVICES_SALES:VIEW', 'INVOICES:READ', 'CLIENTS:READ']))
    renderApp(path)
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
  })
})

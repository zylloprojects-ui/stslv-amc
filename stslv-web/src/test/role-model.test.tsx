import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ACTIONS, MODULES, type PermissionSection, type Role, type RolesResponse, type SessionUser, type User } from '../lib/types'
import { ADMIN, fail, mockApi, ok, renderApp, signIn, type MockReply, type MockRequest } from './helpers'

/** The Users page asks for one page of the list; other pages ask for the whole list. */
const usersReply = (query: URLSearchParams, list: User[]) => (query.has('page') ? ok({ items: list, total: list.length, pendingTotal: list.filter((entry) => entry.approvalStatus === 'PENDING').length, page: 1, pageSize: 25 }) : ok(list))

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
  scope: CATALOG.flatMap((section) => section.modules.filter((entry) => entry.module !== 'USERS').flatMap((entry) => Object.keys(entry.actions).map((action) => `${entry.module}:${action}`))),
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

const NO_FIXED_ACCESS: NonNullable<RolesResponse['fixedAccess']> = { adminOnly: [], everyone: [] }

function rolesApi(session: SessionUser = ADMIN, roles: Role[] = ROLES, onPut?: (request: MockRequest) => MockReply | undefined, fixedAccess = NO_FIXED_ACCESS) {
  signIn()

  return mockApi((request) => {
    if (onPut && request.method === 'PUT') {
      const reply = onPut(request)
      if (reply) return reply
    }
    if (request.path === '/auth/me') return ok({ user: session })
    if (request.method === 'GET' && request.path === '/users') return usersReply(request.query, USERS)
    if (request.method === 'GET' && request.path === '/roles') {
      return ok({ roles, modules: MODULES, actions: ACTIONS, catalog: CATALOG, fixedAccess })
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
    expect(within(tablist).getAllByRole('tab').map((tab) => tab.getAttribute('aria-label'))).toEqual(['Super Admin', 'Admin', 'Finance Executive', 'AMC Operations Executive'])
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

describe('a role with cross-module permissions', () => {
  it('offers the modules of other sections as well, and never Users & Access', async () => {
    rolesApi()
    await open('Finance Executive')

    expect(screen.getByText(/Finance Executive can be given any of them/)).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Invoice Tracking: Create' })).toBeEnabled()
    expect(screen.getByRole('checkbox', { name: 'AMC Schedule: Data read' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'AMC Schedule: View' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'AMC Schedule: Edit' })).toBeEnabled()
    expect(screen.getByRole('checkbox', { name: 'Clients: Create' })).toBeEnabled()
    expect(screen.queryByRole('checkbox', { name: /^Users & Access:/ })).not.toBeInTheDocument()
    // An action the module does not have is not a checkbox.
    expect(screen.queryByRole('checkbox', { name: 'AMC Schedule: Delete' })).not.toBeInTheDocument()
  })

  it('keeps Data read when View is granted and revoked', async () => {
    rolesApi()
    await open('Finance Executive')

    await userEvent.click(screen.getByRole('checkbox', { name: 'AMC Schedule: Edit' }))
    expect(screen.getByRole('checkbox', { name: 'AMC Schedule: View' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'AMC Schedule: Data read' })).toBeChecked()

    await userEvent.click(screen.getByRole('checkbox', { name: 'AMC Schedule: View' }))
    expect(screen.getByRole('checkbox', { name: 'AMC Schedule: Edit' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'AMC Schedule: Data read' })).toBeChecked()
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
    expect(screen.getByRole('checkbox', { name: 'AMC Schedule: Edit' })).toBeChecked()
    expect(screen.getByRole('heading', { level: 3, name: /Finance Executive/ })).toHaveTextContent('Full')

    await userEvent.click(screen.getByRole('button', { name: 'Clear all' }))
    expect(screen.getByRole('checkbox', { name: 'Invoice Tracking: View' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'AMC Schedule: Data read' })).not.toBeChecked()
    expect(screen.getByRole('heading', { level: 3, name: /Finance Executive/ })).toHaveTextContent('None')

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
  const BUILT_IN = 'Only Super Admin can change a built-in role or its permissions.'
  // As the API answers Admin: no built-in role's permissions are editable; the privileged roles are not assignable.
  const asAdmin = ROLES.map((candidate) =>
    candidate.code === 'ADMIN'
      ? candidate
      : {
          ...candidate,
          permissionsEditable: false,
          lockedReason: BUILT_IN,
          assignable: candidate.code === 'ADMINISTRATOR' ? false : candidate.assignable,
        },
  )

  it('cannot change any built-in role’s permissions, not even an Executive role’s', async () => {
    rolesApi(ADMIN_USER, asAdmin)

    for (const name of ['Admin', 'Finance Executive', 'AMC Operations Executive']) {
      if (name === 'Admin') {
        await open(name)
      } else {
        await userEvent.click(screen.getByRole('tab', { name }))
      }
      expect(await screen.findByText(BUILT_IN)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Save permissions' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Select all' })).not.toBeInTheDocument()
      // Every permission box is disabled; the only box left enabled is the list filter, which changes no permission.
      const filter = screen.getByRole('checkbox', { name: 'Only what this role has' })
      for (const box of screen.getAllByRole('checkbox').filter((item) => item !== filter)) expect(box).toBeDisabled()
    }
  })

  it('edits a custom role the API lets it manage, but never ticks Users & Access, and saves only what it chose', async () => {
    const workshop = role('12', 'WORKSHOP', 'Workshop', { builtIn: false, manageable: true, manageReason: null, permissions: [{ module: 'DASHBOARD', action: 'VIEW' }], permissionsVersion: 'abababababababab' })
    const api = rolesApi(ADMIN_USER, [...asAdmin, workshop])
    await open('Workshop')

    expect(screen.queryByText(BUILT_IN)).not.toBeInTheDocument()
    // Account and access administration is given to a role by Super Admin only (the API refuses it too).
    expect(screen.getByRole('checkbox', { name: 'Users & Access: View' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Users & Access: Edit' })).toBeDisabled()

    await userEvent.click(screen.getByRole('checkbox', { name: 'Clients: View' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save permissions' }))

    await waitFor(() => expect(api.find('PUT', '/roles/12/permissions')).toHaveLength(1))
    const [saved] = api.find('PUT', '/roles/12/permissions')
    const sent = (saved!.body as { permissions: { module: string; action: string }[] }).permissions
    expect(sent.map((p) => `${p.module}:${p.action}`).sort()).toEqual(['CLIENTS:VIEW', 'DASHBOARD:VIEW'])
  })

  it('may still remove Users & Access from a custom role that has it', async () => {
    const helpDesk = role('13', 'HELP_DESK', 'Help Desk', { builtIn: false, manageable: true, permissions: [{ module: 'USERS', action: 'VIEW' }], permissionsVersion: 'cdcdcdcdcdcdcdcd' })
    rolesApi(ADMIN_USER, [...asAdmin, helpDesk])
    await open('Help Desk')

    expect(screen.getByRole('checkbox', { name: 'Users & Access: View' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Users & Access: View' })).toBeEnabled()
    expect(screen.getByRole('checkbox', { name: 'Users & Access: Edit' })).toBeDisabled()
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
      if (request.method === 'GET' && request.path === '/users') return usersReply(request.query, USERS)
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

  it('Finance Executive opens Accounts on its own permission', async () => {
    pageApi(session(['DASHBOARD:VIEW', 'ACCOUNTS:VIEW', 'AMC_SCHEDULE:READ']))
    renderApp('/finance/accounts')
    await screen.findByRole('banner')
    expect(screen.queryByRole('heading', { name: 'Access denied' })).not.toBeInTheDocument()
  })

  it('denies the AMC Schedule page to data-only read', async () => {
    pageApi(session(['DASHBOARD:VIEW', 'INVOICES:VIEW', 'AMC_SCHEDULE:READ']))
    renderApp('/amc/schedule')
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
  })

  it('AMC Operations Executive opens Master AMC Status on its own permission', async () => {
    pageApi(session(['DASHBOARD:VIEW', 'AMC_SCHEDULE:VIEW', 'SERVICES_SALES:VIEW', 'MASTER_AMC_STATUS:VIEW']))
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

// Bulk actions and visibility on the redesigned Roles & Permissions screen (review of coworker 611fcb4, approved 2026-11-02).
describe('filtered bulk actions', () => {
  const sentKeys = (api: ReturnType<typeof rolesApi>) =>
    ((api.find('PUT', '/roles/7/permissions')[0]?.body as { permissions: Role['permissions'] }).permissions ?? []).map((p) => `${p.module}:${p.action}`).sort()

  it('applies Select all only to the modules a search shows, and leaves hidden ones exactly as they were', async () => {
    const api = rolesApi()
    await open('Finance Executive')
    expect(screen.getByText(/apply to all 5 modules, including collapsed sections/)).toBeInTheDocument()

    await userEvent.type(screen.getByRole('searchbox', { name: 'Find a module' }), 'invoice')
    expect(screen.queryByRole('button', { name: 'Select all' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Select all shown' })).toHaveAccessibleDescription(/apply only to the 1 module shown\. Modules hidden by the search or filter are not changed\./)

    await userEvent.click(screen.getByRole('button', { name: 'Select all shown' }))
    expect(screen.getByRole('checkbox', { name: 'Invoice Tracking: Export' })).toBeChecked()

    await userEvent.clear(screen.getByRole('searchbox', { name: 'Find a module' }))
    expect(screen.getByRole('button', { name: 'Select all' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Clients: View' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'AMC Contracts: View' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'AMC Schedule: View' })).not.toBeChecked()

    await userEvent.click(screen.getByRole('button', { name: 'Save permissions' }))
    await waitFor(() => expect(api.find('PUT', '/roles/7/permissions')).toHaveLength(1))
    expect(sentKeys(api)).toEqual(['AMC_SCHEDULE:READ', 'DASHBOARD:VIEW', 'INVOICES:CREATE', 'INVOICES:EDIT', 'INVOICES:EXPORT', 'INVOICES:VIEW'])
  })

  it('applies Clear all only to the modules a search shows, and keeps every hidden grant', async () => {
    const api = rolesApi()
    await open('Finance Executive')

    await userEvent.type(screen.getByRole('searchbox', { name: 'Find a module' }), 'invoice')
    await userEvent.click(screen.getByRole('button', { name: 'Clear all shown' }))
    expect(screen.getByRole('checkbox', { name: 'Invoice Tracking: View' })).not.toBeChecked()

    await userEvent.click(screen.getByRole('button', { name: 'Save permissions' }))
    await waitFor(() => expect(api.find('PUT', '/roles/7/permissions')).toHaveLength(1))
    expect(sentKeys(api)).toEqual(['AMC_SCHEDULE:READ', 'DASHBOARD:VIEW'])
  })

  it('with "Only what this role has", acts on the held modules only, and keeps their rows while they are edited', async () => {
    const api = rolesApi()
    await open('Finance Executive')

    await userEvent.click(screen.getByRole('checkbox', { name: 'Only what this role has' }))
    expect(screen.queryByRole('checkbox', { name: 'Clients: View' })).not.toBeInTheDocument()
    expect(screen.getByText(/apply only to the 3 modules shown/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Clear all shown' }))
    // The rows stay, so the change can be seen and undone.
    expect(screen.getByRole('checkbox', { name: 'Invoice Tracking: View' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Dashboard: View' })).not.toBeChecked()

    await userEvent.click(screen.getByRole('button', { name: 'Select all shown' }))
    expect(screen.getByRole('checkbox', { name: 'Invoice Tracking: Export' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'AMC Schedule: Edit' })).toBeChecked()

    await userEvent.click(screen.getByRole('checkbox', { name: 'Only what this role has' }))
    expect(screen.getByRole('checkbox', { name: 'Clients: View' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'AMC Contracts: View' })).not.toBeChecked()

    await userEvent.click(screen.getByRole('button', { name: 'Save permissions' }))
    await waitFor(() => expect(api.find('PUT', '/roles/7/permissions')).toHaveLength(1))
    expect(sentKeys(api).some((key) => key.startsWith('CLIENTS:') || key.startsWith('AMC_CONTRACTS:'))).toBe(false)
  })

  it('never grants or removes, in bulk, a permission the signed-in user does not hold', async () => {
    const limited: SessionUser = { ...ADMIN, permissions: ['USERS:VIEW', 'USERS:EDIT', 'INVOICES:VIEW', 'INVOICES:CREATE'] }
    const api = rolesApi(limited)
    await open('Finance Executive')

    await userEvent.click(screen.getByRole('button', { name: 'Select all' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save permissions' }))
    await waitFor(() => expect(api.find('PUT', '/roles/7/permissions')).toHaveLength(1))
    expect(sentKeys(api)).toEqual(['AMC_SCHEDULE:READ', 'DASHBOARD:VIEW', 'INVOICES:CREATE', 'INVOICES:VIEW'])
  })

  it('offers no bulk action on Super Admin, even while a search or filter is on, and keeps every box locked', async () => {
    rolesApi()
    await open('Super Admin')

    expect(screen.getByText('Super Admin always has full access. Its permissions cannot be changed.')).toBeInTheDocument()
    expect(screen.getByTestId('permission-mode')).toHaveTextContent('Read only')
    await userEvent.type(screen.getByRole('searchbox', { name: 'Find a module' }), 'a')
    await userEvent.click(screen.getByRole('checkbox', { name: 'Only what this role has' }))
    for (const name of [/^Select all/, /^Clear all/, 'Save permissions']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    const filter = screen.getByRole('checkbox', { name: 'Only what this role has' })
    for (const box of screen.getAllByRole('checkbox').filter((item) => item !== filter)) expect(box).toBeDisabled()
  })

  it('offers no bulk action on a role the signed-in user may not edit, even while filtering', async () => {
    const locked = ROLES.map((candidate) => (candidate.code === 'ADMIN' ? candidate : { ...candidate, permissionsEditable: false, lockedReason: 'Only Super Admin can change role permissions.' }))
    rolesApi(ADMIN_USER, locked)
    await open('Finance Executive')

    await userEvent.type(screen.getByRole('searchbox', { name: 'Find a module' }), 'invoice')
    expect(screen.queryByRole('button', { name: /^Select all/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Clear all/ })).not.toBeInTheDocument()
    expect(screen.getByTestId('permission-mode')).toHaveTextContent('Read only')
    expect(screen.getByRole('checkbox', { name: 'Invoice Tracking: View' })).toBeDisabled()
  })
})

describe('permission visibility', () => {
  const FIXED = {
    superAdminOnly: [{ label: 'Backup & Restore', path: '/settings/backups' }],
    adminOnly: [{ label: 'Security Center', path: '/admin/security' }],
    everyone: [{ label: 'My account', path: '/account' }],
  }

  it('shows the fixed restrictions open by default, marked as not changeable here, and lets them be collapsed', async () => {
    rolesApi(ADMIN, ROLES, undefined, FIXED)
    await open('Finance Executive')

    const fixed = screen.getByTestId('fixed-access')
    expect(fixed).toHaveAttribute('open')
    expect(within(fixed).getByText('Fixed: cannot be changed here')).toBeInTheDocument()
    expect(within(fixed).getByText('Super Admin only:').parentElement).toHaveTextContent('Backup & Restore')
    expect(within(fixed).getByText('Super Admin and Admin only:').parentElement).toHaveTextContent('Security Center')
    expect(within(fixed).queryByRole('checkbox')).not.toBeInTheDocument()

    await userEvent.click(within(fixed).getByText('Not set by role permissions'))
    expect(fixed).not.toHaveAttribute('open')
  })

  it('opens and closes each permission section on its own, and marks it Editable or Read only', async () => {
    rolesApi()
    await open('Finance Executive')
    expect(screen.getByTestId('permission-mode')).toHaveTextContent('Editable here')

    const title = (text: string) => screen.getByText(text, { selector: 'summary > span' })
    const section = (text: string) => title(text).closest('details') as HTMLElement
    expect(section('Finance')).not.toHaveAttribute('open')
    expect(within(section('Finance')).getByText('Editable')).toBeInTheDocument()

    await userEvent.click(title('Finance'))
    expect(section('Finance')).toHaveAttribute('open')
    expect(section('AMC Operations')).not.toHaveAttribute('open')

    await userEvent.click(title('Finance'))
    expect(section('Finance')).not.toHaveAttribute('open')

    await userEvent.click(screen.getByRole('tab', { name: 'Super Admin' }))
    await screen.findByRole('heading', { level: 3, name: /^Super Admin/ })
    expect(within(section('Finance')).getByText('Read only')).toBeInTheDocument()
  })
})

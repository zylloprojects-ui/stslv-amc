import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ACTIONS, MODULES, type PermissionSection, type Role, type VisibilitySection } from '../lib/types'
import { shows } from '../lib/visibility'
import { ADMIN, mockApi, ok, renderApp, signIn } from './helpers'

// Roles & Permissions › Page visibility (owner request 2026-11-21, API migration 0123): untick a Dashboard row or panel,
// an Invoices column or an action to hide it from a role that keeps the page. The API enforces it
// (stslv-api/tests/role-visibility.test.ts); these tests cover the screen and the session helper.

const VISIBILITY: VisibilitySection[] = [
  {
    id: 'dashboard',
    title: 'Dashboard',
    page: { label: 'Dashboard', path: '/dashboard' },
    requires: 'DASHBOARD:VIEW',
    groups: [
      {
        title: 'Key figure rows',
        items: [
          { key: 'dashboard.row.portfolio', label: 'Row 1 · AMC Portfolio', kind: 'row' },
          { key: 'dashboard.row.month', label: 'Row 2 · Current Month', kind: 'row' },
        ],
      },
    ],
  },
  {
    id: 'invoices',
    title: 'Accounts › Invoices',
    page: { label: 'Invoices', path: '/finance/accounts' },
    requires: 'ACCOUNTS:VIEW',
    groups: [{ title: 'Actions', items: [{ key: 'invoices.action.downloadContract', label: 'Download AMC contract', kind: 'action' }] }],
  },
]
const CATALOG: PermissionSection[] = [{ title: 'Dashboard', modules: [{ module: 'DASHBOARD', label: 'Dashboard', description: '', pages: [], actions: { VIEW: 'Open the Dashboard' } }] }]
const everything = MODULES.flatMap((module) => ACTIONS.map((action) => ({ module, action })))
const role = (id: string, code: string, name: string, extra: Partial<Role> = {}): Role => ({
  id, code, name, description: null, isActive: true, userCount: 1, permissions: [], permissionsEditable: true, lockedReason: null, scope: null, assignable: true,
  permissionsVersion: '0000000000000000', hiddenItems: [], visibilityVersion: 'aaaaaaaaaaaaaaaa', ...extra,
})
const ACCOUNTS = role('7', 'FINANCE_EXECUTIVE', 'Accounts', { permissions: [{ module: 'DASHBOARD', action: 'VIEW' }, { module: 'ACCOUNTS', action: 'VIEW' }] })
const ROLES = [
  role('1', 'ADMIN', 'Super Admin', { permissions: everything, permissionsEditable: false, lockedReason: 'Super Admin always has full access. Its permissions cannot be changed.' }),
  ACCOUNTS,
]

function rolesApi(roles: Role[] = ROLES) {
  signIn()
  return mockApi((request) => {
    if (request.path === '/auth/me') return ok({ user: ADMIN })
    if (request.method === 'GET' && request.path === '/roles') return ok({ roles, modules: MODULES, actions: ACTIONS, catalog: CATALOG, fixedAccess: { adminOnly: [], everyone: [] }, visibilityCatalog: VISIBILITY })
    if (request.method === 'GET' && request.path === '/users') return ok([])
    if (request.method === 'PUT' && request.path === '/roles/7/visibility') {
      return ok({ ...ACCOUNTS, hiddenItems: (request.body as { hidden: string[] }).hidden, visibilityVersion: 'bbbbbbbbbbbbbbbb' })
    }
    return undefined
  })
}

async function openRole(name: string) {
  await userEvent.click(within(await screen.findByRole('tablist', { name: 'Roles' })).getByRole('tab', { name }))
  return screen.findByTestId('page-visibility')
}

describe('Roles & Permissions › Page visibility', () => {
  it('hides one Dashboard row from a role and saves only that', async () => {
    const api = rolesApi()
    renderApp('/admin/roles')
    const panel = await openRole('Accounts')

    const row1 = within(panel).getByRole('checkbox', { name: 'Dashboard: Row 1 · AMC Portfolio' })
    expect(row1).toBeChecked()
    expect(within(panel).getByRole('checkbox', { name: 'Dashboard: Row 2 · Current Month' })).toBeChecked()
    await userEvent.click(row1)
    expect(row1).not.toBeChecked()

    await userEvent.click(within(panel).getByRole('button', { name: 'Save visibility' }))
    await waitFor(() => expect(api.find('PUT', '/roles/7/visibility')).toHaveLength(1))
    expect(api.find('PUT', '/roles/7/visibility')[0]?.body).toEqual({ hidden: ['dashboard.row.portfolio'], expectedVersion: 'aaaaaaaaaaaaaaaa' })
    expect(await within(panel).findByText(/Visibility saved/)).toBeInTheDocument()
  })

  it('can hide the contract download on Invoices while the role keeps the page', async () => {
    const api = rolesApi()
    renderApp('/admin/roles')
    const panel = await openRole('Accounts')

    await userEvent.click(within(panel).getByRole('checkbox', { name: 'Accounts › Invoices: Download AMC contract' }))
    await userEvent.click(within(panel).getByRole('button', { name: 'Save visibility' }))
    await waitFor(() => expect(api.find('PUT', '/roles/7/visibility')[0]?.body).toEqual({ hidden: ['invoices.action.downloadContract'], expectedVersion: 'aaaaaaaaaaaaaaaa' }))
  })

  it('lists each page collapsed, like the permission sections, and puts the fixed-access box last', async () => {
    signIn()
    mockApi((request) => {
      if (request.path === '/auth/me') return ok({ user: ADMIN })
      if (request.method === 'GET' && request.path === '/roles') return ok({ roles: ROLES, modules: MODULES, actions: ACTIONS, catalog: CATALOG, fixedAccess: { adminOnly: [{ label: 'Audit Log', path: '/admin/audit' }], everyone: [] }, visibilityCatalog: VISIBILITY })
      if (request.method === 'GET' && request.path === '/users') return ok([])
      return undefined
    })
    renderApp('/admin/roles')
    const panel = await openRole('Accounts')

    const sections = [...panel.querySelectorAll('details')]
    expect(sections).toHaveLength(2)
    for (const section of sections) expect(section).not.toHaveAttribute('open')
    expect(within(panel).getByText('1/1 shown')).toBeInTheDocument()

    await userEvent.click(within(panel).getByRole('button', { name: 'Expand all' }))
    for (const section of panel.querySelectorAll('details')) expect(section).toHaveAttribute('open')

    const fixed = screen.getByTestId('fixed-access')
    expect(panel.compareDocumentPosition(fixed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("is read only for Super Admin's own role, which always sees everything", async () => {
    rolesApi()
    renderApp('/admin/roles')
    const panel = await openRole('Super Admin')

    expect(within(panel).queryByRole('button', { name: 'Save visibility' })).not.toBeInTheDocument()
    for (const box of within(panel).getAllByRole('checkbox')) expect(box).toBeDisabled()
  })

  it('says when the role cannot open the page at all', async () => {
    rolesApi([ROLES[0]!, { ...ACCOUNTS, permissions: [{ module: 'DASHBOARD', action: 'VIEW' }] }])
    renderApp('/admin/roles')
    const panel = await openRole('Accounts')

    expect(within(panel).getByText('This role cannot open Invoices')).toBeInTheDocument()
  })
})

describe('shows()', () => {
  it('is true unless the session lists the item as hidden, and for an older API without the list', () => {
    expect(shows({ hidden: ['dashboard.row.portfolio'] }, 'dashboard.row.portfolio')).toBe(false)
    expect(shows({ hidden: ['dashboard.row.portfolio'] }, 'dashboard.row.month')).toBe(true)
    expect(shows({}, 'dashboard.row.portfolio')).toBe(true)
    expect(shows(null, 'dashboard.row.portfolio')).toBe(true)
  })
})

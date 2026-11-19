import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BUILT_IN_ROLE_NAMES } from '../auth/roleNames'
import { isAdmin, isPrivilegedRole } from '../auth/roles'
import { NAVIGATION, navItemVisible } from '../layout/navigation'
import { ACTIONS, MODULES, type Action, type Module, type PermissionSection, type Role, type SessionUser } from '../lib/types'
import { ADMIN, mockApi, ok, renderApp, signIn } from './helpers'

// The "AMC Renewal" role (API migration 0120, 2026-11-19): a built-in operational role. It starts with no permissions;
// the sidebar, start page and route guards follow only what Super Admin grants it. The API enforces the same
// (stslv-api/tests/amc-renewal-role.test.ts).

const ROLE = { id: '12', code: 'AMC_RENEWAL_EXECUTIVE', name: 'AMC Renewal' }

const renewalUser = (permissions: string[]): SessionUser => ({
  ...ADMIN,
  id: '50',
  email: 'renewal@example.com',
  fullName: 'Rana Renewal',
  roles: [ROLE],
  permissions,
})

function session(user: SessionUser) {
  signIn()
  return mockApi((request) => (request.path === '/auth/me' ? ok({ user }) : undefined))
}

const offered = (permissions: string[]) => {
  const held = new Set(permissions)
  const can = (module: Module, action: Action) => held.has(`${module}:${action}`)
  const canRead = (module: Module) => can(module, 'VIEW') || can(module, 'READ')

  return NAVIGATION.flatMap((section) => section.items)
    .filter((item) => navItemVisible(item, can, false, canRead))
    .map((item) => item.label)
}

describe('the AMC Renewal role', () => {
  it('has its name, and is neither Super Admin nor an administrator', () => {
    expect(BUILT_IN_ROLE_NAMES.AMC_RENEWAL_EXECUTIVE).toBe('AMC Renewal')
    expect(isPrivilegedRole(ROLE.code)).toBe(false)
    expect(isAdmin(renewalUser([]))).toBe(false)
  })

  it('offers no page while it has no permissions, and exactly the granted pages afterwards', () => {
    expect(offered([])).toEqual([])
    expect(offered(['AMC_RENEWAL:VIEW'])).toEqual(['AMC Renewals'])
    expect(offered(['AMC_RENEWAL:VIEW', 'AMC_CONTRACTS:VIEW', 'DASHBOARD:VIEW'])).toEqual(expect.arrayContaining(['Dashboard', 'AMC Renewals', 'AMC Contracts']))
    expect(offered(['AMC_RENEWAL:VIEW', 'AMC_CONTRACTS:VIEW', 'DASHBOARD:VIEW'])).not.toContain('Users')
  })

  it('with no permissions, the start page explains Access denied', async () => {
    session(renewalUser([]))
    renderApp('/')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
  })

  it('opens nothing it was not granted, even from the address bar', async () => {
    for (const path of ['/admin/roles', '/admin/users', '/amc/contracts', '/amc/renewal']) {
      session(renewalUser(path === '/amc/renewal' ? [] : ['AMC_RENEWAL:VIEW']))
      const view = renderApp(path)

      expect(await screen.findByRole('heading', { name: 'Access denied' }), path).toBeInTheDocument()
      view.unmount()
    }
  })
})

describe('Roles & Permissions lists AMC Renewal', () => {
  const CATALOG: PermissionSection[] = [
    { title: 'Dashboard', modules: [{ module: 'DASHBOARD', label: 'Dashboard', description: '', pages: [], actions: { VIEW: 'Open the Dashboard' } }] },
    { title: 'AMC Operations', modules: [{ module: 'AMC_RENEWAL', label: 'AMC Renewal', description: '', pages: [], actions: { VIEW: 'See', CREATE: 'Renew', EXPORT: 'Export' } }] },
  ]
  const role = (id: string, code: string, name: string, extra: Partial<Role> = {}): Role => ({
    id, code, name, description: null, isActive: true, userCount: 0, permissions: [], permissionsEditable: true, lockedReason: null, scope: null, assignable: true, ...extra,
  })
  const everything = MODULES.flatMap((module) => ACTIONS.map((action) => ({ module, action })))
  const ROLES = [
    role('1', 'ADMIN', 'Super Admin', { permissions: everything, permissionsEditable: false, lockedReason: 'Super Admin always has full access. Its permissions cannot be changed.', assignable: false }),
    role('6', 'ADMINISTRATOR', 'Service Dept'),
    role('7', 'FINANCE_EXECUTIVE', 'Accounts'),
    role('8', 'MASTER_DATA_EXECUTIVE', 'AMC Sales'),
    role(ROLE.id, ROLE.code, ROLE.name, { scope: ['DASHBOARD:VIEW', 'AMC_RENEWAL:VIEW', 'AMC_RENEWAL:CREATE', 'AMC_RENEWAL:EXPORT'] }),
  ]

  it('as a tab alongside the other roles, for Super Admin to configure', async () => {
    signIn()
    mockApi((request) => {
      if (request.path === '/auth/me') return ok({ user: ADMIN })
      if (request.method === 'GET' && request.path === '/roles') return ok({ roles: ROLES, modules: MODULES, actions: ACTIONS, catalog: CATALOG, fixedAccess: { adminOnly: [], everyone: [] } })
      if (request.method === 'GET' && request.path === '/users') return ok([])
      return undefined
    })
    renderApp('/admin/roles')

    const tablist = await screen.findByRole('tablist', { name: 'Roles' })
    expect(within(tablist).getAllByRole('tab').map((tab) => tab.getAttribute('aria-label'))).toEqual(['Super Admin', 'Service Dept', 'Accounts', 'AMC Sales', 'AMC Renewal'])
  })
})

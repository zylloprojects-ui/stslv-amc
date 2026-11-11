import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ACTIONS, MODULES, type Role, type SessionUser } from '../lib/types'
import { ADMIN, fail, mockApi, ok, renderApp, signIn } from './helpers'

// The panel is hidden in the application for now (lib/features.ts). It is switched on here so it stays tested.
vi.mock('../lib/features', () => ({ ROLE_LIST_ENABLED: true, DIVISIONS_ENABLED: false }))

const role = (id: string, code: string, name: string, userCount: number, isActive = true): Role => ({
  id,
  code,
  name,
  description: `${name} work.`,
  isActive,
  userCount,
  permissions: [],
  permissionsEditable: code !== 'ADMIN',
})

function roleListApi(user: SessionUser = ADMIN) {
  const roles: Role[] = [role('1', 'ADMIN', 'Admin', 1), role('2', 'EXECUTION', 'Execution', 3), role('3', 'WORKSHOP', 'Workshop', 0)]

  signIn()

  const api = mockApi((request) => {
    const { method, path } = request
    const body = (request.body ?? {}) as Record<string, unknown>

    if (path === '/auth/me') return ok({ user })
    if (method === 'GET' && path === '/roles') return ok({ roles, modules: MODULES, actions: ACTIONS })
    if (method === 'POST' && path === '/roles') {
      if (body.code === 'DUPLICATE') return fail(409, 'CONFLICT', 'A role with this code or name already exists.')
      const created = role(String(roles.length + 1), String(body.code), String(body.name), 0)
      roles.push(created)
      return ok(created, 201)
    }

    const match = /^\/roles\/(\d+)$/.exec(path)
    const index = roles.findIndex((item) => item.id === match?.[1])

    if (match && method === 'PATCH') {
      roles[index] = { ...(roles[index] as Role), name: String(body.name), isActive: body.isActive === true }
      return ok(roles[index])
    }
    if (match && method === 'DELETE') {
      if ((roles[index] as Role).userCount > 0) return fail(409, 'CONFLICT', '3 people still have this role. Move them to another role first.')
      roles.splice(index, 1)
      return ok(null)
    }

    return undefined
  })

  return api
}

const open = async () => {
  renderApp('/settings?section=roles')
  return screen.findByRole('table', { name: 'Roles' })
}

describe('roles', () => {
  it('lists every role with its code, status and number of people', async () => {
    roleListApi()
    const table = await open()
    const rows = within(table).getAllByRole('row').slice(1)

    expect(rows).toHaveLength(3)
    expect(within(rows[1] as HTMLElement).getByText('EXECUTION')).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('Execution')).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('Active')).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('3')).toBeInTheDocument()
  })

  it('adds a role with an upper-case code', async () => {
    const api = roleListApi()
    await open()

    await userEvent.click(screen.getByRole('button', { name: 'Add role' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add role' })
    await userEvent.type(within(dialog).getByLabelText(/Role code/), 'site_ops')
    await userEvent.type(within(dialog).getByLabelText(/Role name/), 'Site operations')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add role' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Site operations was added.')
    expect(api.find('POST', '/roles')[0]?.body).toMatchObject({ code: 'SITE_OPS', name: 'Site operations' })
    expect(await screen.findByText('SITE_OPS')).toBeInTheDocument()
  })

  it('asks for a valid code and a name before sending anything', async () => {
    const api = roleListApi()
    await open()

    await userEvent.click(screen.getByRole('button', { name: 'Add role' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add role' })
    await userEvent.type(within(dialog).getByLabelText(/Role code/), '1 bad')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add role' }))

    expect(await within(dialog).findByText('Name is required.')).toBeInTheDocument()
    expect(api.find('POST', '/roles')).toHaveLength(0)
  })

  it('shows the server message when the role already exists', async () => {
    roleListApi()
    await open()

    await userEvent.click(screen.getByRole('button', { name: 'Add role' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add role' })
    await userEvent.type(within(dialog).getByLabelText(/Role code/), 'duplicate')
    await userEvent.type(within(dialog).getByLabelText(/Role name/), 'Copy')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add role' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('already exists')
  })

  it('edits the name and status, with the code locked', async () => {
    const api = roleListApi()
    await open()

    await userEvent.click(screen.getByRole('button', { name: 'Edit Workshop' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit role' })

    expect(within(dialog).getByLabelText(/Role code/)).toBeDisabled()
    await userEvent.clear(within(dialog).getByLabelText(/Role name/))
    await userEvent.type(within(dialog).getByLabelText(/Role name/), 'Workshop team')
    await userEvent.selectOptions(within(dialog).getByLabelText('Status'), 'inactive')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Workshop team was updated.')
    expect(api.find('PATCH', '/roles/3')[0]?.body).toMatchObject({ name: 'Workshop team', isActive: false })
  })

  it('deletes an unused role after a confirmation', async () => {
    const api = roleListApi()
    await open()

    await userEvent.click(screen.getByRole('button', { name: 'Delete Workshop' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete role' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete role' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Workshop was deleted.')
    expect(api.find('DELETE', '/roles/3')).toHaveLength(1)
  })

  it('keeps the dialog open and says why when people still hold the role', async () => {
    roleListApi()
    await open()

    await userEvent.click(screen.getByRole('button', { name: 'Delete Execution' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete role' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete role' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('3 people still have this role')
    expect(screen.getByRole('dialog', { name: 'Delete role' })).toBeInTheDocument()
  })

  it('with an older API that sends no decision, offers the buttons to Super Admin only', async () => {
    roleListApi({ ...ADMIN, roles: [{ id: '6', code: 'ADMINISTRATOR', name: 'Service Dept' }], permissions: ['DASHBOARD:VIEW', 'SETTINGS:VIEW', 'USERS:VIEW', 'USERS:CREATE', 'USERS:EDIT'] })
    await open()

    expect(screen.queryByRole('button', { name: 'Add role' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument()
  })
})

// Approved 2026-11-09: Admin manages custom roles within its own permissions. The API decides per role
// (canManageRoles, manageable, manageReason) and enforces it; the panel shows exactly what it is told.
describe('roles as Admin', () => {
  const ADMINISTRATOR: SessionUser = {
    ...ADMIN,
    roles: [{ id: '6', code: 'ADMINISTRATOR', name: 'Service Dept' }],
    permissions: ['DASHBOARD:VIEW', 'SETTINGS:VIEW', 'USERS:VIEW', 'USERS:CREATE', 'USERS:EDIT'],
  }
  const BUILT_IN = 'Only Super Admin can change a built-in role or its permissions.'
  const BEYOND = 'This role grants permissions you do not hold. Only Super Admin can change it.'

  function adminApi(canManageRoles: boolean) {
    signIn()
    const roles: Role[] = [
      { ...role('1', 'ADMIN', 'Super Admin', 1), builtIn: true, manageable: false, manageReason: BUILT_IN },
      { ...role('6', 'ADMINISTRATOR', 'Service Dept', 1), builtIn: true, manageable: false, manageReason: BUILT_IN },
      { ...role('7', 'WORKSHOP', 'Workshop', 0), builtIn: false, manageable: canManageRoles, manageReason: canManageRoles ? null : 'Only Super Admin, and Service Dept with Users & Access Edit, can change roles and their permissions.' },
      { ...role('8', 'ANALYST', 'Analyst', 0), builtIn: false, manageable: false, manageReason: BEYOND },
    ]

    return mockApi((request) => {
      if (request.path === '/auth/me') return ok({ user: ADMINISTRATOR })
      if (request.method === 'GET' && request.path === '/roles') return ok({ roles, canManageRoles, modules: MODULES, actions: ACTIONS })
      if (request.method === 'POST' && request.path === '/roles') return ok({ ...role('9', 'SITE_OPS', 'Site operations', 0), builtIn: false, manageable: true, manageReason: null }, 201)
      if (request.method === 'DELETE' && request.path === '/roles/7') return ok(null)
      return undefined
    })
  }

  it('lets Admin add roles and edit or delete the custom roles within its permissions, and nothing else', async () => {
    const api = adminApi(true)
    await open()

    expect(screen.getByRole('button', { name: 'Add role' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit Workshop' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete Workshop' })).toBeEnabled()
    for (const name of ['Super Admin', 'Service Dept', 'Analyst']) {
      expect(screen.queryByRole('button', { name: `Edit ${name}` }), name).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: `Delete ${name}` }), name).not.toBeInTheDocument()
    }
    // Why a row has no actions is there for screen readers too.
    expect(screen.getAllByText(BUILT_IN)).toHaveLength(2)
    expect(screen.getByText(BEYOND)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Add role' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add role' })
    await userEvent.type(within(dialog).getByLabelText(/Role code/), 'site_ops')
    await userEvent.type(within(dialog).getByLabelText(/Role name/), 'Site operations')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add role' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Site operations was added.')
    expect(api.find('POST', '/roles')[0]?.body).toMatchObject({ code: 'SITE_OPS' })
  })

  it('offers nothing when the API says Admin may not manage roles (Users & Access Edit removed)', async () => {
    adminApi(false)
    await open()

    expect(screen.queryByRole('button', { name: 'Add role' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument()
  })
})

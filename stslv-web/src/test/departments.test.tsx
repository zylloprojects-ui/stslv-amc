import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ACTIONS, MODULES, type Role, type SessionUser } from '../lib/types'
import { ADMIN, fail, mockApi, ok, renderApp, signIn } from './helpers'

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

function departmentsApi(user: SessionUser = ADMIN) {
  const roles: Role[] = [role('1', 'ADMIN', 'Admin', 1), role('2', 'EXECUTION', 'Execution', 3), role('3', 'WORKSHOP', 'Workshop', 0)]

  signIn()

  const api = mockApi((request) => {
    const { method, path } = request
    const body = (request.body ?? {}) as Record<string, unknown>

    if (path === '/auth/me') return ok({ user })
    if (method === 'GET' && path === '/roles') return ok({ roles, modules: MODULES, actions: ACTIONS })
    if (method === 'POST' && path === '/roles') {
      if (body.code === 'DUPLICATE') return fail(409, 'CONFLICT', 'A department with this code or name already exists.')
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
  renderApp('/settings?section=departments')
  return screen.findByRole('table', { name: 'Departments' })
}

describe('departments', () => {
  it('lists every department with its code, status and number of people', async () => {
    departmentsApi()
    const table = await open()
    const rows = within(table).getAllByRole('row').slice(1)

    expect(rows).toHaveLength(3)
    expect(within(rows[1] as HTMLElement).getByText('EXECUTION')).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('Execution')).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('Active')).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('3')).toBeInTheDocument()
  })

  it('adds a department with an upper-case code', async () => {
    const api = departmentsApi()
    await open()

    await userEvent.click(screen.getByRole('button', { name: 'Add department' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add department' })
    await userEvent.type(within(dialog).getByLabelText(/Department code/), 'site_ops')
    await userEvent.type(within(dialog).getByLabelText(/Department name/), 'Site operations')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add department' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Site operations was added.')
    expect(api.find('POST', '/roles')[0]?.body).toMatchObject({ code: 'SITE_OPS', name: 'Site operations' })
    expect(await screen.findByText('SITE_OPS')).toBeInTheDocument()
  })

  it('asks for a valid code and a name before sending anything', async () => {
    const api = departmentsApi()
    await open()

    await userEvent.click(screen.getByRole('button', { name: 'Add department' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add department' })
    await userEvent.type(within(dialog).getByLabelText(/Department code/), '1 bad')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add department' }))

    expect(await within(dialog).findByText('Name is required.')).toBeInTheDocument()
    expect(api.find('POST', '/roles')).toHaveLength(0)
  })

  it('shows the server message when the department already exists', async () => {
    departmentsApi()
    await open()

    await userEvent.click(screen.getByRole('button', { name: 'Add department' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add department' })
    await userEvent.type(within(dialog).getByLabelText(/Department code/), 'duplicate')
    await userEvent.type(within(dialog).getByLabelText(/Department name/), 'Copy')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add department' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('already exists')
  })

  it('edits the name and status, with the code locked', async () => {
    const api = departmentsApi()
    await open()

    await userEvent.click(screen.getByRole('button', { name: 'Edit Workshop' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit department' })

    expect(within(dialog).getByLabelText(/Department code/)).toBeDisabled()
    await userEvent.clear(within(dialog).getByLabelText(/Department name/))
    await userEvent.type(within(dialog).getByLabelText(/Department name/), 'Workshop team')
    await userEvent.selectOptions(within(dialog).getByLabelText('Status'), 'inactive')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Workshop team was updated.')
    expect(api.find('PATCH', '/roles/3')[0]?.body).toMatchObject({ name: 'Workshop team', isActive: false })
  })

  it('deletes an unused department after a confirmation', async () => {
    const api = departmentsApi()
    await open()

    await userEvent.click(screen.getByRole('button', { name: 'Delete Workshop' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete department' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete department' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Workshop was deleted.')
    expect(api.find('DELETE', '/roles/3')).toHaveLength(1)
  })

  it('keeps the dialog open and says why when people still hold the department', async () => {
    departmentsApi()
    await open()

    await userEvent.click(screen.getByRole('button', { name: 'Delete Execution' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete department' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete department' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('3 people still have this role')
    expect(screen.getByRole('dialog', { name: 'Delete department' })).toBeInTheDocument()
  })

  it('shows the buttons only to people who hold the matching permission', async () => {
    departmentsApi({ ...ADMIN, permissions: ['DASHBOARD:VIEW', 'SETTINGS:VIEW', 'USERS:VIEW'] })
    await open()

    expect(screen.queryByRole('button', { name: 'Add department' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument()
  })
})

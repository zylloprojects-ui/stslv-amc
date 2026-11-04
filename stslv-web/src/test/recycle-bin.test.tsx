import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { SessionUser } from '../lib/types'
import type { RecycleBinItem, RecycleType } from '../pages/admin/RecycleBin'
import { ADMIN, fail, mockApi, ok, renderApp, signIn, type MockRequest, type MockReply } from './helpers'

// Recycle Bin (migrations 0101 and 0106, approved 2026-11-04): Super Admin sees the AMC contracts, clients,
// system types and sales engineers deleted now, restores them, and deletes never-used records permanently
// after typing the code. The Deletion History is a separate view of past events with each record's status now.

const ADMIN_ROLE: SessionUser = {
  id: '6',
  email: 'admin-role@example.com',
  fullName: 'Ari Admin',
  roles: [{ id: '6', code: 'ADMINISTRATOR', name: 'Admin' }],
  permissions: ['RECYCLE_BIN:VIEW', 'AUDIT_LOG:VIEW', 'AMC_CONTRACTS:VIEW', 'AMC_CONTRACTS:DELETE'],
}

const CONTRACT: RecycleBinItem = {
  type: 'AMC_CONTRACT',
  typeLabel: 'AMC contract',
  id: '7',
  reference: 'AMC-0007',
  name: 'Test Hotel One',
  details: 'FIRE',
  status: 'ACTIVE',
  isActive: null,
  deletedAt: '2026-11-03T06:00:00.000Z',
  deletedBy: { id: '1', fullName: 'Asha Admin' },
  contract: { validFrom: '2026-01-01', validTo: '2026-12-31', contractValue: '1200.000', services: 4, invoices: 1, documents: 2 },
}

const TYPE: RecycleBinItem = {
  type: 'SYSTEM_TYPE',
  typeLabel: 'System type',
  id: '12',
  reference: 'HVAC',
  name: 'HVAC',
  details: null,
  status: null,
  isActive: true,
  deletedAt: '2026-11-04T06:00:00.000Z',
  deletedBy: { id: '1', fullName: 'Asha Admin' },
  contract: null,
}

const counts = (items: RecycleBinItem[]) =>
  Object.fromEntries((['AMC_CONTRACT', 'CLIENT', 'SYSTEM_TYPE', 'SALES_ENGINEER'] as RecycleType[]).map((type) => [type, items.filter((item) => item.type === type).length]))

const check = (item: RecycleBinItem, overrides: Record<string, unknown> = {}) => ({
  type: item.type,
  id: item.id,
  reference: item.reference,
  name: item.name,
  restore: { allowed: true, blockers: [], warnings: [] },
  purge: item.type === 'AMC_CONTRACT' ? { allowed: false, reasons: ['AMC contracts are never deleted permanently.'], confirmText: null } : { allowed: true, reasons: [], confirmText: item.reference },
  ...overrides,
})

function recycleApi(user: SessionUser, handler: (request: MockRequest) => MockReply | undefined = () => undefined) {
  signIn()
  let binned = [TYPE, CONTRACT]

  return mockApi((request) => {
    const handled = handler(request)
    if (handled) return handled
    if (request.path === '/auth/me') return ok({ user })
    if (request.path === '/security/recycle-bin') {
      const type = request.query.get('type')
      const items = binned.filter((item) => !type || item.type === type)
      return ok({ items, total: items.length, page: 1, pageSize: 25, counts: counts(binned), options: { deletedBy: [{ id: '1', fullName: 'Asha Admin' }] } })
    }
    if (request.path === '/security/recycle-bin/amc-contracts/7/check') return ok(check(CONTRACT))
    if (request.path === '/security/recycle-bin/system-types/12/check') return ok(check(TYPE))
    if (request.method === 'POST' && request.path === '/security/recycle-bin/amc-contracts/7/restore') {
      binned = binned.filter((item) => item !== CONTRACT)
      return ok({ id: '7' })
    }
    if (request.method === 'DELETE' && request.path === '/security/recycle-bin/system-types/12') {
      binned = binned.filter((item) => item !== TYPE)
      return ok({ deleted: true })
    }
    if (request.path === '/security/deletions') {
      return ok({
        items: [
          { id: '90', kind: 'DEACTIVATED', deletion: null, currentStatus: 'LIVE', action: 'department.deactivated', entityType: 'departments', entityId: '6', description: 'Department "Administration" deactivated.', reason: null, user: 'Asha Admin', createdAt: '2026-11-04T09:00:00.000Z' },
          { id: '91', kind: 'RESTORED', deletion: null, currentStatus: 'LIVE', action: 'department.reactivated', entityType: 'departments', entityId: '6', description: 'Department "Administration" reactivated.', reason: null, user: 'Asha Admin', createdAt: '2026-11-04T09:01:00.000Z' },
          { id: '92', kind: 'DELETED', deletion: 'PERMANENT', currentStatus: 'PERMANENTLY_DELETED', action: 'client.deleted', entityType: 'clients', entityId: '86', description: 'Client "ABC" deleted.', reason: null, user: 'Asha Admin', createdAt: '2026-11-04T09:03:00.000Z' },
          { id: '93', kind: 'DELETED', deletion: 'RECYCLE_BIN', currentStatus: 'IN_RECYCLE_BIN', action: 'system_type.deleted', entityType: 'system_types', entityId: '12', description: 'System type "HVAC" (HVAC) moved to the Recycle Bin; nothing was removed.', reason: null, user: 'Asha Admin', createdAt: '2026-11-04T09:04:00.000Z' },
        ],
        total: 4,
        page: 1,
        pageSize: 25,
        options: { entityTypes: ['clients', 'departments', 'system_types'], users: [] },
      })
    }

    return undefined
  })
}

describe('Recycle Bin', () => {
  it('lists the records deleted now for Super Admin, of every type, with what is kept', async () => {
    recycleApi(ADMIN)
    renderApp('/admin/deletion-log')

    const panel = (await screen.findByRole('heading', { name: /In the Recycle Bin/ })).closest('section') as HTMLElement
    const contract = (await within(panel).findByText('AMC-0007')).closest('tr') as HTMLElement
    expect(contract).toHaveTextContent('Test Hotel One')
    expect(contract).toHaveTextContent('4 services · 1 invoice · 2 documents')
    expect(contract).toHaveTextContent('Asha Admin')
    // An AMC contract is never deleted permanently: no such button.
    expect(within(contract).queryByRole('button', { name: /Delete permanently/ })).not.toBeInTheDocument()

    const type = within(panel).getByRole('button', { name: 'Delete permanently System type HVAC HVAC' }).closest('tr') as HTMLElement
    expect(type).toHaveTextContent('System type')
    expect(screen.getByText(/Deactivated records are not here/)).toBeInTheDocument()

    await userEvent.click(within(panel).getByRole('tab', { name: /System types/ }))
    await waitFor(() => expect(within(panel).queryByText('AMC-0007')).not.toBeInTheDocument())
  })

  it('restores a contract after checking it, then it leaves the list', async () => {
    const api = recycleApi(ADMIN)
    renderApp('/admin/deletion-log')

    const panel = (await screen.findByRole('heading', { name: /In the Recycle Bin/ })).closest('section') as HTMLElement
    await userEvent.click(await within(panel).findByRole('button', { name: 'Restore AMC contract AMC-0007 Test Hotel One' }))
    let dialog = await screen.findByRole('dialog', { name: 'Restore AMC contract' })
    expect(dialog).toHaveTextContent('same number, services and history')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(api.find('POST', '/security/recycle-bin/amc-contracts/7/restore')).toHaveLength(0)

    await userEvent.click(within(panel).getByRole('button', { name: 'Restore AMC contract AMC-0007 Test Hotel One' }))
    dialog = await screen.findByRole('dialog', { name: 'Restore AMC contract' })
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Restore' })).toBeEnabled())
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restore' }))

    await waitFor(() => expect(api.find('POST', '/security/recycle-bin/amc-contracts/7/restore')).toHaveLength(1))
    expect(await within(panel).findByRole('status')).toHaveTextContent('AMC contract AMC-0007 (Test Hotel One) was restored.')
    await waitFor(() => expect(within(panel).queryByText('AMC-0007')).not.toBeInTheDocument())
  })

  it('shows why a restore is blocked and keeps the Restore button disabled', async () => {
    const api = recycleApi(ADMIN, (request) =>
      request.path === '/security/recycle-bin/amc-contracts/7/check'
        ? ok(check(CONTRACT, { restore: { allowed: false, blockers: ['Its client CL-00003 "Test Hotel One" is in the Recycle Bin. Restore the client first.'], warnings: [] } }))
        : undefined,
    )
    renderApp('/admin/deletion-log')

    await userEvent.click(await screen.findByRole('button', { name: 'Restore AMC contract AMC-0007 Test Hotel One' }))
    const dialog = await screen.findByRole('dialog', { name: 'Restore AMC contract' })

    expect(await within(dialog).findByText(/Restore the client first/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Restore' })).toBeDisabled()
    expect(api.find('POST', '/security/recycle-bin/amc-contracts/7/restore')).toHaveLength(0)
  })

  it('shows the API reason when a restore is refused', async () => {
    recycleApi(ADMIN, (request) =>
      request.method === 'POST' && request.path === '/security/recycle-bin/amc-contracts/7/restore'
        ? fail(409, 'CONFLICT', 'This contract cannot be restored: AMC-0003 has since been renewed as AMC-0009.')
        : undefined,
    )
    renderApp('/admin/deletion-log')

    await userEvent.click(await screen.findByRole('button', { name: 'Restore AMC contract AMC-0007 Test Hotel One' }))
    const dialog = await screen.findByRole('dialog', { name: 'Restore AMC contract' })
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Restore' })).toBeEnabled())
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restore' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('has since been renewed as AMC-0009.')
  })

  it('deletes a never-used record permanently only after its code is typed', async () => {
    const api = recycleApi(ADMIN)
    renderApp('/admin/deletion-log')

    await userEvent.click(await screen.findByRole('button', { name: 'Delete permanently System type HVAC HVAC' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete system type permanently' })
    expect(await within(dialog).findByText(/This cannot be undone/)).toBeInTheDocument()

    const confirm = within(dialog).getByRole('button', { name: 'Delete permanently' })
    expect(confirm).toBeDisabled()
    await userEvent.type(within(dialog).getByLabelText('Type HVAC to confirm'), 'hva')
    expect(confirm).toBeDisabled()
    await userEvent.type(within(dialog).getByLabelText('Type HVAC to confirm'), 'c')
    expect(confirm).toBeEnabled()
    await userEvent.click(confirm)

    await waitFor(() => expect(api.find('DELETE', '/security/recycle-bin/system-types/12')).toHaveLength(1))
    expect(api.find('DELETE', '/security/recycle-bin/system-types/12')[0]?.body).toEqual({ confirm: 'hvac' })
    expect(await screen.findByText('System type HVAC (HVAC) was deleted permanently.')).toBeInTheDocument()
  })

  it('explains why a used record cannot be deleted permanently, and offers no delete button', async () => {
    recycleApi(ADMIN, (request) =>
      request.path === '/security/recycle-bin/system-types/12/check'
        ? ok(check(TYPE, { purge: { allowed: false, reasons: ['It is used by 1 AMC contract (1 in the Recycle Bin).'], confirmText: null } }))
        : undefined,
    )
    renderApp('/admin/deletion-log')

    await userEvent.click(await screen.findByRole('button', { name: 'Delete permanently System type HVAC HVAC' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete system type permanently' })

    expect(await within(dialog).findByText('It is used by 1 AMC contract (1 in the Recycle Bin).')).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Delete permanently' })).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Keep in Recycle Bin' })).toBeInTheDocument()
  })

  it('keeps the Deletion History as its own view, with each record’s status now', async () => {
    recycleApi(ADMIN)
    renderApp('/admin/deletion-log')

    await userEvent.click(await screen.findByRole('tab', { name: 'Deletion History' }))
    const table = await screen.findByRole('table', { name: 'Deletion History' })

    const reactivated = within(table).getByText('Department "Administration" reactivated.').closest('tr') as HTMLElement
    expect(reactivated).toHaveTextContent('Reactivated')
    expect(reactivated).toHaveTextContent('Active')
    const purged = within(table).getByText('Client "ABC" deleted.').closest('tr') as HTMLElement
    expect(purged).toHaveTextContent('Deleted permanently')
    expect(purged).toHaveTextContent('Permanently deleted')
    expect(within(table).getByText(/moved to the Recycle Bin/).closest('tr')).toHaveTextContent('In Recycle Bin')
    expect(screen.queryByRole('heading', { name: /In the Recycle Bin/ })).not.toBeInTheDocument()
  })

  it('shows an Admin who is not Super Admin only the Deletion History, and never asks for the Recycle Bin', async () => {
    const api = recycleApi(ADMIN_ROLE)
    renderApp('/admin/deletion-log')

    expect(await screen.findByRole('heading', { name: 'Recycle Bin' })).toBeInTheDocument()
    expect(await screen.findByRole('table', { name: 'Deletion History' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Recycle Bin' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /In the Recycle Bin/ })).not.toBeInTheDocument()
    expect(api.find('GET', '/security/recycle-bin')).toHaveLength(0)
  })
})

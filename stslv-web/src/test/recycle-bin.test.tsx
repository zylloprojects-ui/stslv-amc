import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { SessionUser } from '../lib/types'
import type { DeletedContract } from '../pages/admin/DeletedContracts'
import { ADMIN, fail, mockApi, ok, renderApp, signIn, type MockRequest, type MockReply } from './helpers'

// AMC Recycle Bin (migration 0101): Super Admin sees deleted AMC contracts and can restore them.

const ADMIN_ROLE: SessionUser = {
  id: '6',
  email: 'admin-role@example.com',
  fullName: 'Ari Admin',
  roles: [{ id: '6', code: 'ADMINISTRATOR', name: 'Admin' }],
  permissions: ['RECYCLE_BIN:VIEW', 'AUDIT_LOG:VIEW', 'AMC_CONTRACTS:VIEW', 'AMC_CONTRACTS:DELETE'],
}

const BINNED: DeletedContract = {
  id: '7',
  amcReference: 'AMC-0007',
  client: { id: '3', name: 'Test Hotel One' },
  systemDescription: 'FIRE',
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
  status: 'ACTIVE',
  contractValue: '1200.000',
  services: 4,
  invoices: 1,
  documents: 2,
  deletedAt: '2026-11-03T06:00:00.000Z',
  deletedBy: 'Asha Admin',
}

function recycleApi(user: SessionUser, handler: (request: MockRequest) => MockReply | undefined = () => undefined) {
  signIn()
  let binned = [BINNED]

  return mockApi((request) => {
    const handled = handler(request)
    if (handled) return handled
    if (request.path === '/auth/me') return ok({ user })
    if (request.path === '/security/recycle-bin/amc-contracts') return ok(binned)
    if (request.method === 'POST' && request.path === '/security/recycle-bin/amc-contracts/7/restore') {
      binned = []
      return ok({ id: '7' })
    }
    if (request.path === '/security/deletions') return ok({ items: [], total: 0, page: 1, pageSize: 25, options: { entityTypes: [], users: [] } })

    return undefined
  })
}

describe('Recycle Bin: deleted AMC contracts', () => {
  it('lists them for Super Admin with what is kept, and restores one after confirmation', async () => {
    const api = recycleApi(ADMIN)
    renderApp('/admin/deletion-log')

    const panel = (await screen.findByRole('heading', { name: /Deleted AMC contracts/ })).closest('section') as HTMLElement
    const row = (await within(panel).findByText('AMC-0007')).closest('tr') as HTMLElement
    expect(row).toHaveTextContent('Test Hotel One')
    expect(row).toHaveTextContent('4 services · 1 invoice · 2 documents')
    expect(row).toHaveTextContent('Asha Admin')
    expect(screen.getByText(/Deleted AMC contracts can be restored by Super Admin/)).toBeInTheDocument()

    await userEvent.click(within(row).getByRole('button', { name: 'Restore AMC-0007 Test Hotel One FIRE' }))
    let dialog = await screen.findByRole('dialog', { name: 'Restore AMC contract' })
    expect(dialog).toHaveTextContent('same number, services and history')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(api.find('POST', '/security/recycle-bin/amc-contracts/7/restore')).toHaveLength(0)

    await userEvent.click(within(row).getByRole('button', { name: 'Restore AMC-0007 Test Hotel One FIRE' }))
    dialog = await screen.findByRole('dialog', { name: 'Restore AMC contract' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restore contract' }))

    await waitFor(() => expect(api.find('POST', '/security/recycle-bin/amc-contracts/7/restore')).toHaveLength(1))
    expect(await within(panel).findByRole('status')).toHaveTextContent('AMC-0007 (Test Hotel One, FIRE) was restored.')
    expect(await within(panel).findByText('No AMC contracts are in the Recycle Bin.')).toBeInTheDocument()
  })

  it('shows the API reason when a restore is refused, and keeps the contract listed', async () => {
    recycleApi(ADMIN, (request) =>
      request.method === 'POST' && request.path === '/security/recycle-bin/amc-contracts/7/restore'
        ? fail(409, 'CONFLICT', 'This contract cannot be restored: AMC-0003 has since been renewed as AMC-0009.')
        : undefined,
    )
    renderApp('/admin/deletion-log')

    await userEvent.click(await screen.findByRole('button', { name: 'Restore AMC-0007 Test Hotel One FIRE' }))
    const dialog = await screen.findByRole('dialog', { name: 'Restore AMC contract' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restore contract' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('has since been renewed as AMC-0009.')
    expect(screen.getByRole('cell', { name: 'AMC-0007' })).toBeInTheDocument()
  })

  it('is not shown or requested for an Admin who is not Super Admin', async () => {
    const api = recycleApi(ADMIN_ROLE)
    renderApp('/admin/deletion-log')

    expect(await screen.findByRole('heading', { name: 'Recycle Bin' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /Deleted AMC contracts/ })).not.toBeInTheDocument()
    expect(api.find('GET', '/security/recycle-bin/amc-contracts')).toHaveLength(0)
  })
})

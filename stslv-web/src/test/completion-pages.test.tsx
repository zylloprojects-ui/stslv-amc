import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { SessionUser } from '../lib/types'
import { ADMIN, mockApi, ok, renderApp, signIn, type MockReply, type MockRequest } from './helpers'

// Reports, Security Center, Deletion Log, Backup & Restore, the consolidated schedule and the Accounts invoice dialog.

function api(user: SessionUser, handler: (request: MockRequest) => MockReply | undefined) {
  signIn()
  return mockApi((request) => (request.path === '/auth/me' ? ok({ user }) : (handler(request) ?? (request.path === '/accounts/options' || request.path === '/amc/calendar/options' ? ok({ clients: [], salesEngineers: [], years: [] }) : request.path === '/amc/contracts/systems' ? ok([]) : ok({ items: [], total: 0, page: 1, pageSize: 50 })))))
}

const OPERATOR: SessionUser = { id: '20', email: 'admin2@example.com', fullName: 'Second Admin', roles: [{ id: '6', code: 'ADMINISTRATOR', name: 'Service Dept' }], permissions: ['USERS:VIEW'] }
const NO_ACCESS: SessionUser = { id: '21', email: 'viewer@example.com', fullName: 'Viewer', roles: [{ id: '7', code: 'VIEWER', name: 'Viewer' }], permissions: ['USERS:VIEW', 'DASHBOARD:VIEW'] }

const REPORT = {
  title: 'AMC Contract Summary',
  columns: [
    { key: 'client', header: 'Client', kind: 'text' },
    { key: 'value', header: 'Contract Value', kind: 'money' },
  ],
  rows: [{ client: 'Alpha Towers', value: '1620.000' }],
  total: 1,
  page: 1,
  pageSize: 50,
  totals: { value: '1620.000' },
  notes: ['An invoice number shows that an invoice was recorded, not that it was paid.'],
}
const CATALOGUE = [
  { id: 'contract-summary', title: 'AMC Contract Summary', description: 'Every contract.', filters: ['dates', 'client', 'engineer'] },
  { id: 'renewal', title: 'AMC Renewal', description: 'Renewals.', filters: ['client'] },
]

describe('Reports', () => {
  it('shows a report with its API total, and follows the chosen report', async () => {
    const calls = api(ADMIN, (request) => (request.path === '/reports' ? ok(CATALOGUE) : request.path === '/reports/options' ? ok({ clients: [], salesEngineers: [], systems: [] }) : request.path.startsWith('/reports/') ? ok(REPORT) : undefined))
    renderApp('/reports')

    expect(await screen.findByRole('heading', { name: 'Reports' })).toBeInTheDocument()
    expect(await screen.findByText('Alpha Towers')).toBeInTheDocument()
    expect(screen.getByText('Total (1)')).toBeInTheDocument()
    expect(screen.getByText(/not that it was paid/)).toBeInTheDocument()

    await userEvent.selectOptions(screen.getByLabelText('Report'), 'renewal')
    await waitFor(() => expect(calls.find('GET', '/reports/renewal').length).toBeGreaterThan(0))
    expect(screen.queryByLabelText('From')).not.toBeInTheDocument()
  })

  it('is closed without the Reports permission', async () => {
    const calls = api(NO_ACCESS, () => undefined)
    renderApp('/reports')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(calls.find('GET', '/reports')).toHaveLength(0)
  })
})

const OVERVIEW = {
  users: { total: 5, active: 4, inactive: 1, pendingApproval: 1, mustChangePassword: 0, activeWithoutRole: 0, administrators: 2 },
  roles: [{ id: '1', code: 'ADMIN', name: 'Super Admin', isActive: true, activeUsers: 1 }],
  signIns30Days: { succeeded: 12, failed: 3 },
  checks: [{ id: 'backup', label: 'Last verified backup', state: 'UNAVAILABLE', detail: 'Backups are not available from this application here.' }],
  configuration: { sessionHours: 8, passwordHashRounds: 12, loginRequestsPer15Min: 50, failedLoginsPer15Min: 5, signUpRequestsPer15Min: 10, temporaryPasswordsPer15Min: 10, allowedWebOrigins: 1, attachmentsConfigured: false, backupsAvailable: false },
}

describe('Security Center and Deletion Log', () => {
  it('shows recorded figures and links, for administrators', async () => {
    api(OPERATOR, (request) => (request.path === '/security/overview' ? ok(OVERVIEW) : request.path === '/security/events' ? ok({ items: [{ id: '9', action: 'auth.login_failed', description: 'Failed sign-in.', user: null, ip: '10.0.0.1', createdAt: '2026-10-31T10:00:00.000Z' }], total: 1, page: 1, pageSize: 20, actions: ['auth.login_failed'] }) : undefined))
    renderApp('/admin/security')

    expect(await screen.findByText('Failed sign-in.')).toBeInTheDocument()
    expect(within(screen.getByRole('navigation', { name: 'Security pages' })).getByRole('link', { name: 'Recycle Bin' })).toHaveAttribute('href', '/admin/deletion-log')
    expect(screen.getByText(/there is no sign-out for other users/)).toBeInTheDocument()
  })

  it('refuses non-administrators, even with Users permission', async () => {
    const calls = api(NO_ACCESS, () => undefined)
    renderApp('/admin/security')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(calls.find('GET', '/security/overview')).toHaveLength(0)
  })

  it('lists removals and sends filters to the API', async () => {
    const calls = api(OPERATOR, (request) =>
      request.path === '/security/deletions'
        ? ok({
            items: [{ id: '1', kind: 'DELETED', action: 'system_type.deleted', entityType: 'system_types', entityId: '4', description: 'System type removed.', reason: null, user: 'Asha', createdAt: '2026-10-31T10:00:00.000Z' }],
            total: 1,
            page: 1,
            pageSize: 25,
            options: { entityTypes: ['system_types'], users: [{ id: '1', fullName: 'Asha' }] },
          })
        : undefined,
    )
    renderApp('/admin/deletion-log')

    expect(await screen.findByText('System type removed.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Recycle Bin' })).toBeInTheDocument()
    expect(screen.queryByText('Deletion Log')).not.toBeInTheDocument()
    // An Admin sees the Deletion History only; the Recycle Bin itself is Super Admin's (migration 0106).
    expect(screen.getByText(/Only Super Admin can open the Recycle Bin itself/)).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'Deletion History' })).toBeInTheDocument()
    // History only: no action on a row.
    expect(screen.queryByRole('button', { name: /restore|recover|undo|empty|delete/i })).not.toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('Action'), 'DELETED')
    await waitFor(() => expect(calls.find('GET', '/security/deletions').at(-1)?.query.get('kind')).toBe('DELETED'))
  })
})

const AVAILABLE = { available: true, unavailableReason: null, automaticSchedule: false, storageConfigured: true, storageDeclaredDurable: false, toolVersion: '17.11', checks: [{ id: 'storage', label: 'Backup storage', state: 'OK', detail: 'A folder is configured.' }] }
const VERIFIED = { id: 'backup_20261031T100000Z_abcd1234', state: 'VERIFIED', startedAt: '2026-10-31T10:00:00.000Z', finishedAt: '2026-10-31T10:00:05.000Z', startedBy: 'Asha', sizeBytes: 2097152, sha256: 'a'.repeat(64), tableEntries: 40, failure: null }

describe('Backup & Restore', () => {
  it('lets Super Admin run and download, and offers no restore', async () => {
    const calls = api(ADMIN, (request) => (request.path === '/security/backups' ? (request.method === 'POST' ? ok({ ...VERIFIED, state: 'RUNNING' }, 202) : ok({ status: AVAILABLE, items: [VERIFIED] })) : undefined))
    renderApp('/admin/backups')

    expect(await screen.findByRole('button', { name: /Download backup/ })).toBeInTheDocument()
    expect(screen.getByText('2.0 MB')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Back up now' }))
    await waitFor(() => expect(calls.find('POST', '/security/backups')).toHaveLength(1))
    expect(screen.getAllByRole('button', { name: /restore/i }).map((button) => button.textContent)).toEqual(['Backup & Restore']) // Only the Settings item: no restore action.
    expect(screen.getByText(/cannot be started from this application/)).toBeInTheDocument()
  })

  it('shows Admin the status only, and says why backups are unavailable', async () => {
    api(OPERATOR, (request) => (request.path === '/security/backups' ? ok({ status: { ...AVAILABLE, available: false, storageConfigured: false, unavailableReason: 'Backup storage is not configured on this server.' }, items: [] }) : undefined))
    renderApp('/admin/backups')

    expect(await screen.findByText(/Backup storage is not configured/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Back up now' })).not.toBeInTheDocument()
  })
})

describe('Consolidated schedule', () => {
  it('shows one row per AMC with its services', async () => {
    api(ADMIN, (request) =>
      request.path === '/amc/visits/monthly-consolidated'
        ? ok({
            items: [
              {
                id: '7',
                reference: 'AMC-0007',
                client: { id: '1', name: 'Alpha Towers' },
                systemDescription: 'FIRE',
                frequency: 'Monthly',
                salesEngineer: 'Raghu',
                services: [
                  { id: '1', serviceCode: 'M1', sequenceNo: 1, scheduledDate: '2026-10-01', status: 'COMPLETED', visitValue: '100.000', invoiceNumbers: ['INV-1'] },
                  { id: '2', serviceCode: 'M2', sequenceNo: 2, scheduledDate: '2026-10-15', status: 'SCHEDULED', visitValue: '100.000', invoiceNumbers: [] },
                ],
                totalValue: '200.000',
              },
            ],
            total: 1,
            page: 1,
            pageSize: 50,
            totals: { contracts: 1, services: 2, completed: 1, totalValue: '200.000' },
          })
        : undefined,
    )
    renderApp('/amc/schedule')

    await userEvent.click(await screen.findByRole('button', { name: 'Monthly by AMC' }))
    const table = within(await screen.findByRole('table', { name: 'Consolidated monthly schedule' }))
    expect(table.getAllByText('AMC-0007')).toHaveLength(1)
    expect(table.getByText('M1')).toBeInTheDocument()
    expect(table.getByText('M2')).toBeInTheDocument()
  })
})


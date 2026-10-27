import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { SessionUser } from '../lib/types'
import type { MaintenanceFrequencyRule } from '../pages/masters/maintenanceFrequencyTypes'
import type { Department, MasterSummary, SystemType } from '../pages/masters/masterTypes'
import { ACCOUNTANT, ADMIN, fail, makeClient, mockApi, ok, renderApp, signIn, type MockReply, type MockRequest } from './helpers'

// Master Data Center hub, its navigation and the three list pages it adds
// (System Types, Maintenance Frequencies, Departments). Every record is invented.

const SETTINGS_VIEWER: SessionUser = { ...ADMIN, id: '9', roles: [{ id: '9', code: 'CUSTOM', name: 'Custom' }], permissions: ['DASHBOARD:VIEW', 'SETTINGS:VIEW'] }
const NO_MASTERS: SessionUser = { ...ADMIN, id: '8', roles: [{ id: '8', code: 'CUSTOM', name: 'Custom' }], permissions: ['DASHBOARD:VIEW'] }

const stamp = { createdAt: '2026-10-20T08:00:00.000Z', updatedAt: '2026-10-20T08:00:00.000Z' }
const TYPE: SystemType = { id: '7', code: 'FA', name: 'Fire alarm', description: null, sortOrder: 1, contractCount: 0, isActive: true, ...stamp }
const DEPARTMENT: Department = { id: '1', code: 'AMC', name: 'AMC Team', description: null, engineerCount: 1, isActive: true, ...stamp }
// As GET /api/masters/maintenance-frequencies returns them (migration 0076).
const frequency = (id: string, code: string, label: string, intervalMonths: number, contractCount = 0, isActive = true): MaintenanceFrequencyRule => ({
  id,
  code,
  label,
  name: label,
  isCustom: false,
  serviceCount: 12 / intervalMonths,
  intervalMonths,
  codePrefix: code.slice(0, 1),
  ruleSummary: `${12 / intervalMonths} services · every ${intervalMonths} months`,
  sortOrder: Number(id),
  status: isActive ? 'active' : 'disabled',
  isActive,
  archivedAt: null,
  ruleLocked: contractCount > 0,
  engineSupported: true,
  contractCount,
  activeContractCount: contractCount,
  ...stamp,
})
const FREQUENCIES = [frequency('1', 'MONTHLY', 'Monthly', 1), frequency('2', 'QUARTERLY', 'Quarterly', 3, 4), frequency('3', 'HALF_YEARLY', 'Half-yearly', 6), frequency('4', 'ANNUALLY', 'Annually', 12, 0, false)]

const SUMMARY: MasterSummary = {
  categories: [
    { key: 'clients', available: true, activeCount: 12 },
    { key: 'sales-engineers', available: true, activeCount: 3 },
    { key: 'system-types', available: true, activeCount: 5 },
    { key: 'maintenance-frequencies', available: true, activeCount: 0 },
    { key: 'departments', available: true, activeCount: 2 },
  ],
}

function hubApi(user: SessionUser = ADMIN, override?: (request: MockRequest) => MockReply | undefined) {
  signIn()
  const frequencies = FREQUENCIES.map((item) => ({ ...item }))

  return mockApi((request) => {
    const overridden = override?.(request)
    if (overridden) return overridden
    const { method, path, body } = request
    if (path === '/auth/me') return ok({ user })
    if (method === 'GET' && path === '/masters/summary') return ok(SUMMARY)
    if (path === '/clients/features') return ok({ clientDetails: true })
    if (method === 'GET' && path === '/clients') return ok({ items: [makeClient({ id: '10', name: 'Alpha Test Co' })], total: 1, page: 1, pageSize: 25 })
    if (method === 'GET' && path === '/masters/sales-engineers') return ok({ items: [], total: 0, page: 1, pageSize: 25 })
    if (method === 'GET' && path === '/masters/system-types') return ok({ items: [TYPE], total: 1, page: 1, pageSize: 25 })
    if (method === 'GET' && path === '/masters/departments') return ok({ items: [DEPARTMENT], total: 1, page: 1, pageSize: 25 })
    if (method === 'GET' && path === '/masters/maintenance-frequencies') return ok({ items: frequencies, total: frequencies.length, page: 1, pageSize: 25 })
    const one = /^\/masters\/maintenance-frequencies\/(\d+)(\/status)?$/.exec(path)
    if (one) {
      const index = frequencies.findIndex((item) => item.id === one[1])
      const found = frequencies[index] as MaintenanceFrequencyRule
      const status = (body as { status?: MaintenanceFrequencyRule['status'] }).status ?? found.status
      const name = (body as { name?: string }).name ?? found.name
      const saved = one[2] ? { ...found, status, isActive: status === 'active' } : { ...found, label: name, name }
      frequencies[index] = saved

      return ok(saved)
    }

    return undefined
  })
}

const cards = () => within(screen.getByRole('list', { name: 'Master data modules' })).getAllByRole('link')

describe('Master Data Center hub', () => {
  it('shows the five modules with their live active counts, each linking to its own page', async () => {
    const api = hubApi()
    renderApp('/master-data')

    expect(await screen.findByRole('heading', { name: 'Master Data Center', level: 1 })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('link', { name: 'Clients: 12 active' })).toBeInTheDocument())

    expect(cards().map((card) => [card.getAttribute('aria-label'), card.getAttribute('href')])).toEqual([
      ['Clients: 12 active', '/clients'],
      ['Sales Engineers: 3 active', '/master-data/sales-engineers'],
      ['System Types: 5 active', '/master-data/system-types'],
      // A real zero is shown as zero.
      ['Maintenance Frequencies: 0 active', '/master-data/maintenance-frequencies'],
      ['Departments: 2 active', '/master-data/departments'],
    ])
    expect(within(cards()[2] as HTMLElement).getByText('The kinds of system an AMC contract covers.')).toBeInTheDocument()
    expect(api.find('GET', '/masters/summary')).toHaveLength(1)
  })

  it('says a database update is required instead of showing zero for a list that is not set up yet', async () => {
    hubApi(ADMIN, (request) =>
      request.path === '/masters/summary'
        ? ok({
            categories: SUMMARY.categories.map((category) =>
              category.key === 'clients' ? category : { ...category, available: false, activeCount: null },
            ),
          })
        : undefined,
    )
    renderApp('/master-data')

    await waitFor(() => expect(screen.getByRole('link', { name: 'Clients: 12 active' })).toBeInTheDocument())
    expect(screen.getAllByText('Database update required')).toHaveLength(4)
    expect(screen.getByRole('link', { name: 'Maintenance Frequencies: database update required' })).toHaveAttribute('href', '/master-data/maintenance-frequencies')
    expect(screen.queryByText('0')).not.toBeInTheDocument()
  })

  it('shows loading, then an error with a retry, and keeps the cards usable', async () => {
    let failing = true
    const api = hubApi(ADMIN, (request) => (request.path === '/masters/summary' && failing ? fail(500, 'INTERNAL_ERROR', 'Something went wrong.') : undefined))
    renderApp('/master-data')

    expect(await screen.findAllByText('Loading count…')).toHaveLength(5)
    expect(await screen.findByText(/The record counts could not be loaded/)).toBeInTheDocument()
    expect(screen.getAllByText('Count not available')).toHaveLength(5)
    expect(screen.getByRole('link', { name: 'Departments: open' })).toHaveAttribute('href', '/master-data/departments')

    failing = false
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getByRole('link', { name: 'Departments: 2 active' })).toBeInTheDocument())
    expect(api.find('GET', '/masters/summary')).toHaveLength(2)
  })

  it('offers only the modules the role may open', async () => {
    // The Accountant may view clients but not Settings.
    hubApi(ACCOUNTANT, (request) => (request.path === '/masters/summary' ? ok({ categories: [SUMMARY.categories[0]] }) : undefined))
    renderApp('/master-data')

    await waitFor(() => expect(cards()).toHaveLength(1))
    expect(cards()[0]).toHaveAttribute('href', '/clients')
  })

  it('is refused to a role that may open none of the modules, without asking for counts', async () => {
    const api = hubApi(NO_MASTERS)
    renderApp('/master-data')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(api.find('GET', '/masters/summary')).toHaveLength(0)
  })

  it('lays the cards out one per row on a phone and in more columns on wider screens', async () => {
    hubApi()
    renderApp('/master-data')

    const list = await screen.findByRole('list', { name: 'Master data modules' })
    // No base column count: a single column below the sm breakpoint.
    expect(list.className).toMatch(/(^|\s)grid(\s|$)/)
    expect(list.className).toContain('sm:grid-cols-2')
    expect(list.className).toContain('xl:grid-cols-3')
    expect(list.className).not.toMatch(/(^|\s)grid-cols-/)
  })
})

describe('Master Data Center navigation', () => {
  it('opens the hub from the sidebar heading, and each card opens its management page', async () => {
    hubApi()
    renderApp('/dashboard')

    const nav = await screen.findByRole('navigation', { name: 'Main' })
    await userEvent.click(within(nav).getByRole('link', { name: 'Master Data Center' }))

    expect(await screen.findByRole('heading', { name: 'Master Data Center', level: 1 })).toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: 'Master Data Center' })).toHaveAttribute('aria-current', 'page')
    // Opening the hub also opens its group, so the five pages are one click away.
    expect(within(nav).getByRole('button', { name: 'Master Data Center pages' })).toHaveAttribute('aria-expanded', 'true')

    const pages: [string, string][] = [
      ['Clients', 'Clients'],
      ['Sales Engineers', 'Sales Engineers'],
      ['System Types', 'System Types'],
      ['Maintenance Frequencies', 'Maintenance Frequencies'],
      ['Departments', 'Departments'],
    ]

    for (const [card, heading] of pages) {
      await userEvent.click(within(nav).getByRole('link', { name: 'Master Data Center' }))
      await screen.findByRole('list', { name: 'Master data modules' })
      await userEvent.click(await screen.findByRole('link', { name: new RegExp(`^${card}: `) }))
      expect(await screen.findByRole('heading', { name: heading, level: 1 })).toBeInTheDocument()
      expect(within(nav).getByRole('link', { name: card })).toHaveAttribute('aria-current', 'page')
    }
  })

  it('keeps the group toggle separate from the hub link', async () => {
    hubApi()
    renderApp('/dashboard')

    const nav = await screen.findByRole('navigation', { name: 'Main' })
    const toggle = within(nav).getByRole('button', { name: 'Master Data Center pages' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(within(nav).getByRole('link', { name: 'Departments' })).toHaveAttribute('href', '/master-data/departments')
    // Only the group opened: the page did not change.
    expect(screen.queryByRole('heading', { name: 'Master Data Center', level: 1 })).not.toBeInTheDocument()
  })

  it('reaches the hub from the phone menu', async () => {
    hubApi()
    renderApp('/dashboard')

    await userEvent.click(await screen.findByRole('button', { name: 'Open menu' }))
    const menu = await screen.findByRole('dialog', { name: 'Menu' })
    await userEvent.click(within(menu).getByRole('link', { name: 'Master Data Center' }))

    expect(await screen.findByRole('heading', { name: 'Master Data Center', level: 1 })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('sends the former System Types & Departments address to the hub', async () => {
    hubApi()
    renderApp('/admin/master-data')

    expect(await screen.findByRole('heading', { name: 'Master Data Center', level: 1 })).toBeInTheDocument()
  })
})

describe('master list pages', () => {
  it('gives System Types and Departments a page each', async () => {
    hubApi()
    renderApp('/master-data/system-types')

    expect(await screen.findByRole('heading', { name: 'System Types', level: 1 })).toBeInTheDocument()
    expect(within(await screen.findByRole('table', { name: 'System types' })).getByText('Fire alarm')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add System Type' })).toBeInTheDocument()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
  })

  it('lists departments as the master list, not as roles', async () => {
    hubApi()
    renderApp('/master-data/departments')

    expect(await screen.findByRole('heading', { name: 'Departments', level: 1 })).toBeInTheDocument()
    expect(screen.getByText(/Not the same as user roles/)).toBeInTheDocument()
    expect(within(await screen.findByRole('table', { name: 'Departments' })).getByText('AMC Team')).toBeInTheDocument()
  })

  it('opens the dedicated Maintenance Frequencies page with each rule', async () => {
    hubApi()
    renderApp('/master-data/maintenance-frequencies')

    expect(await screen.findByRole('heading', { name: 'Maintenance Frequencies', level: 1 })).toBeInTheDocument()
    const table = await screen.findByRole('table', { name: 'Maintenance frequencies' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(4)
    expect(within(rows[1] as HTMLElement).getByText('QUARTERLY')).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('4 services · every 3 months')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Add Frequency' }).length).toBeGreaterThan(0)
  })

  it('edits the name of a frequency', async () => {
    const api = hubApi()
    renderApp('/master-data/maintenance-frequencies')

    await screen.findByRole('table', { name: 'Maintenance frequencies' })
    await userEvent.click(screen.getByRole('button', { name: 'Edit Quarterly' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit Quarterly' })

    await userEvent.clear(within(dialog).getByLabelText(/Frequency name/))
    await userEvent.type(within(dialog).getByLabelText(/Frequency name/), 'Every quarter')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(api.find('PATCH', '/masters/maintenance-frequencies/2')).toHaveLength(1))
    expect(api.find('PATCH', '/masters/maintenance-frequencies/2')[0]?.body).toEqual({ name: 'Every quarter' })
    expect(await screen.findByRole('status')).toHaveTextContent('Every quarter was updated.')
  })

  it('activates a disabled frequency with Apply', async () => {
    const api = hubApi()
    renderApp('/master-data/maintenance-frequencies')

    await screen.findByRole('table', { name: 'Maintenance frequencies' })
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status of Annually' }), 'active')
    await userEvent.click(screen.getByRole('button', { name: 'Apply Active to Annually' }))

    await waitFor(() => expect(api.find('POST', '/masters/maintenance-frequencies/4/status')).toHaveLength(1))
    expect(api.find('POST', '/masters/maintenance-frequencies/4/status')[0]?.body).toEqual({ status: 'active' })
  })

  it('says which database update a list needs before it is applied', async () => {
    hubApi(ADMIN, (request) =>
      request.path === '/masters/maintenance-frequencies' ? fail(503, 'FEATURE_UNAVAILABLE', 'This feature needs a database update that has not been applied yet.') : undefined,
    )
    renderApp('/master-data/maintenance-frequencies')

    expect(await screen.findByText(/Database update required: Maintenance Frequencies needs migration 0076/)).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('shows an empty list with no add button to a view-only role', async () => {
    hubApi(SETTINGS_VIEWER, (request) => (request.path === '/masters/system-types' ? ok({ items: [], total: 0, page: 1, pageSize: 25 }) : undefined))
    renderApp('/master-data/system-types')

    expect(await screen.findByText('No system types yet')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add System Type' })).not.toBeInTheDocument()
  })

  it('refuses the list pages to a role without Settings access', async () => {
    const api = hubApi(ACCOUNTANT)
    renderApp('/master-data/departments')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(api.find('GET', '/masters/departments')).toHaveLength(0)
  })
})

import { QueryClient } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppProviders } from '../App'
import type { SessionUser } from '../lib/types'
import { MaintenanceFrequenciesPage } from '../pages/masters/MaintenanceFrequenciesPage'
import type { MaintenanceFrequencyRule } from '../pages/masters/maintenanceFrequencyTypes'
import { ADMIN, fail, mockApi, ok, signIn, type MockReply, type MockRequest } from './helpers'

// The Maintenance Frequencies page. It is rendered on its own here: its route
// is added in App.tsx as a separate, approved step. Every record is invented.

const CONTRACT_VIEWER: SessionUser = { ...ADMIN, id: '9', roles: [{ id: '9', code: 'EXECUTION', name: 'Execution' }], permissions: ['DASHBOARD:VIEW', 'AMC_CONTRACTS:VIEW'] }

const stamp = { createdAt: '2026-10-20T08:00:00.000Z', updatedAt: '2026-10-21T08:00:00.000Z' }

function frequency(overrides: Partial<MaintenanceFrequencyRule>): MaintenanceFrequencyRule {
  return {
    id: '1',
    code: 'MONTHLY',
    name: 'Monthly',
    label: 'Monthly',
    isCustom: false,
    serviceCount: 12,
    intervalMonths: 1,
    codePrefix: 'M',
    ruleSummary: '12 services · every month',
    sortOrder: 1,
    status: 'active',
    isActive: true,
    archivedAt: null,
    ruleLocked: false,
    engineSupported: true,
    contractCount: 0,
    activeContractCount: 0,
    ...stamp,
    ...overrides,
  }
}

const QUARTERLY = frequency({
  id: '2',
  code: 'QUARTERLY',
  name: 'Quarterly',
  label: 'Quarterly',
  serviceCount: 4,
  intervalMonths: 3,
  codePrefix: 'Q',
  ruleSummary: '4 services · every 3 months',
  sortOrder: 2,
  ruleLocked: true,
  contractCount: 5,
  activeContractCount: 3,
})
const ANNUALLY = frequency({ id: '4', code: 'ANNUALLY', name: 'Annually', label: 'Annually', serviceCount: 1, intervalMonths: 12, codePrefix: 'A', ruleSummary: '1 service · every 12 months', sortOrder: 4 })
const CUSTOM = frequency({
  id: '7',
  code: 'CUSTOM',
  name: 'Custom',
  label: 'Custom',
  isCustom: true,
  serviceCount: null,
  intervalMonths: null,
  codePrefix: 'C',
  ruleSummary: 'Months chosen on each contract',
  sortOrder: 7,
  status: 'disabled',
  isActive: false,
  engineSupported: false,
})

const PATH = '/masters/maintenance-frequencies'

function frequenciesApi(user: SessionUser, items: MaintenanceFrequencyRule[], override?: (request: MockRequest) => MockReply | undefined) {
  signIn()

  return mockApi((request) => {
    const overridden = override?.(request)
    if (overridden) return overridden
    if (request.path === '/auth/me') return ok({ user })
    if (request.method === 'GET' && request.path === PATH) return ok({ items, total: items.length, page: 1, pageSize: 25 })

    return undefined
  })
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(
    <MemoryRouter>
      <AppProviders client={client}>
        <MaintenanceFrequenciesPage />
      </AppProviders>
    </MemoryRouter>,
  )
}

const table = () => screen.findByRole('table', { name: 'Maintenance frequencies' })
/** The body row whose frequency name is exactly `name`. */
async function rowOf(name: string): Promise<HTMLElement> {
  const rows = within(await table()).getAllByRole('row').slice(1)
  const row = rows.find((candidate) => within(candidate).queryByText(name, { exact: true }) !== null)
  if (!row) throw new Error(`No row for ${name}`)
  return row
}

afterEach(() => {
  try {
    localStorage.clear()
  } catch {
    // Storage may be unavailable.
  }
})

describe('list', () => {
  it('shows a clear empty state with an add action', async () => {
    frequenciesApi(ADMIN, [])
    renderPage()

    expect(await screen.findByText('No maintenance frequencies yet')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Add Frequency' }).length).toBeGreaterThan(0)
  })

  it('shows every column, the rule, the counts, and no delete action', async () => {
    frequenciesApi(ADMIN, [QUARTERLY, CUSTOM])
    renderPage()

    const rows = within(await table()).getAllByRole('row')
    expect(within(rows[0] as HTMLElement).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      '#',
      'Frequency',
      'Internal code',
      'Rule',
      'Services / year',
      'Interval',
      'Prefix',
      'Sort order',
      'Status',
      'Active AMC',
      'Total AMC',
      'Actions',
    ])

    const quarterly = await rowOf('Quarterly')
    expect(within(quarterly).getByText('4 services · every 3 months')).toBeInTheDocument()
    expect(within(quarterly).getByText('Rule locked: in use')).toBeInTheDocument()
    expect(within(quarterly).getByText('3 months')).toBeInTheDocument()
    expect(within(quarterly).getByRole('button', { name: /3 active/ })).toHaveTextContent('3')
    expect(within(quarterly).getByRole('button', { name: /View the 5 AMC contracts/ })).toHaveTextContent('5')

    const custom = await rowOf('Custom')
    expect(within(custom).getByText('Custom months')).toBeInTheDocument()
    expect(within(custom).getByText('Schedule engine support pending')).toBeInTheDocument()
    expect(within(custom).getAllByText('—')).toHaveLength(2)

    expect(screen.queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument()
  })

  it('sends search, status and sort to the API, and the same filters to the export', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:test', revokeObjectURL: () => undefined }))
    const api = frequenciesApi(ADMIN, [QUARTERLY], (request) => (request.path === `${PATH}/export` ? ok('file') : undefined))
    renderPage()
    await table()

    // Active and disabled by default, in the API's own order.
    const first = api.find('GET', PATH)[0]?.query
    expect([first?.get('status'), first?.get('sort')]).toEqual(['current', null])

    await userEvent.type(screen.getByLabelText('Search'), 'BM')
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'archived')
    await userEvent.selectOptions(screen.getByLabelText('Sort'), 'interval-asc')
    await waitFor(() => {
      const query = api.find('GET', PATH).at(-1)?.query
      expect([query?.get('search'), query?.get('status'), query?.get('sort'), query?.get('direction')]).toEqual(['BM', 'archived', 'intervalMonths', 'asc'])
    })

    await userEvent.click(screen.getByRole('button', { name: 'Export maintenance frequencies to Excel' }))
    await waitFor(() => expect(api.find('GET', `${PATH}/export`)).toHaveLength(1))
    const query = api.find('GET', `${PATH}/export`)[0]?.query
    expect([query?.get('format'), query?.get('search'), query?.get('status'), query?.get('sort')]).toEqual(['xlsx', 'BM', 'archived', 'intervalMonths'])

    await userEvent.click(screen.getByRole('button', { name: 'Export maintenance frequencies to PDF' }))
    await waitFor(() => expect(api.find('GET', `${PATH}/export`)).toHaveLength(2))
    expect(api.find('GET', `${PATH}/export`)[1]?.query.get('format')).toBe('pdf')
  })

  it('pages through the list', async () => {
    const api = frequenciesApi(ADMIN, [], (request) =>
      request.method === 'GET' && request.path === PATH
        ? ok({ items: [request.query.get('page') === '2' ? CUSTOM : QUARTERLY], total: 26, page: Number(request.query.get('page')), pageSize: 25 })
        : undefined,
    )
    renderPage()
    await rowOf('Quarterly')

    await userEvent.click(screen.getByRole('button', { name: /Next/ }))
    await waitFor(() => expect(api.find('GET', PATH).at(-1)?.query.get('page')).toBe('2'))
    expect(await rowOf('Custom')).toBeTruthy()
  })

  it('hides and shows optional columns, but never the name', async () => {
    frequenciesApi(ADMIN, [QUARTERLY])
    renderPage()
    const list = await table()

    await userEvent.click(screen.getByRole('button', { name: /Columns/ }))
    expect(screen.queryByRole('checkbox', { name: 'Frequency' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('checkbox', { name: 'Prefix' }))

    expect(within(list).queryByRole('columnheader', { name: 'Prefix' })).not.toBeInTheDocument()
    expect(within(list).getByRole('columnheader', { name: 'Frequency' })).toBeInTheDocument()
  })

  it('explains that the database update is needed when migration 0076 is absent', async () => {
    frequenciesApi(ADMIN, [], (request) =>
      request.path === PATH ? fail(503, 'FEATURE_UNAVAILABLE', 'This feature needs a database update that has not been applied yet.') : undefined,
    )
    renderPage()

    expect(await screen.findByText(/Maintenance Frequencies needs migration 0076/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add Frequency' })).not.toBeInTheDocument()
  })

  it('shows a load error with a retry', async () => {
    frequenciesApi(ADMIN, [], (request) => (request.path === PATH ? fail(500, 'INTERNAL_ERROR', 'An unexpected error occurred.') : undefined))
    renderPage()

    expect(await screen.findByText(/An unexpected error occurred/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('opens the linked contracts of a frequency', async () => {
    frequenciesApi(ADMIN, [QUARTERLY], (request) =>
      request.path === `${PATH}/2/contracts`
        ? ok({
            items: [{ id: '31', client: { id: '5', name: 'Harbour Clinic' }, systemDescription: 'Fire alarm', frequency: { code: 'QUARTERLY', name: 'Quarterly' }, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'ACTIVE' }],
            total: 1,
            activeTotal: 1,
            page: 1,
            pageSize: 10,
          })
        : undefined,
    )
    renderPage()

    await userEvent.click(within(await rowOf('Quarterly')).getByRole('button', { name: /3 active/ }))
    const dialog = await screen.findByRole('dialog', { name: 'AMC contracts using Quarterly' })
    expect(await within(dialog).findByText('Harbour Clinic')).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: 'Contract #31' })).toHaveAttribute('href', '/amc/contracts/31')
  })
})

describe('form', () => {
  const openCreate = async () => {
    await table().catch(() => undefined)
    await userEvent.click(screen.getAllByRole('button', { name: 'Add Frequency' })[0] as HTMLElement)
    return screen.findByRole('dialog', { name: 'Add Maintenance Frequency' })
  }

  it('checks required fields and the fixed rule before sending anything', async () => {
    const api = frequenciesApi(ADMIN, [QUARTERLY])
    renderPage()
    const dialog = await openCreate()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Add frequency' }))
    expect(within(dialog).getByText('Enter a name.')).toBeInTheDocument()
    expect(within(dialog).getByText('Enter an internal code.')).toBeInTheDocument()
    expect(within(dialog).getByText('Enter a service code prefix.')).toBeInTheDocument()
    expect(within(dialog).getByText('Select the months between services.')).toBeInTheDocument()

    await userEvent.type(within(dialog).getByLabelText(/Frequency name/), 'Quarterly alt')
    await userEvent.type(within(dialog).getByLabelText(/Internal code/), 'quarterly alt')
    expect(within(dialog).getByLabelText(/Internal code/)).toHaveValue('QUARTERLY_ALT')
    await userEvent.type(within(dialog).getByLabelText(/Service code prefix/), 'qa')
    await userEvent.selectOptions(within(dialog).getByLabelText(/Interval/), '3')
    // Choosing an interval fills the only consistent count.
    expect(within(dialog).getByLabelText(/Services per year/)).toHaveValue('4')
    await userEvent.clear(within(dialog).getByLabelText(/Services per year/))
    await userEvent.type(within(dialog).getByLabelText(/Services per year/), '3')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add frequency' }))

    expect(within(dialog).getByText('With a 3-month interval, services per year must be 4.')).toBeInTheDocument()
    expect(api.find('POST', PATH)).toHaveLength(0)
  })

  it('creates a fixed frequency', async () => {
    const api = frequenciesApi(ADMIN, [], (request) => (request.method === 'POST' && request.path === PATH ? ok({ ...ANNUALLY, id: '9' }, 201) : undefined))
    renderPage()
    const dialog = await openCreate()

    await userEvent.type(within(dialog).getByLabelText(/Frequency name/), 'Annually')
    await userEvent.type(within(dialog).getByLabelText(/Internal code/), 'annually')
    await userEvent.type(within(dialog).getByLabelText(/Service code prefix/), 'a')
    await userEvent.selectOptions(within(dialog).getByLabelText(/Interval/), '12')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add frequency' }))

    await waitFor(() => expect(api.find('POST', PATH)).toHaveLength(1))
    expect(api.find('POST', PATH)[0]?.body).toEqual({ name: 'Annually', code: 'ANNUALLY', codePrefix: 'A', isCustom: false, serviceCount: 1, intervalMonths: 12, status: 'active' })
    expect(await screen.findByText('Annually was added as Active.')).toBeInTheDocument()
  })

  it('in custom mode hides the numbers and never sends values typed before switching', async () => {
    const api = frequenciesApi(ADMIN, [], (request) => (request.method === 'POST' && request.path === PATH ? ok({ ...CUSTOM, id: '9', name: 'Seasonal' }, 201) : undefined))
    renderPage()
    const dialog = await openCreate()

    await userEvent.type(within(dialog).getByLabelText(/Frequency name/), 'Seasonal')
    await userEvent.type(within(dialog).getByLabelText(/Internal code/), 'SEASONAL')
    await userEvent.type(within(dialog).getByLabelText(/Service code prefix/), 'SE')
    await userEvent.selectOptions(within(dialog).getByLabelText(/Interval/), '3')
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /Custom month-selection frequency/ }))

    expect(within(dialog).queryByLabelText(/Interval/)).not.toBeInTheDocument()
    expect(within(dialog).queryByLabelText(/Services per year/)).not.toBeInTheDocument()
    expect(within(dialog).getByText(/chosen on each AMC contract/)).toBeInTheDocument()

    await userEvent.selectOptions(within(dialog).getByLabelText('Status'), 'disabled')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add frequency' }))

    await waitFor(() => expect(api.find('POST', PATH)).toHaveLength(1))
    expect(api.find('POST', PATH)[0]?.body).toMatchObject({ isCustom: true, serviceCount: null, intervalMonths: null, status: 'disabled' })
  })

  it('creates an active frequency on a new interval, now that the schedule engine generates it', async () => {
    const api = frequenciesApi(ADMIN, [], (request) => (request.method === 'POST' && request.path === PATH ? ok({ ...ANNUALLY, id: '9', name: 'Every 2' }, 201) : undefined))
    renderPage()
    const dialog = await openCreate()

    await userEvent.type(within(dialog).getByLabelText(/Frequency name/), 'Every 2')
    await userEvent.type(within(dialog).getByLabelText(/Internal code/), 'EVERY_2')
    await userEvent.type(within(dialog).getByLabelText(/Service code prefix/), 'E')
    await userEvent.selectOptions(within(dialog).getByLabelText(/Interval/), '2')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add frequency' }))

    await waitFor(() => expect(api.find('POST', PATH)).toHaveLength(1))
    expect(api.find('POST', PATH)[0]?.body).toMatchObject({ code: 'EVERY_2', serviceCount: 6, intervalMonths: 2, status: 'active' })
  })

  it('shows a duplicate prefix from the server on the prefix field', async () => {
    frequenciesApi(ADMIN, [], (request) =>
      request.method === 'POST' && request.path === PATH
        ? fail(409, 'CONFLICT', 'The service code prefix "T" is already used by another frequency.', [{ field: 'codePrefix', message: 'The service code prefix "T" is already used by another frequency.' }])
        : undefined,
    )
    renderPage()
    const dialog = await openCreate()

    await userEvent.type(within(dialog).getByLabelText(/Frequency name/), 'Four monthly')
    await userEvent.type(within(dialog).getByLabelText(/Internal code/), 'FOUR_MONTHLY')
    await userEvent.type(within(dialog).getByLabelText(/Service code prefix/), 't')
    await userEvent.selectOptions(within(dialog).getByLabelText(/Interval/), '12')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add frequency' }))

    const prefix = within(dialog).getByLabelText(/Service code prefix/)
    await waitFor(() => expect(prefix).toHaveAttribute('aria-invalid', 'true'))
  })

  it('locks the code and rule of a frequency in use, and sends only the name', async () => {
    const api = frequenciesApi(ADMIN, [QUARTERLY], (request) => (request.method === 'PATCH' && request.path === `${PATH}/2` ? ok({ ...QUARTERLY, name: 'Quarterly service' }) : undefined))
    renderPage()

    await userEvent.click(within(await rowOf('Quarterly')).getByRole('button', { name: 'Edit Quarterly' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit Quarterly' })

    expect(within(dialog).getByText(/5 AMC contracts use this frequency/)).toBeInTheDocument()
    for (const label of [/Internal code/, /Service code prefix/, /Interval/, /Services per year/]) {
      expect(within(dialog).getByLabelText(label)).toBeDisabled()
    }
    expect(within(dialog).getByRole('checkbox', { name: /Custom month-selection/ })).toBeDisabled()

    await userEvent.clear(within(dialog).getByLabelText(/Frequency name/))
    await userEvent.type(within(dialog).getByLabelText(/Frequency name/), 'Quarterly service')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(api.find('PATCH', `${PATH}/2`)).toHaveLength(1))
    expect(api.find('PATCH', `${PATH}/2`)[0]?.body).toEqual({ name: 'Quarterly service' })
  })
})

describe('status', () => {
  it('applies a status only on Apply, and Cancel restores the stored one', async () => {
    const api = frequenciesApi(ADMIN, [ANNUALLY], (request) => (request.method === 'POST' && request.path === `${PATH}/4/status` ? ok({ ...ANNUALLY, status: 'archived', isActive: false, archivedAt: '2026-10-27T00:00:00.000Z' }) : undefined))
    renderPage()

    const select = within(await rowOf('Annually')).getByRole('combobox', { name: 'Status of Annually' })
    await userEvent.selectOptions(select, 'disabled')
    await userEvent.click(screen.getByRole('button', { name: 'Keep Annually Active' }))
    expect(select).toHaveValue('active')
    expect(api.find('POST', `${PATH}/4/status`)).toHaveLength(0)

    // Unused: no warning, no confirmation sent.
    await userEvent.selectOptions(select, 'archived')
    await userEvent.click(screen.getByRole('button', { name: 'Apply Archived to Annually' }))
    await waitFor(() => expect(api.find('POST', `${PATH}/4/status`)).toHaveLength(1))
    expect(api.find('POST', `${PATH}/4/status`)[0]?.body).toEqual({ status: 'archived' })
    expect(await screen.findByText(/Annually is now Archived/)).toBeInTheDocument()
  })

  it('warns with the active contract count before disabling a frequency in use, then confirms', async () => {
    const api = frequenciesApi(ADMIN, [QUARTERLY], (request) => (request.method === 'POST' && request.path === `${PATH}/2/status` ? ok({ ...QUARTERLY, status: 'disabled', isActive: false }) : undefined))
    renderPage()

    await userEvent.selectOptions(within(await rowOf('Quarterly')).getByRole('combobox', { name: 'Status of Quarterly' }), 'disabled')
    await userEvent.click(screen.getByRole('button', { name: 'Apply Disabled to Quarterly' }))

    const dialog = await screen.findByRole('dialog', { name: 'Disable Quarterly?' })
    expect(within(dialog).getByText(/3 active AMC contracts use this frequency/)).toBeInTheDocument()
    expect(within(dialog).getByText(/no scheduled or completed visit changes/)).toBeInTheDocument()
    expect(api.find('POST', `${PATH}/2/status`)).toHaveLength(0)

    await userEvent.click(within(dialog).getByRole('button', { name: 'Disable' }))
    await waitFor(() => expect(api.find('POST', `${PATH}/2/status`)).toHaveLength(1))
    expect(api.find('POST', `${PATH}/2/status`)[0]?.body).toEqual({ status: 'disabled', confirm: true })
  })

  it('does not offer Active when the API reports the engine cannot generate the rule', async () => {
    frequenciesApi(ADMIN, [CUSTOM])
    renderPage()

    const select = within(await rowOf('Custom')).getByRole('combobox', { name: 'Status of Custom' })
    expect(within(select).getByRole('option', { name: 'Active' })).toBeDisabled()
  })
})

describe('permissions', () => {
  it('shows a read-only list to a contract viewer: no add, edit, status change or export', async () => {
    frequenciesApi(CONTRACT_VIEWER, [QUARTERLY])
    renderPage()

    const row = await rowOf('Quarterly')
    expect(within(row).getByText('Active')).toBeInTheDocument()
    expect(within(row).queryByRole('combobox')).not.toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add Frequency' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Export/ })).not.toBeInTheDocument()
    // May still open the contracts: viewing them is an AMC contract permission.
    expect(within(row).getByRole('button', { name: /3 active/ })).toBeInTheDocument()
  })
})

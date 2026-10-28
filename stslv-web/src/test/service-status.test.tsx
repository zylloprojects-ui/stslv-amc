import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { todayIso } from '../pages/amc/amcFormat'
import type { ServiceStatusItem, ServiceStatusList, ServiceStatusOptions } from '../pages/amc/serviceStatusTypes'
import type { SessionUser } from '../lib/types'
import { ADMIN, fail, mockApi, ok, renderApp, signIn, type MockReply, type MockRequest } from './helpers'
import { EXECUTION, makeVisit, VIEWER } from './amc-helpers'

const TODAY = todayIso()
const MONTH = String(Number(TODAY.slice(5, 7)))
const YEAR = TODAY.slice(0, 4)
const day = (date: string) => `${TODAY.slice(0, 7)}-${date}`

function makeItem(overrides: Partial<ServiceStatusItem> = {}): ServiceStatusItem {
  return {
    id: '500',
    reference: 'AMC-0100',
    contract: { id: '100', status: 'ACTIVE', validTo: '2099-12-31' },
    client: { id: '10', name: 'Test Hotel One' },
    system: { description: 'FIRE', typeId: '1', typeName: 'Fire Alarm' },
    frequency: { code: 'QUARTERLY', label: 'Quarterly' },
    service: { sequenceNo: 1, cycleNo: 1, serviceCode: 'Q1' },
    periodStart: day('01'),
    periodEnd: day('28'),
    scheduledDate: day('01'),
    visitStatus: 'SCHEDULED',
    serviceStatus: 'NOT_COMPLETED',
    isOverdue: false,
    completedDate: null,
    salesEngineer: { id: '7', name: 'Sara Sales' },
    reportNumber: null,
    updatedAt: '2026-10-01T08:00:00.000Z',
    ...overrides,
  }
}

const OPEN = makeItem()
const DONE = makeItem({
  id: '501',
  reference: 'AMC-0101',
  contract: { id: '101', status: 'ACTIVE', validTo: '2099-12-31' },
  client: { id: '11', name: 'Test Hotel Two' },
  system: { description: 'CCTV', typeId: null, typeName: null },
  frequency: { code: 'MONTHLY', label: 'Monthly' },
  service: { sequenceNo: 3, cycleNo: null, serviceCode: null },
  scheduledDate: day('10'),
  visitStatus: 'COMPLETED',
  serviceStatus: 'COMPLETED',
  completedDate: day('10'),
  salesEngineer: null,
  reportNumber: 'SR-77',
})
const WAITING = makeItem({ id: '502', reference: 'AMC-0102', contract: { id: '102', status: 'EXPIRED', validTo: '2020-01-31' }, serviceStatus: 'WAITING_FOR_RENEWAL' })

const OPTIONS: ServiceStatusOptions = {
  clients: [
    { id: '10', name: 'Test Hotel One' },
    { id: '11', name: 'Test Hotel Two' },
  ],
  salesEngineers: [{ id: '7', name: 'Sara Sales' }],
  systemTypes: [{ id: '1', name: 'Fire Alarm' }],
  frequencies: [
    { code: 'MONTHLY', label: 'Monthly' },
    { code: 'QUARTERLY', label: 'Quarterly' },
  ],
  years: [Number(YEAR)],
  reportNumberAvailable: true,
}

interface Options {
  items?: ServiceStatusItem[]
  reportNumberAvailable?: boolean
  override?: (request: MockRequest) => MockReply | undefined
}

/** An in-memory Service Status API: a save changes the stored item, so the next list shows it. */
function serviceApi(user: SessionUser, options: Options = {}) {
  const items = [...(options.items ?? [OPEN, DONE, WAITING])]
  const available = options.reportNumberAvailable ?? true

  signIn()

  return mockApi((request) => {
    const overridden = options.override?.(request)
    if (overridden) return overridden

    if (request.path === '/auth/me') return ok({ user })
    if (request.path === '/amc/service-status/options') return ok({ ...OPTIONS, reportNumberAvailable: available })
    if (request.method === 'GET' && request.path === '/amc/service-status') {
      const status = request.query.get('serviceStatus')
      const client = request.query.get('clientId')
      const matching = items.filter((item) => (!status || item.serviceStatus === status) && (!client || item.client.id === client))
      const count = (value: string) => items.filter((item) => item.serviceStatus === value).length
      const list: ServiceStatusList = {
        items: matching,
        total: matching.length,
        page: 1,
        pageSize: 50,
        kpis: { total: items.length, completed: count('COMPLETED'), notCompleted: count('NOT_COMPLETED'), waitingForRenewal: count('WAITING_FOR_RENEWAL') },
        reportNumberAvailable: available,
      }

      return ok(list)
    }
    const saving = /^\/amc\/service-status\/(\d+)$/.exec(request.path)
    if (request.method === 'PATCH' && saving) {
      const index = items.findIndex((item) => item.id === saving[1])
      const body = request.body as Record<string, string>
      const current = items[index] as ServiceStatusItem
      const status = body.status === 'COMPLETED' ? 'COMPLETED' : body.status === 'NOT_COMPLETED' ? 'NOT_COMPLETED' : current.serviceStatus
      const saved: ServiceStatusItem = {
        ...current,
        serviceStatus: status,
        visitStatus: status === 'COMPLETED' ? 'COMPLETED' : current.visitStatus,
        completedDate: status === 'COMPLETED' ? (body.completedDate ?? current.completedDate) : null,
        reportNumber: 'reportNumber' in body ? body.reportNumber || null : current.reportNumber,
        updatedAt: '2026-10-02T08:00:00.000Z',
      }
      items[index] = saved

      return ok(saved)
    }

    return undefined
  })
}

const table = () => screen.findByRole('table', { name: /^Service status for/ })
const rowOf = async (reference: string) => (await screen.findByRole('link', { name: reference })).closest('tr') as HTMLElement

beforeEach(() => {
  localStorage.clear()
})

describe('service status page', () => {
  it('opens on the current month and year, with live cards and one row per service', async () => {
    const api = serviceApi(ADMIN)
    renderApp('/amc/service-status')

    const rows = within(await table()).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(3)

    const request = api.find('GET', '/amc/service-status')[0]
    expect(request?.query.get('month')).toBe(MONTH)
    expect(request?.query.get('year')).toBe(YEAR)

    const figures = screen.getByRole('region', { name: 'Service figures' })
    expect(within(figures).getByText('Total Services')).toBeInTheDocument()
    expect(within(figures).getByText('Waiting for Renewal')).toBeInTheDocument()

    const open = within(await rowOf('AMC-0100'))
    expect(open.getByText('Test Hotel One')).toBeInTheDocument()
    expect(open.getByText('Fire Alarm')).toBeInTheDocument()
    expect(open.getByText('Quarterly')).toBeInTheDocument()
    expect(open.getByText('Year 1 · Q1')).toBeInTheDocument()
    expect(open.getByText('Sara Sales')).toBeInTheDocument()
    expect(within(await rowOf('AMC-0101')).getByText('Visit 3')).toBeInTheDocument()
  })

  it('colours rows by status and shows a legend', async () => {
    serviceApi(ADMIN)
    renderApp('/amc/service-status')

    // The colours come from serviceStatus.css, keyed on data-status inside the page's own table class,
    // so the shared zebra rows cannot cover them.
    for (const [reference, status] of [['AMC-0100', 'NOT_COMPLETED'], ['AMC-0101', 'COMPLETED'], ['AMC-0102', 'WAITING_FOR_RENEWAL']]) {
      const row = await rowOf(reference as string)
      expect(row.dataset.status).toBe(status)
      expect(row).toHaveClass('ss-row')
      expect(row.closest('.service-status-table.table-scroll')).not.toBeNull()
    }
    const legend = screen.getByRole('list', { name: 'Status colours' })
    expect(within(legend).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Not Completed', 'Completed', 'Waiting for Renewal'])
  })

  it('sends every filter together, and resets them to the current month', async () => {
    const api = serviceApi(ADMIN)
    renderApp('/amc/service-status')
    await table()

    await userEvent.selectOptions(screen.getByLabelText('Client'), '11')
    await userEvent.selectOptions(screen.getByLabelText('Sales Engineer'), '7')
    await userEvent.selectOptions(screen.getByLabelText('System'), '1')
    await userEvent.selectOptions(screen.getByLabelText('Maintenance Frequency'), 'MONTHLY')
    await userEvent.selectOptions(screen.getByLabelText('Scheduled month'), '')
    await userEvent.selectOptions(screen.getByLabelText('Service Status'), 'COMPLETED')
    await userEvent.type(screen.getByLabelText('Search'), 'SR-77')

    await waitFor(() => {
      const last = api.find('GET', '/amc/service-status').at(-1)
      expect(Object.fromEntries(last?.query ?? [])).toEqual({
        clientId: '11',
        salesEngineerId: '7',
        systemTypeId: '1',
        frequency: 'MONTHLY',
        year: YEAR,
        serviceStatus: 'COMPLETED',
        search: 'SR-77',
        page: '1',
        pageSize: '50',
      })
    })

    await userEvent.click(screen.getAllByRole('button', { name: 'Reset Filters' })[0] as HTMLElement)
    await waitFor(() => {
      const last = api.find('GET', '/amc/service-status').at(-1)
      expect(Object.fromEntries(last?.query ?? [])).toEqual({ month: MONTH, year: YEAR, page: '1', pageSize: '50' })
    })
    expect(screen.getByLabelText('Search')).toHaveValue('')
  })

  it('saves one service: completed today with its report number, and nothing else', async () => {
    const api = serviceApi(EXECUTION)
    renderApp('/amc/service-status')
    const row = within(await rowOf('AMC-0100'))

    await userEvent.selectOptions(row.getByLabelText(/^Service status of AMC-0100/), 'COMPLETED')
    expect(row.getByLabelText(/^Completion date of AMC-0100/)).toHaveValue(TODAY)
    await userEvent.type(row.getByLabelText(/^Service report number of AMC-0100/), 'SR-100')
    expect(row.getByText('Unsaved changes')).toBeInTheDocument()
    await userEvent.click(row.getByRole('button', { name: /^Save AMC-0100/ }))

    expect(await row.findByText('Saved')).toBeInTheDocument()
    const saves = api.requests.filter((request) => request.method === 'PATCH')
    expect(saves).toHaveLength(1)
    expect(saves[0]?.path).toBe('/amc/service-status/500')
    expect(saves[0]?.body).toEqual({ status: 'COMPLETED', completedDate: TODAY, reportNumber: 'SR-100', expectedUpdatedAt: OPEN.updatedAt })
    await waitFor(async () => expect((await rowOf('AMC-0100')).dataset.status).toBe('COMPLETED'))
  })

  it('keeps the edits and shows why when a save fails', async () => {
    serviceApi(EXECUTION, {
      override: (request) =>
        request.method === 'PATCH' ? fail(409, 'CONFLICT', 'This service was changed by someone else after the page was loaded. Reload to see the latest values, then save again.') : undefined,
    })
    renderApp('/amc/service-status')
    const row = within(await rowOf('AMC-0100'))

    await userEvent.selectOptions(row.getByLabelText(/^Service status of AMC-0100/), 'COMPLETED')
    await userEvent.type(row.getByLabelText(/^Service report number of AMC-0100/), 'SR-100')
    await userEvent.click(row.getByRole('button', { name: /^Save AMC-0100/ }))

    expect(await row.findByRole('alert')).toHaveTextContent('changed by someone else')
    expect(row.getByLabelText(/^Service status of AMC-0100/)).toHaveValue('COMPLETED')
    expect(row.getByLabelText(/^Service report number of AMC-0100/)).toHaveValue('SR-100')
    expect(row.getByRole('button', { name: /^Save AMC-0100/ })).toBeEnabled()
  })

  it('checks the completion date before sending', async () => {
    const api = serviceApi(EXECUTION)
    renderApp('/amc/service-status')
    const row = within(await rowOf('AMC-0100'))

    await userEvent.selectOptions(row.getByLabelText(/^Service status of AMC-0100/), 'COMPLETED')
    await userEvent.clear(row.getByLabelText(/^Completion date of AMC-0100/))
    await userEvent.click(row.getByRole('button', { name: /^Save AMC-0100/ }))

    expect(await row.findByRole('alert')).toHaveTextContent('Enter the date the service was completed.')
    expect(api.requests.filter((request) => request.method === 'PATCH')).toHaveLength(0)
  })

  it('offers Waiting for Renewal only as the current state of a derived row', async () => {
    serviceApi(EXECUTION)
    renderApp('/amc/service-status')
    const waiting = within(await rowOf('AMC-0102')).getByLabelText(/^Service status of AMC-0102/)
    const open = within(await rowOf('AMC-0100')).getByLabelText(/^Service status of AMC-0100/)

    expect(within(waiting).getAllByRole('option').map((option) => option.textContent)).toEqual(['Waiting for Renewal', 'Completed'])
    expect(within(open).getAllByRole('option').map((option) => option.textContent)).toEqual(['Not Completed', 'Completed'])
  })

  it('does not offer reopening completed work without approval', async () => {
    serviceApi(EXECUTION)
    renderApp('/amc/service-status')
    const done = within(await rowOf('AMC-0101'))

    expect(done.queryByLabelText(/^Service status of AMC-0101/)).not.toBeInTheDocument()
    expect(done.getByText('Completed')).toBeInTheDocument()
  })

  it('shows a read-only page to a role that may not save or export', async () => {
    serviceApi(VIEWER)
    renderApp('/amc/service-status')
    await table()

    expect(screen.queryByRole('columnheader', { name: 'Save' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/^Service status of/)).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Export service status' })).not.toBeInTheDocument()
    expect(within(await rowOf('AMC-0101')).getByText('SR-77')).toBeInTheDocument()
  })

  it('explains that report numbers need the database update, and still saves statuses', async () => {
    serviceApi(EXECUTION, { reportNumberAvailable: false })
    renderApp('/amc/service-status')
    await table()

    expect(screen.getByText(/needs update 0077/)).toBeInTheDocument()
    expect(screen.queryByLabelText(/^Service report number of/)).not.toBeInTheDocument()
    expect(screen.getByLabelText(/^Service status of AMC-0100/)).toBeInTheDocument()
  })

  it('hides and shows columns, and remembers the choice', async () => {
    serviceApi(ADMIN)
    const { unmount } = renderApp('/amc/service-status')
    await table()

    const button = screen.getByRole('button', { name: 'Hide Columns: 8 of 8 columns shown' })
    expect(button).toHaveTextContent('Hide Columns· 8 of 8 shown')
    await userEvent.click(button)
    const dialog = screen.getByRole('dialog', { name: 'Hide columns' })
    await userEvent.click(within(dialog).getByLabelText('Sales Engineer'))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }))

    expect(screen.queryByRole('columnheader', { name: 'Sales Engineer' })).not.toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'AMC Reference' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hide Columns: 7 of 8 columns shown' })).toBeInTheDocument()

    unmount()
    renderApp('/amc/service-status')
    await table()
    expect(screen.queryByRole('columnheader', { name: 'Sales Engineer' })).not.toBeInTheDocument()
  })

  it('renames and reorders the KPI cards without changing what they count, and resets them', async () => {
    serviceApi(ADMIN)
    renderApp('/amc/service-status')
    await table()
    const figures = () => screen.getByRole('region', { name: 'Service figures' })

    await userEvent.click(screen.getByRole('button', { name: 'Customize cards' }))
    let dialog = screen.getByRole('dialog', { name: 'Customize KPI cards' })
    const name = within(dialog).getByLabelText('Name of the Completed card')
    await userEvent.clear(name)
    await userEvent.type(name, 'Done')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move Done up' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save cards' }))

    // The cards, in display order (the Customize button shares the region).
    const labels = () =>
      within(figures())
        .getAllByRole('button')
        .map((button) => button.textContent ?? '')
        .filter((text) => text !== 'Customize cards')
    expect(labels()[0]).toContain('Done')
    expect(labels()[1]).toContain('Total Services')

    await userEvent.click(screen.getByRole('button', { name: 'Customize cards' }))
    dialog = screen.getByRole('dialog', { name: 'Customize KPI cards' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reset KPI Names' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reset KPI Order' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save cards' }))
    expect(labels()[0]).toContain('Total Services')
    expect(labels()[1]).toContain('Completed')
  })

  it('exports the filtered services, all pages, as Excel and PDF', async () => {
    const saved: string[] = []
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:test', revokeObjectURL: () => undefined }))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download)
    })
    const api = serviceApi(ADMIN, { override: (request) => (request.path === '/amc/service-status/export' ? ok(null) : undefined) })
    renderApp('/amc/service-status')
    await table()

    await userEvent.selectOptions(screen.getByLabelText('Service Status'), 'WAITING_FOR_RENEWAL')
    await userEvent.click(screen.getByRole('button', { name: 'Export service status to Excel' }))
    await waitFor(() => expect(saved).toEqual(['service-status.xlsx']))
    const excel = api.find('GET', '/amc/service-status/export')[0]
    expect(Object.fromEntries(excel?.query ?? [])).toEqual({ format: 'xlsx', month: MONTH, year: YEAR, serviceStatus: 'WAITING_FOR_RENEWAL' })

    await userEvent.click(screen.getByRole('button', { name: 'Export service status to PDF' }))
    await waitFor(() => expect(saved).toEqual(['service-status.xlsx', 'service-status.pdf']))
    expect(api.find('GET', '/amc/service-status/export')[1]?.query.has('page')).toBe(false)
  })

  it('is in the AMC Operations navigation for roles that may view the schedule', async () => {
    serviceApi(VIEWER)
    renderApp('/amc/service-status')
    await table()

    expect(screen.getAllByRole('link', { name: 'Service Status' }).length).toBeGreaterThan(0)
  })
})

describe('service status visit actions and figure scope', () => {
  const EXECUTION_VISIT = makeVisit({ id: '500', scheduledDate: day('01'), originalScheduledDate: day('01') })

  it('opens Visit actions for a row, loading the visit from the execution API', async () => {
    const api = serviceApi(EXECUTION, {
      override: (request) => (request.method === 'GET' && request.path === '/amc/execution/visits/500' ? ok(EXECUTION_VISIT) : undefined),
    })
    renderApp('/amc/service-status')

    await userEvent.click(within(await rowOf('AMC-0100')).getByRole('button', { name: /^Visit actions for AMC-0100/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Update visit' })
    expect(within(dialog).getByLabelText(/^Status/)).toHaveValue('SCHEDULED')
    expect(api.find('GET', '/amc/execution/visits/500')).toHaveLength(1)
  })

  it('offers no visit actions to a user who may only view', async () => {
    serviceApi(VIEWER)
    renderApp('/amc/service-status')

    await table()
    expect(screen.queryByRole('button', { name: /^Visit actions/ })).not.toBeInTheDocument()
  })

  it('says the cards and the list both follow the scheduled month and year', async () => {
    serviceApi(ADMIN)
    renderApp('/amc/service-status')

    const note = await screen.findByRole('note', { name: 'What the figures count' })
    const period = `${new Date(`${TODAY}T00:00:00`).toLocaleString('en-GB', { month: 'long' })} ${YEAR}`
    expect(note).toHaveTextContent(`Cards: services scheduled in ${period}, with the filters below except Service Status.`)
    expect(note).toHaveTextContent(`List: services scheduled in ${period}, with all the filters below.`)
    expect(screen.getByLabelText('Scheduled month')).toHaveValue(MONTH)
    expect(screen.getByLabelText('Scheduled year')).toHaveValue(YEAR)
  })
})

import { QueryClient } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppProviders } from '../App'
import type { SessionUser } from '../lib/types'
import { ServicesSalesPage } from '../pages/servicesSales/ServicesSalesPage'
import type { ServicesSalesItem } from '../pages/servicesSales/servicesSalesTypes'
import { afterPageSplit, ADMIN, fail, mockApi, ok, renderApp, signIn, type MockReply, type MockRequest } from './helpers'

// Most tests render the page on its own; the routing tests go through App.tsx and the menu.

const EDITOR: SessionUser = {
  id: '7',
  email: 'invoicing@example.com',
  fullName: 'Ines Invoicing',
  roles: [{ id: '5', code: 'INVOICING', name: 'Invoicing' }],
  permissions: ['SERVICES_SALES:VIEW', 'SERVICES_SALES:EDIT', 'SERVICES_SALES:EXPORT'],
}
const VIEWER: SessionUser = { ...EDITOR, id: '8', email: 'accountant@example.com', permissions: ['SERVICES_SALES:VIEW'] }

function makeItem(overrides: Partial<ServicesSalesItem> = {}): ServicesSalesItem {
  return {
    id: '1',
    reference: 'AMC-0007',
    contract: { id: '7', status: 'ACTIVE' },
    client: { id: '10', name: 'Alpha Towers' },
    system: { description: 'FIRE', typeId: '3', typeName: 'Fire Alarm' },
    frequency: { code: 'HALF_YEARLY', label: 'Half-yearly' },
    service: { sequenceNo: 1, cycleNo: 1, serviceCode: 'H1' },
    periodStart: '2026-10-01',
    periodEnd: '2027-03-31',
    scheduledDate: '2026-10-01',
    visitStatus: 'COMPLETED',
    serviceStatus: 'COMPLETED',
    salesStatus: 'QUOTE_PENDING',
    completedDate: '2026-10-05',
    serviceReportNo: null,
    salesEngineer: { id: '4', name: 'Esha Engineer' },
    quotationNo: null,
    quotationUpdatedAt: null,
    quotationUpdatedBy: null,
    quotationBeforeCompletion: false,
    serviceReport: null,
    updatedAt: '2026-10-05T08:00:00.000Z',
    ...overrides,
  }
}

const PENDING = makeItem()
const QUOTED = makeItem({ id: '2', reference: 'AMC-0008', client: { id: '11', name: 'Beta Mall' }, service: { sequenceNo: 2, cycleNo: 1, serviceCode: 'BM1' }, scheduledDate: '2026-12-01', salesStatus: 'QUOTED', quotationNo: 'QT-55' })
const OPEN = makeItem({ id: '3', reference: 'AMC-0009', service: { sequenceNo: 3, cycleNo: 1, serviceCode: 'Q3' }, scheduledDate: '2026-12-15', visitStatus: 'SCHEDULED', serviceStatus: 'NOT_COMPLETED', salesStatus: 'NOT_COMPLETED', completedDate: null })

const OPTIONS = {
  clients: [{ id: '10', name: 'Alpha Towers' }, { id: '11', name: 'Beta Mall' }],
  salesEngineers: [{ id: '4', name: 'Esha Engineer' }],
  systemTypes: [{ id: '3', name: 'Fire Alarm' }],
  frequencies: [{ code: 'HALF_YEARLY', label: 'Half-yearly' }],
  years: [2026, 2027],
}

/** A stand-in for the API holding the given visits; a saved quotation number is kept. */
function salesApi(user: SessionUser, items: ServicesSalesItem[], override?: (request: MockRequest) => MockReply | undefined) {
  const rows = items.map((item) => ({ ...item }))

  return mockApi((request) => {
    const replaced = override?.(request)
    if (replaced) return replaced
    if (request.path === '/auth/me') return ok({ user })
    if (request.path === '/services-sales/options') return ok(OPTIONS)
    if (request.method === 'GET' && request.path === '/services-sales') {
      const status = request.query.get('serviceStatus')
      const selected = rows.filter((row) => !status || row.serviceStatus === status)
      const count = (s: string) => selected.filter((row) => row.salesStatus === s).length
      return ok({
        items: selected,
        total: selected.length,
        page: Number(request.query.get('page') ?? 1),
        pageSize: 50,
        kpis: { total: selected.length, notCompleted: count('NOT_COMPLETED'), quotePending: count('QUOTE_PENDING'), quoted: count('QUOTED'), quotationBeforeCompletion: 0 },
      })
    }
    const match = /^\/services-sales\/(\d+)$/.exec(request.path)
    if (request.method === 'PATCH' && match) {
      const row = rows.find((item) => item.id === match[1])
      if (!row) return fail(404, 'NOT_FOUND', 'AMC visit not found.')
      const quotationNo = (request.body as { quotationNo: string }).quotationNo || null
      Object.assign(row, { quotationNo, salesStatus: quotationNo ? 'QUOTED' : 'QUOTE_PENDING', updatedAt: '2026-10-06T08:00:00.000Z' })
      return ok(row)
    }
    return undefined
  })
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <AppProviders client={client}>
        <ServicesSalesPage />
      </AppProviders>
    </MemoryRouter>,
  )
}

const figures = () => within(screen.getByRole('group', { name: 'Service Sales figures' }))
const rowOf = (reference: string) => screen.getByText(reference).closest('tr') as HTMLElement

beforeEach(() => signIn())
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('Services Sales page', () => {
  it('opens on every month, with the four cards, the legend and one coloured row per service', async () => {
    const api = salesApi(EDITOR, [PENDING, QUOTED, OPEN])
    renderPage()

    expect(await screen.findByRole('heading', { name: 'Service Sales' })).toBeInTheDocument()
    expect(screen.getByText('Track completed services and manually record quotation numbers.')).toBeInTheDocument()
    await screen.findByText('AMC-0007')

    const first = api.find('GET', '/services-sales')[0]
    expect(first?.query.has('month')).toBe(false)
    expect(first?.query.has('year')).toBe(false)

    const labels = figures().getAllByText(/Total Services|Not Completed|Completed \/ Quote Pending|Quoted/).map((node) => node.textContent)
    expect(labels).toEqual(['Total Services', 'Not Completed', 'Completed / Quote Pending', 'Quoted'])
    expect(within(screen.getByRole('list', { name: 'Status colours' })).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Not Completed',
      'Completed / Quote Pending',
      'Completed with Quote No.',
    ])

    expect(rowOf('AMC-0007')).toHaveAttribute('data-sales-status', 'QUOTE_PENDING')
    expect(rowOf('AMC-0008')).toHaveAttribute('data-sales-status', 'QUOTED')
    expect(rowOf('AMC-0009')).toHaveAttribute('data-sales-status', 'NOT_COMPLETED')
    expect(within(rowOf('AMC-0008')).getByText('BM1')).toBeInTheDocument()
    expect(within(rowOf('AMC-0007')).getByText('Half-yearly')).toBeInTheDocument()
    expect(within(rowOf('AMC-0007')).getByText('Esha Engineer')).toBeInTheDocument()
  })

  it('shows the service status read only, and offers no quotation field before completion', async () => {
    salesApi(EDITOR, [PENDING, OPEN])
    renderPage()

    const open = await screen.findByText('AMC-0009')
    const row = within(open.closest('tr') as HTMLElement)
    expect(row.getByText('Not Completed')).toBeInTheDocument()
    expect(row.queryByRole('combobox')).not.toBeInTheDocument()
    expect(row.queryByRole('textbox')).not.toBeInTheDocument()
    expect(row.getByText('N/A')).toBeInTheDocument()
    expect(within(rowOf('AMC-0007')).queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('saves a quotation number for one service, with feedback, and keeps it after the refresh', async () => {
    const api = salesApi(EDITOR, [PENDING, QUOTED])
    renderPage()

    const field = await screen.findByRole('textbox', { name: 'Quote No. for AMC-0007 H1' })
    expect(field).toHaveAttribute('placeholder', 'N/A')
    const save = screen.getByRole('button', { name: 'Save Quote No. for AMC-0007 H1' })
    expect(save).toBeDisabled()

    await userEvent.type(field, '  QT-2026/101 ')
    await userEvent.click(save)

    expect(await within(rowOf('AMC-0007')).findByText('Saved')).toBeInTheDocument()
    expect(api.find('PATCH', '/services-sales/1').map((request) => request.body)).toEqual([{ quotationNo: 'QT-2026/101', expectedUpdatedAt: PENDING.updatedAt }])
    expect(api.find('PATCH', '/services-sales/2')).toHaveLength(0)
    await waitFor(() => expect(rowOf('AMC-0007')).toHaveAttribute('data-sales-status', 'QUOTED'))
    expect(screen.getByRole('textbox', { name: 'Quote No. for AMC-0007 H1' })).toHaveValue('QT-2026/101')
    expect(screen.getByRole('textbox', { name: 'Quote No. for AMC-0008 BM1' })).toHaveValue('QT-55')
  })

  it('keeps the typed number and shows the reason when a save fails', async () => {
    salesApi(EDITOR, [PENDING], (request) =>
      request.method === 'PATCH' ? fail(409, 'CONFLICT', 'This service was changed by someone else after the page was loaded.') : undefined,
    )
    renderPage()

    const field = await screen.findByRole('textbox', { name: 'Quote No. for AMC-0007 H1' })
    await userEvent.type(field, 'QT-9')
    await userEvent.click(screen.getByRole('button', { name: 'Save Quote No. for AMC-0007 H1' }))

    expect(await screen.findByText('This service was changed by someone else after the page was loaded.')).toBeInTheDocument()
    expect(field).toHaveValue('QT-9')
    expect(field).toHaveAttribute('aria-invalid', 'true')
  })

  it('gives a user without edit permission no field, Save or download', async () => {
    salesApi(VIEWER, [PENDING, QUOTED])
    renderPage()

    await screen.findByText('AMC-0007')
    expect(screen.queryByRole('textbox', { name: /Quote No\./ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Save/ })).not.toBeInTheDocument()
    expect(within(rowOf('AMC-0008')).getByText('QT-55')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Export Service Sales' })).not.toBeInTheDocument()
  })

  it('sends every filter together, to the list and the download, and resets them', async () => {
    const saved: string[] = []
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:test', revokeObjectURL: () => undefined }))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download)
    })
    const api = salesApi(EDITOR, [PENDING, QUOTED, OPEN], (request) => (request.path === '/services-sales/export' ? ok(null) : undefined))
    renderPage()

    await screen.findByText('AMC-0007')
    await waitFor(() => expect(screen.getByRole('option', { name: 'Esha Engineer' })).toBeInTheDocument())
    await userEvent.type(screen.getByLabelText('Search'), 'alpha')
    await userEvent.selectOptions(screen.getByLabelText('Client'), '10')
    await userEvent.selectOptions(screen.getByLabelText('Service Engineer'), '4')
    await userEvent.selectOptions(screen.getByLabelText('System'), '3')
    await userEvent.selectOptions(screen.getByLabelText('Maintenance Frequency'), 'HALF_YEARLY')
    await userEvent.selectOptions(screen.getByLabelText('Scheduled month'), '10')
    await userEvent.selectOptions(screen.getByLabelText('Scheduled year'), '2026')
    await userEvent.selectOptions(screen.getByLabelText('Service Status'), 'COMPLETED')

    const expected = { search: 'alpha', clientId: '10', salesEngineerId: '4', systemTypeId: '3', frequency: 'HALF_YEARLY', month: '10', year: '2026', serviceStatus: 'COMPLETED' }
    await waitFor(() => expect(Object.fromEntries(api.find('GET', '/services-sales').at(-1)?.query ?? [])).toEqual({ ...expected, page: '1', pageSize: '50' }))
    await waitFor(() => expect(figures().getByText('Total Services').closest('div')).toHaveTextContent('2'))

    await userEvent.click(screen.getByRole('button', { name: 'Export Service Sales to Excel' }))
    await waitFor(() => expect(saved).toEqual(['service-sales.xlsx']))
    expect(Object.fromEntries(api.find('GET', '/services-sales/export')[0]?.query ?? [])).toEqual({ ...expected, format: 'xlsx' })
    await userEvent.click(screen.getByRole('button', { name: 'Export Service Sales to PDF' }))
    await waitFor(() => expect(api.find('GET', '/services-sales/export')[1]?.query.get('format')).toBe('pdf'))

    await userEvent.click(screen.getAllByRole('button', { name: 'Reset Filters' })[0] as HTMLElement)
    await waitFor(() => expect(Object.fromEntries(api.find('GET', '/services-sales').at(-1)?.query ?? [])).toEqual({ page: '1', pageSize: '50' }))
    expect(screen.getByLabelText('Search')).toHaveValue('')
  })

  it('hides and shows columns from the Hide Columns dialog, keeping AMC Reference', async () => {
    salesApi(EDITOR, [PENDING])
    renderPage()

    await screen.findByText('AMC-0007')
    expect(screen.getByRole('columnheader', { name: 'Service Engineer' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Hide Columns' }))
    const dialog = within(screen.getByRole('dialog', { name: 'Hide columns' }))
    expect(dialog.queryByRole('checkbox', { name: 'AMC Reference' })).not.toBeInTheDocument()
    await userEvent.click(dialog.getByRole('checkbox', { name: 'Service Engineer' }))
    await userEvent.click(dialog.getByRole('checkbox', { name: 'Frequency' }))
    await userEvent.click(dialog.getByRole('button', { name: 'Apply' }))

    expect(screen.queryByRole('columnheader', { name: 'Service Engineer' })).not.toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: 'Frequency' })).not.toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'AMC Reference' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hide Columns (2)' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Hide Columns (2)' }))
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Hide columns' })).getByRole('button', { name: 'Show all' }))
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(screen.getByRole('columnheader', { name: 'Service Engineer' })).toBeInTheDocument()
  })

  it('renames and reorders the cards without changing their figures, and resets names and order separately', async () => {
    salesApi(EDITOR, [PENDING, QUOTED, OPEN])
    renderPage()
    await screen.findByText('AMC-0007')
    const cardLabels = () => figures().getAllByText(/./, { selector: 'span.block' }).map((node) => node.textContent)

    await userEvent.click(screen.getByRole('button', { name: 'Customize KPIs' }))
    let dialog = within(screen.getByRole('dialog', { name: 'Customize KPI cards' }))
    const quoted = dialog.getByDisplayValue('Quoted')
    await userEvent.clear(quoted)
    await userEvent.type(quoted, 'Quotes Sent')
    await userEvent.click(dialog.getByRole('button', { name: 'Move Quotes Sent earlier' }))
    await userEvent.click(dialog.getByRole('button', { name: 'Save' }))

    expect(cardLabels()).toEqual(['Total Services', 'Not Completed', 'Quotes Sent', 'Completed / Quote Pending'])
    // The renamed card still shows the quoted figure.
    // The count animates for 800 ms; a busy full run needs more than the default wait.
    await waitFor(() => expect(figures().getByText('Quotes Sent').closest('div')).toHaveTextContent('Quotes Sent1'), { timeout: 5000 })

    await userEvent.click(screen.getByRole('button', { name: 'Customize KPIs' }))
    dialog = within(screen.getByRole('dialog', { name: 'Customize KPI cards' }))
    await userEvent.click(dialog.getByRole('button', { name: 'Reset KPI Order' }))
    await userEvent.click(dialog.getByRole('button', { name: 'Cancel' }))
    expect(cardLabels()).toEqual(['Total Services', 'Not Completed', 'Completed / Quote Pending', 'Quotes Sent'])

    await userEvent.click(screen.getByRole('button', { name: 'Customize KPIs' }))
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Customize KPI cards' })).getByRole('button', { name: 'Reset KPI Names' }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(cardLabels()).toEqual(['Total Services', 'Not Completed', 'Completed / Quote Pending', 'Quoted'])
  })

  it('is named Service Sales, routed at /amc/service-sales, and listed once in the menu', async () => {
    salesApi(EDITOR, [PENDING])
    renderApp('/amc/services-sales')

    expect(await screen.findByRole('heading', { name: 'Service Sales' })).toBeInTheDocument()
    expect(screen.queryByText('Services Sales')).not.toBeInTheDocument()
    const menu = within(screen.getByRole('navigation', { name: 'Main' }))
    expect(menu.getAllByRole('link', { name: 'Service Sales' })).toHaveLength(1)
    expect(menu.getByRole('link', { name: 'Service Sales' })).toHaveAttribute('href', '/amc/service-sales')
  })

  it.each(['/amc/quotations', '/amc/services-sales'])('redirects the former address %s to /amc/service-sales, keeping its query', async (oldAddress) => {
    salesApi(EDITOR, [PENDING])
    const { router } = renderApp(`${oldAddress}?search=AMC-0007`)

    expect(await screen.findByRole('heading', { name: 'Service Sales' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/amc/service-sales')
    expect(router.state.location.search).toBe('?search=AMC-0007')
  })

  it('is in the menu for an Admin', async () => {
    expect(ADMIN.permissions).toContain('SERVICES_SALES:EDIT')
    salesApi(ADMIN, [PENDING])
    renderApp('/amc/services-sales')

    expect(await screen.findByRole('textbox', { name: 'Quote No. for AMC-0007 H1' })).toBeInTheDocument()
    expect(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Service Sales' })).toBeInTheDocument()
  })

  it('stays hidden and closed for a user without SERVICES_SALES, who still has Service Status', async () => {
    // Procurement holds no SERVICES_SALES grant (migration 0079); Service Status needs SERVICE_STATUS:VIEW (from AMC_SCHEDULE:VIEW, 0081).
    const user: SessionUser = { ...EDITOR, id: '9', roles: [{ id: '3', code: 'PROCUREMENT', name: 'Procurement' }], permissions: afterPageSplit(['AMC_SCHEDULE:VIEW']) }
    const api = salesApi(user, [PENDING])
    renderApp('/amc/services-sales')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    const nav = within(screen.getByRole('navigation', { name: 'Main' }))
    expect(nav.queryByRole('link', { name: 'Service Sales' })).not.toBeInTheDocument()
    // Service Sales is under AMC Sales, which this user does not see; AMC Execution opens on request.
    expect(nav.queryByRole('button', { name: 'AMC Sales' })).not.toBeInTheDocument()
    await userEvent.click(nav.getByRole('button', { name: 'AMC Execution' }))
    expect(await nav.findByRole('link', { name: 'Service Status' })).toBeInTheDocument()
    expect(api.find('GET', '/services-sales')).toHaveLength(0)
  })

  it('shows the reason when the services cannot be loaded, and an empty state for no match', async () => {
    salesApi(EDITOR, [], (request) =>
      request.method === 'GET' && request.path === '/services-sales' && request.query.get('clientId') !== '10'
        ? fail(503, 'FEATURE_UNAVAILABLE', 'This feature needs a database update that has not been applied yet.')
        : undefined,
    )
    renderPage()

    expect(await screen.findByText(/This feature needs a database update/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('option', { name: 'Alpha Towers' })).toBeInTheDocument())
    await userEvent.selectOptions(screen.getByLabelText('Client'), '10')
    expect(await screen.findByText('No services found')).toBeInTheDocument()
  })
})

describe('Service Report No. and the Quote filter', () => {
  it('shows the read-only column between Service Status and Service Report', async () => {
    salesApi(EDITOR, [makeItem({ serviceReportNo: 'SR-77' })])
    renderPage()

    expect(await screen.findByText('SR-77')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: /Service Report/ })).not.toBeInTheDocument()
    const headers = screen.getAllByRole('columnheader').map((header) => header.textContent)
    expect(headers.indexOf('Service Report No.')).toBe(headers.indexOf('Service Status') + 1)
    expect(headers.indexOf('Service Report')).toBe(headers.indexOf('Service Report No.') + 1)
    expect(headers.indexOf('Quote No.')).toBe(headers.indexOf('Service Report') + 1)
  })

  it('sends the Quote filter and the hidden columns to the list and the download', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:test', revokeObjectURL: () => undefined }))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const api = salesApi(EDITOR, [PENDING], (request) => (request.path === '/services-sales/export' ? ok(null) : undefined))
    renderPage()

    await screen.findByText('AMC-0007')
    expect(within(screen.getByLabelText('Quote')).getAllByRole('option').map((option) => option.textContent)).toEqual(['All', 'Quote Submitted', 'Not Submitted'])
    await userEvent.selectOptions(screen.getByLabelText('Quote'), 'NOT_SUBMITTED')
    await waitFor(() => expect(api.find('GET', '/services-sales').at(-1)?.query.get('quoteSubmission')).toBe('NOT_SUBMITTED'))

    await userEvent.click(screen.getByRole('button', { name: /Hide Columns/ }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('checkbox', { name: 'Service Report No.' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Apply|Save/ }))
    expect(screen.queryByRole('columnheader', { name: 'Service Report No.' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Export Service Sales to Excel' }))
    await waitFor(() => expect(api.find('GET', '/services-sales/export').length).toBe(1))
    const query = api.find('GET', '/services-sales/export')[0]?.query
    expect(query?.get('hidden')).toBe('serviceReportNo')
    expect(query?.get('quoteSubmission')).toBe('NOT_SUBMITTED')
  })
})

describe('Service Report column (view and download only)', () => {
  const REPORT_A = { id: '501', originalName: 'Report A – M1.pdf', mimeType: 'application/pdf', sizeBytes: 2048, uploadedAt: '2026-10-05T09:00:00.000Z' }
  const REPORT_B = { id: '502', originalName: 'Report B.pdf', mimeType: 'application/pdf', sizeBytes: 1024, uploadedAt: '2026-11-05T09:00:00.000Z' }
  const WORD = { id: '503', originalName: 'Report C.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sizeBytes: 4096, uploadedAt: '2026-11-06T09:00:00.000Z' }
  // Two services of the same contract, each with its own report, and one service without.
  const M1 = makeItem({ id: '11', service: { sequenceNo: 1, cycleNo: 1, serviceCode: 'M1' }, serviceReportNo: 'SR-1', serviceReport: REPORT_A })
  const M2 = makeItem({ id: '12', service: { sequenceNo: 2, cycleNo: 1, serviceCode: 'M2' }, scheduledDate: '2026-11-01', serviceReportNo: 'SR-2', serviceReport: REPORT_B })
  const NONE = makeItem({ id: '13', reference: 'AMC-0009', service: { sequenceNo: 1, cycleNo: 1, serviceCode: 'Q1' }, serviceReport: null })
  const REPORT_PATH = /^\/services-sales\/\d+\/report$/

  const cellOf = (code: string) => {
    const row = screen.getByText(code).closest('tr') as HTMLElement
    const index = screen.getAllByRole('columnheader').findIndex((header) => header.textContent === 'Service Report')
    return within(within(row).getAllByRole('cell')[index] as HTMLElement)
  }

  function captureFiles() {
    const blobs: Blob[] = []
    const names: string[] = []
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: (blob: Blob) => {
          blobs.push(blob)
          return `blob:report-${blobs.length}`
        },
        revokeObjectURL: () => undefined,
      }),
    )
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download)
    })
    return { blobs, names }
  }

  it('shows View and Download for a service with a report and Not uploaded without one, keeping the report number', async () => {
    salesApi(VIEWER, [M1, NONE])
    renderPage()

    await screen.findByText('M1')
    expect(cellOf('M1').getByRole('button', { name: 'View service report for AMC-0007 M1' })).toBeInTheDocument()
    expect(cellOf('M1').getByRole('button', { name: 'Download service report for AMC-0007 M1' })).toBeInTheDocument()
    expect(cellOf('Q1').getByText('Not uploaded')).toBeInTheDocument()
    expect(cellOf('Q1').queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByText('SR-1')).toBeInTheDocument()
    // Read only: nothing to upload, replace or remove here.
    expect(document.querySelector('input[type=file]')).toBeNull()
    expect(screen.queryByRole('button', { name: /upload|replace|remove/i })).not.toBeInTheDocument()
  })

  it('downloads each service its own report by visit id, signed in, under its original name', async () => {
    const files = captureFiles()
    const api = salesApi(VIEWER, [M1, M2], (request) => (REPORT_PATH.test(request.path) ? ok(null) : undefined))
    renderPage()

    await screen.findByText('M2')
    await userEvent.click(cellOf('M2').getByRole('button', { name: /^Download/ }))
    await waitFor(() => expect(files.names).toEqual(['Report B.pdf']))
    expect(api.requests.filter((request) => REPORT_PATH.test(request.path)).map((request) => request.path)).toEqual(['/services-sales/12/report'])
    expect(api.find('GET', '/services-sales/12/report')[0]?.authorization).toMatch(/^Bearer /)

    await userEvent.click(cellOf('M1').getByRole('button', { name: /^Download/ }))
    await waitFor(() => expect(files.names).toEqual(['Report B.pdf', 'Report A – M1.pdf']))
    expect(api.find('GET', '/services-sales/11/report')).toHaveLength(1)
  })

  it('views a PDF in a new tab from the authenticated file, without leaving the page', async () => {
    const files = captureFiles()
    const tab = { opener: {} as unknown, location: { href: '' }, close: vi.fn() }
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)
    const api = salesApi(VIEWER, [M1, M2], (request) => (REPORT_PATH.test(request.path) ? ok(null) : undefined))
    renderPage()

    await screen.findByText('M1')
    await userEvent.click(cellOf('M1').getByRole('button', { name: /^View/ }))
    await waitFor(() => expect(tab.location.href).toBe('blob:report-1'))
    expect(open).toHaveBeenCalledWith('', '_blank')
    expect(tab.opener).toBeNull()
    expect(files.blobs[0]?.type).toBe('application/pdf')
    expect(api.find('GET', '/services-sales/11/report')).toHaveLength(1)
    expect(api.find('GET', '/services-sales/12/report')).toHaveLength(0)
    expect(screen.getByRole('heading', { name: 'Service Sales' })).toBeInTheDocument()
  })

  it('downloads a Word report from View, since browsers cannot show it', async () => {
    const files = captureFiles()
    const open = vi.spyOn(window, 'open')
    salesApi(VIEWER, [makeItem({ id: '14', serviceReport: WORD })], (request) => (request.path === '/services-sales/14/report' ? ok(null) : undefined))
    renderPage()

    await userEvent.click(await screen.findByRole('button', { name: 'View service report for AMC-0007 H1 (Word document: downloads)' }))
    await waitFor(() => expect(files.names).toEqual(['Report C.docx']))
    expect(open).not.toHaveBeenCalled()
  })

  it('shows a clear message when the file is missing, refused or the tab is blocked', async () => {
    captureFiles()
    const tab = { opener: {}, location: { href: '' }, close: vi.fn() }
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)
    salesApi(VIEWER, [M1, M2], (request) => {
      if (request.path === '/services-sales/11/report') return fail(404, 'FILE_MISSING', 'The service report file could not be found. Ask for it to be uploaded again on Service Status.')
      if (request.path === '/services-sales/12/report') return fail(404, 'SERVICE_REPORT_NOT_FOUND', 'No service report has been uploaded for this service.')
      return undefined
    })
    renderPage()

    await screen.findByText('M1')
    await userEvent.click(cellOf('M1').getByRole('button', { name: /^View/ }))
    expect(await cellOf('M1').findByText(/could not be found/)).toBeInTheDocument()
    expect(tab.close).toHaveBeenCalled()

    await userEvent.click(cellOf('M2').getByRole('button', { name: /^Download/ }))
    expect(await cellOf('M2').findByText('No service report has been uploaded for this service.')).toBeInTheDocument()

    open.mockReturnValue(null)
    await userEvent.click(cellOf('M2').getByRole('button', { name: /^View/ }))
    expect(await cellOf('M2').findByText(/blocked the new tab/)).toBeInTheDocument()
  })

  it('is in Hide Columns with the shown count, keeps earlier saved choices, and is never sent to the export', async () => {
    // A choice saved before this column existed.
    localStorage.setItem(`stslev.services-sales.hidden-columns.${EDITOR.id}`, JSON.stringify(['frequency']))
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:test', revokeObjectURL: () => undefined }))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const api = salesApi(EDITOR, [M1], (request) => (request.path === '/services-sales/export' ? ok(null) : undefined))
    // Through the app's routes, which wait for the signed-in user, so the saved choice of that user is read.
    renderApp('/amc/service-sales')

    await screen.findByText('M1')
    expect(screen.getByRole('columnheader', { name: 'Service Report' })).toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: 'Frequency' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Hide Columns (1)' }))
    const dialog = within(screen.getByRole('dialog', { name: 'Hide columns' }))
    expect(dialog.getByText('9 of 10 columns shown')).toBeInTheDocument()
    await userEvent.click(dialog.getByRole('checkbox', { name: 'Service Report' }))
    expect(dialog.getByText('8 of 10 columns shown')).toBeInTheDocument()
    await userEvent.click(dialog.getByRole('button', { name: 'Apply' }))
    expect(screen.queryByRole('columnheader', { name: 'Service Report' })).not.toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Service Report No.' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Export Service Sales to Excel' }))
    await waitFor(() => expect(api.find('GET', '/services-sales/export').length).toBe(1))
    expect(api.find('GET', '/services-sales/export')[0]?.query.get('hidden')).toBe('frequency')
  })
})

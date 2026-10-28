import { QueryClient } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppProviders } from '../App'
import type { SessionUser } from '../lib/types'
import { MasterStatusPage } from '../pages/masterStatus/MasterStatusPage'
import type { MasterStatusItem } from '../pages/masterStatus/masterStatusTypes'
import { ADMIN, fail, mockApi, ok, renderApp, signIn, type MockReply, type MockRequest } from './helpers'

// Most tests render the page on its own; the routing tests go through App.tsx and the menu.

const VIEWER: SessionUser = {
  id: '7',
  email: 'invoicing@example.com',
  fullName: 'Ines Invoicing',
  roles: [{ id: '5', code: 'INVOICING', name: 'Invoicing' }],
  permissions: ['AMC_SCHEDULE:VIEW', 'INVOICES:VIEW', 'SERVICES_SALES:VIEW', 'AMC_CONTRACTS:VIEW'],
}
const EXPORTER: SessionUser = { ...VIEWER, id: '8', permissions: [...VIEWER.permissions, 'AMC_SCHEDULE:EXPORT'] }

function makeItem(overrides: Partial<MasterStatusItem> = {}): MasterStatusItem {
  return {
    id: '1',
    reference: 'AMC-0007',
    contract: { id: '7', status: 'ACTIVE' },
    client: { id: '10', name: 'Alpha Towers' },
    system: { description: 'FIRE', typeId: '3', typeName: 'Fire Alarm' },
    frequency: { code: 'QUARTERLY', label: 'Quarterly' },
    service: { sequenceNo: 1, cycleNo: 1, serviceCode: 'Q1' },
    scheduledDate: '2026-10-01',
    visitStatus: 'SCHEDULED',
    serviceStatus: 'NOT_COMPLETED',
    completedDate: null,
    visitValue: '405.000',
    invoiceNumbers: [],
    quotationNo: null,
    salesEngineer: { id: '4', name: 'Esha Engineer' },
    colour: 'RED',
    ...overrides,
  }
}

const RED = makeItem()
const YELLOW = makeItem({ id: '2', reference: 'AMC-0008', service: { sequenceNo: 2, cycleNo: 1, serviceCode: 'Q2' }, visitStatus: 'COMPLETED', serviceStatus: 'COMPLETED', completedDate: '2026-10-05', colour: 'YELLOW', visitValue: null })
const BLUE = makeItem({ id: '3', reference: 'AMC-0009', contract: { id: '9', status: 'ACTIVE' }, client: { id: '11', name: 'Beta Mall' }, visitStatus: 'COMPLETED', serviceStatus: 'COMPLETED', invoiceNumbers: ['INV-1', 'INV-2'], colour: 'BLUE', salesEngineer: null })
const GREEN = makeItem({ id: '4', reference: 'AMC-0010', contract: { id: '10', status: 'ACTIVE' }, visitStatus: 'COMPLETED', serviceStatus: 'COMPLETED', invoiceNumbers: ['INV-3'], quotationNo: 'QT-55', colour: 'GREEN', visitValue: '1234.500' })
const RENEWAL = makeItem({ id: '5', reference: 'AMC-0011', contract: { id: '11', status: 'EXPIRED' }, serviceStatus: 'WAITING_FOR_RENEWAL', colour: 'RED' })

const OPTIONS = {
  clients: [{ id: '10', name: 'Alpha Towers' }, { id: '11', name: 'Beta Mall' }],
  salesEngineers: [{ id: '4', name: 'Esha Engineer' }],
  years: [2026, 2027],
}

/** "1234.500" + "405" exactly, in thousandths, so the stand-in totals like the API. */
const sum = (values: (string | null)[]) => {
  const thousandths = values.reduce((total, value) => {
    if (value === null) return total
    const [whole = '0', fraction = ''] = value.split('.')
    return total + Number(whole) * 1000 + Number(fraction.padEnd(3, '0'))
  }, 0)
  return `${Math.floor(thousandths / 1000)}.${String(thousandths % 1000).padStart(3, '0')}`
}

/** A stand-in for the API that filters the given rows like the real one and works the cards out from them. */
function statusApi(user: SessionUser, items: MasterStatusItem[], override?: (request: MockRequest) => MockReply | undefined) {
  return mockApi((request) => {
    const replaced = override?.(request)
    if (replaced) return replaced
    if (request.path === '/auth/me') return ok({ user })
    if (request.path === '/amc/master-status/options') return ok(OPTIONS)
    if (request.method === 'GET' && request.path === '/amc/master-status') {
      const q = request.query
      const search = q.get('search')?.toLowerCase()
      const selected = items.filter(
        (row) =>
          (!q.get('clientId') || row.client.id === q.get('clientId')) &&
          (!q.get('salesEngineerId') || row.salesEngineer?.id === q.get('salesEngineerId')) &&
          (!q.get('serviceStatus') || row.serviceStatus === q.get('serviceStatus')) &&
          (!q.get('colour') || row.colour === q.get('colour')) &&
          (!search || [row.reference, row.client.name, row.quotationNo ?? '', ...row.invoiceNumbers].some((text) => text.toLowerCase().includes(search))),
      )
      const count = (colour: string) => selected.filter((row) => row.colour === colour).length
      return ok({
        items: selected,
        total: selected.length,
        page: Number(q.get('page') ?? 1),
        pageSize: 50,
        kpis: {
          total: selected.length,
          green: count('GREEN'),
          blue: count('BLUE'),
          yellow: count('YELLOW'),
          red: count('RED'),
          totalValue: sum(selected.map((row) => row.visitValue)),
          valueMissing: selected.filter((row) => row.visitValue === null).length,
        },
      })
    }
    return undefined
  })
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter initialEntries={['/amc/master-status']}>
      <AppProviders client={client}>
        <Routes>
          <Route path="/amc/master-status" element={<MasterStatusPage />} />
          <Route path="/amc/contracts/:id" element={<h1>Contract detail stand-in</h1>} />
        </Routes>
      </AppProviders>
    </MemoryRouter>,
  )
}

const figures = () => within(screen.getByRole('group', { name: 'Master AMC Status figures' }))
const card = (label: string) => figures().getByText(label).parentElement?.parentElement as HTMLElement
const rowOf = (reference: string) => screen.getByText(reference).closest('tr') as HTMLElement
const headers = () => within(screen.getByRole('table')).getAllByRole('columnheader').map((cell) => cell.textContent)

beforeEach(() => signIn())
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('Master AMC Status page', () => {
  it('shows one coloured row per service, the six cards and every column in order', async () => {
    const api = statusApi(VIEWER, [RED, YELLOW, BLUE, GREEN, RENEWAL])
    renderPage()

    expect(await screen.findByRole('heading', { name: 'Master AMC Status' })).toBeInTheDocument()
    await screen.findByText('AMC-0007')
    expect(api.find('GET', '/amc/master-status')[0]?.query.has('month')).toBe(false)

    expect(headers()).toEqual(['#', 'AMC Reference', 'Client', 'System', 'Frequency', 'Service', 'Scheduled Month', 'Visit Value', 'Service Status', 'Invoice No.', 'Quote No.', 'Sales Engineer', 'Details'])
    expect(rowOf('AMC-0007')).toHaveAttribute('data-colour', 'RED')
    expect(rowOf('AMC-0008')).toHaveAttribute('data-colour', 'YELLOW')
    expect(rowOf('AMC-0009')).toHaveAttribute('data-colour', 'BLUE')
    expect(rowOf('AMC-0010')).toHaveAttribute('data-colour', 'GREEN')
    // Waiting for Renewal keeps its own label and is shown Red.
    expect(rowOf('AMC-0011')).toHaveAttribute('data-colour', 'RED')
    expect(within(rowOf('AMC-0011')).getByText('Waiting for Renewal')).toBeInTheDocument()

    // The counts animate up to their figure.
    await waitFor(() => {
      expect(card('Total Services')).toHaveTextContent('5')
      expect(card('Green Rows')).toHaveTextContent('1')
      expect(card('Blue Rows')).toHaveTextContent('1')
      expect(card('Yellow Rows')).toHaveTextContent('1')
      expect(card('Red Rows')).toHaveTextContent('2')
    })
    // 405 + 405 + 1234.5 + 405; the row without a value adds nothing and is reported.
    expect(card('Total Visit Value')).toHaveTextContent('2,449.500')
    expect(card('Total Visit Value')).toHaveTextContent('1 service has no value set')
  })

  it('shows every invoice of a visit, and a dash for a missing invoice, quotation or value', async () => {
    statusApi(VIEWER, [YELLOW, BLUE, GREEN])
    renderPage()

    await screen.findByText('AMC-0009')
    expect(within(rowOf('AMC-0009')).getByText('INV-1')).toBeInTheDocument()
    expect(within(rowOf('AMC-0009')).getByText('INV-2')).toBeInTheDocument()
    expect(within(rowOf('AMC-0010')).getByText('QT-55')).toBeInTheDocument()
    expect(within(rowOf('AMC-0010')).getByText('1,234.500')).toBeInTheDocument()
    expect(within(rowOf('AMC-0008')).getByText('No invoice recorded')).toBeInTheDocument()
    expect(within(rowOf('AMC-0008')).getByText('No quotation number recorded')).toBeInTheDocument()
    expect(within(rowOf('AMC-0008')).getByText('No visit value set')).toBeInTheDocument()
    // "N/A" is never shown as if it were a quotation number.
    expect(screen.queryByText('N/A')).not.toBeInTheDocument()
  })

  it('applies every filter together only on Apply, recalculates the cards, and resets', async () => {
    const api = statusApi(VIEWER, [RED, YELLOW, BLUE, GREEN, RENEWAL])
    renderPage()

    await screen.findByText('AMC-0007')
    await waitFor(() => expect(screen.getByRole('option', { name: 'Esha Engineer' })).toBeInTheDocument())
    const before = api.find('GET', '/amc/master-status').length
    await userEvent.type(screen.getByLabelText('Search'), 'inv-3')
    await userEvent.selectOptions(screen.getByLabelText('Client'), '10')
    await userEvent.selectOptions(screen.getByLabelText('Sales Engineer'), '4')
    await userEvent.selectOptions(screen.getByLabelText('Scheduled month'), '10')
    await userEvent.selectOptions(screen.getByLabelText('Scheduled year'), '2026')
    await userEvent.selectOptions(screen.getByLabelText('Service Status'), 'COMPLETED')
    await userEvent.selectOptions(screen.getByLabelText('Row Colour'), 'GREEN')
    // Nothing is requested until Apply.
    expect(api.find('GET', '/amc/master-status')).toHaveLength(before)

    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
    const expected = { search: 'inv-3', clientId: '10', salesEngineerId: '4', month: '10', year: '2026', serviceStatus: 'COMPLETED', colour: 'GREEN', page: '1', pageSize: '50' }
    await waitFor(() => expect(Object.fromEntries(api.find('GET', '/amc/master-status').at(-1)?.query ?? [])).toEqual(expected))
    await waitFor(() => expect(screen.queryByText('AMC-0007')).not.toBeInTheDocument())
    expect(screen.getByText('AMC-0010')).toBeInTheDocument()
    await waitFor(() => {
      expect(card('Total Services')).toHaveTextContent(/^Total Services1/)
      expect(card('Red Rows')).toHaveTextContent(/^Red Rows0/)
      // The counts animate for 800 ms; a busy full run needs more than the default wait.
    }, { timeout: 5000 })
    expect(card('Total Visit Value')).toHaveTextContent('1,234.500')

    await userEvent.click(screen.getByRole('button', { name: 'Reset' }))
    await waitFor(() => expect(Object.fromEntries(api.find('GET', '/amc/master-status').at(-1)?.query ?? [])).toEqual({ page: '1', pageSize: '50' }))
    expect(screen.getByLabelText('Search')).toHaveValue('')
    expect(await screen.findByText('AMC-0007')).toBeInTheDocument()
  })

  it('hides columns, keeps AMC Reference and View, remembers the choice and resets to default', async () => {
    statusApi(VIEWER, [GREEN])
    const view = renderPage()
    await screen.findByText('AMC-0010')

    await userEvent.click(screen.getByRole('button', { name: /Hide Columns/ }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.queryByRole('checkbox', { name: 'AMC Reference' })).not.toBeInTheDocument()
    await userEvent.click(dialog.getByRole('checkbox', { name: 'Visit Value' }))
    await userEvent.click(dialog.getByRole('checkbox', { name: 'Sales Engineer' }))
    await userEvent.click(dialog.getByRole('button', { name: 'Apply' }))

    expect(headers()).not.toContain('Visit Value')
    expect(headers()).not.toContain('Sales Engineer')
    expect(headers()).toContain('AMC Reference')
    expect(within(rowOf('AMC-0010')).getByRole('link', { name: 'View contract AMC-0010' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hide Columns · 8 of 10 shown' })).toBeInTheDocument()

    // Remembered for this user.
    view.unmount()
    renderPage()
    await screen.findByText('AMC-0010')
    expect(headers()).not.toContain('Visit Value')

    await userEvent.click(screen.getByRole('button', { name: /Hide Columns/ }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reset to Default' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Apply' }))
    expect(headers()).toContain('Visit Value')
    expect(headers()).toContain('Sales Engineer')
  })

  it('downloads Excel and PDF with the applied filters and the hidden columns', async () => {
    const saved: string[] = []
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:test', revokeObjectURL: () => undefined }))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download)
    })
    const api = statusApi(EXPORTER, [RED, GREEN], (request) => (request.path === '/amc/master-status/export' ? ok(null) : undefined))
    renderPage()

    await screen.findByText('AMC-0007')
    await userEvent.selectOptions(screen.getByLabelText('Row Colour'), 'RED')
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await userEvent.click(screen.getByRole('button', { name: /Hide Columns/ }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('checkbox', { name: 'System' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Apply' }))

    // One button per format; no duplicate print button.
    expect(within(screen.getByRole('group', { name: 'Export Master AMC Status' })).getAllByRole('button')).toHaveLength(2)
    await userEvent.click(screen.getByRole('button', { name: 'Export Master AMC Status to Excel' }))
    await waitFor(() => expect(saved).toEqual(['master-amc-status.xlsx']))
    expect(Object.fromEntries(api.find('GET', '/amc/master-status/export')[0]?.query ?? [])).toEqual({ colour: 'RED', hidden: 'system', format: 'xlsx' })
    await userEvent.click(screen.getByRole('button', { name: 'Export Master AMC Status to PDF' }))
    await waitFor(() => expect(api.find('GET', '/amc/master-status/export')[1]?.query.get('format')).toBe('pdf'))
  })

  it('offers no download without the export permission', async () => {
    statusApi(VIEWER, [RED])
    renderPage()
    await screen.findByText('AMC-0007')
    expect(screen.queryByRole('group', { name: 'Export Master AMC Status' })).not.toBeInTheDocument()
  })

  it('opens the contract detail page from View', async () => {
    statusApi(VIEWER, [BLUE])
    renderPage()

    const link = await screen.findByRole('link', { name: 'View contract AMC-0009' })
    expect(link).toHaveAttribute('href', '/amc/contracts/9')
    await userEvent.click(link)
    expect(await screen.findByRole('heading', { name: 'Contract detail stand-in' })).toBeInTheDocument()
  })

  it('shows the reason when the services cannot be loaded, and an empty state for no match', async () => {
    statusApi(VIEWER, [], (request) =>
      request.path === '/amc/master-status' && request.query.get('colour') !== 'GREEN' ? fail(503, 'FEATURE_UNAVAILABLE', 'This feature needs a database update that has not been applied yet.') : undefined,
    )
    renderPage()

    expect(await screen.findByText(/needs a database update/)).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('Row Colour'), 'GREEN')
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(await screen.findByText('No services found')).toBeInTheDocument()
  })

  it('stacks the cards and filters in one column on a phone-width screen', async () => {
    statusApi(VIEWER, [RED])
    renderPage()
    await screen.findByText('AMC-0007')
    // Single column by default; more columns only from the sm/lg breakpoints.
    expect(screen.getByRole('group', { name: 'Master AMC Status figures' })).toHaveClass('grid-cols-1')
    expect(screen.getByRole('form', { name: 'Filters' })).not.toHaveClass('grid-cols-2')
    expect(screen.getByRole('table').parentElement).toHaveClass('overflow-x-auto')
  })
})

describe('Master AMC Status routing and permissions', () => {
  it('is routed at /amc/master-status and listed once in the menu', async () => {
    statusApi(ADMIN, [RED])
    renderApp('/amc/master-status')

    expect(await screen.findByRole('heading', { name: 'Master AMC Status' })).toBeInTheDocument()
    const menu = within(screen.getByRole('navigation', { name: 'Main' }))
    expect(menu.getAllByRole('link', { name: 'Master AMC Status' })).toHaveLength(1)
    expect(menu.getByRole('link', { name: 'Master AMC Status' })).toHaveAttribute('href', '/amc/master-status')
  })

  it('stays hidden and closed for a user who may not view invoices, who still has Service Status', async () => {
    // Execution holds AMC_SCHEDULE and SERVICES_SALES view but not INVOICES.
    const user: SessionUser = { ...VIEWER, id: '9', roles: [{ id: '4', code: 'EXECUTION', name: 'Execution' }], permissions: ['AMC_SCHEDULE:VIEW', 'SERVICES_SALES:VIEW'] }
    const api = statusApi(user, [RED])
    renderApp('/amc/master-status')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    const menu = within(screen.getByRole('navigation', { name: 'Main' }))
    expect(menu.queryByRole('link', { name: 'Master AMC Status' })).not.toBeInTheDocument()
    expect(menu.getByRole('link', { name: 'Service Status' })).toBeInTheDocument()
    expect(api.find('GET', '/amc/master-status')).toHaveLength(0)
  })

  it('shows no View link to a user who may not open contracts', async () => {
    statusApi({ ...VIEWER, permissions: ['AMC_SCHEDULE:VIEW', 'INVOICES:VIEW', 'SERVICES_SALES:VIEW'] }, [RED])
    renderPage()
    await screen.findByText('AMC-0007')
    expect(within(rowOf('AMC-0007')).queryByRole('link')).not.toBeInTheDocument()
    expect(within(rowOf('AMC-0007')).getByText('No access')).toBeInTheDocument()
  })
})

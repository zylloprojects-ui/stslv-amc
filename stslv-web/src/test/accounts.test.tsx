import { QueryClient } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppProviders } from '../App'
import type { SessionUser } from '../lib/types'
import { AccountsPage } from '../pages/accounts/AccountsPage'
import type { AccountsItem } from '../pages/accounts/accountsTypes'
import { ADMIN, fail, mockApi, ok, renderApp, signIn, type MockReply, type MockRequest } from './helpers'

// Most tests render the page on its own; the routing tests go through App.tsx and the menu.

const VIEWER: SessionUser = {
  id: '7',
  email: 'accountant@example.com',
  fullName: 'Asha Accountant',
  roles: [{ id: '2', code: 'ACCOUNTANT', name: 'Accountant' }],
  permissions: ['ACCOUNTS:VIEW', 'AMC_CONTRACTS:VIEW'],
}
const INVOICER: SessionUser = { ...VIEWER, id: '8', permissions: [...VIEWER.permissions, 'INVOICES:CREATE'] }
const INVOICE_EDITOR: SessionUser = { ...VIEWER, id: '10', permissions: [...VIEWER.permissions, 'INVOICES:EDIT'] }
const EXPORTER: SessionUser = { ...VIEWER, id: '9', permissions: [...VIEWER.permissions, 'ACCOUNTS:EXPORT'] }

function makeItem(overrides: Partial<AccountsItem> = {}): AccountsItem {
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
    serviceReportNo: null,
    invoiceNumbers: [],
    manualInvoiceNo: null,
    paymentStatus: 'UNPAID',
    paidAt: null,
    updatedAt: '2026-10-01T08:00:00.000Z',
    salesEngineer: { id: '4', name: 'Esha Engineer' },
    colour: 'RED',
    ...overrides,
  }
}

const RED = makeItem()
const BLUE = makeItem({ id: '2', reference: 'AMC-0008', contract: { id: '8', status: 'ACTIVE' }, visitStatus: 'COMPLETED', serviceStatus: 'COMPLETED', completedDate: '2026-10-05', serviceReportNo: 'SR-14', colour: 'BLUE', visitValue: null })
const GREEN = makeItem({
  id: '3',
  reference: 'AMC-0009',
  contract: { id: '9', status: 'ACTIVE' },
  client: { id: '11', name: 'Beta Mall' },
  visitStatus: 'COMPLETED',
  serviceStatus: 'COMPLETED',
  serviceReportNo: 'SR-15',
  invoiceNumbers: ['INV-1', 'INV-2'],
  colour: 'GREEN',
  visitValue: '1234.500',
  salesEngineer: null,
})
const RENEWAL = makeItem({ id: '4', reference: 'AMC-0010', contract: { id: '10', status: 'EXPIRED' }, serviceStatus: 'WAITING_FOR_RENEWAL', colour: 'RED' })

const OPTIONS = {
  clients: [{ id: '10', name: 'Alpha Towers' }, { id: '11', name: 'Beta Mall' }],
  salesEngineers: [{ id: '4', name: 'Esha Engineer' }],
  contracts: [{ id: '7', reference: 'AMC-0007', client: 'Alpha Towers', system: 'FIRE' }],
  years: [2026, 2027],
}

/** Exact decimal sum in thousandths, so the stand-in totals like the API. */
const sum = (values: (string | null)[]) => {
  const thousandths = values.reduce((total, value) => {
    if (value === null) return total
    const [whole = '0', fraction = ''] = value.split('.')
    return total + Number(whole) * 1000 + Number(fraction.padEnd(3, '0'))
  }, 0)
  return `${Math.floor(thousandths / 1000)}.${String(thousandths % 1000).padStart(3, '0')}`
}

/** A stand-in for the API that filters the given rows like the real one and works the cards out from them. */
function accountsApi(user: SessionUser, items: AccountsItem[], override?: (request: MockRequest) => MockReply | undefined) {
  return mockApi((request) => {
    const replaced = override?.(request)
    if (replaced) return replaced
    if (request.path === '/auth/me') return ok({ user })
    if (request.path === '/accounts/options') return ok(OPTIONS)
    if (request.method === 'GET' && request.path === '/accounts') {
      const q = request.query
      const search = q.get('search')?.toLowerCase()
      const completed = (row: AccountsItem) => row.visitStatus === 'COMPLETED'
      const selected = items.filter(
        (row) =>
          (!q.get('clientId') || row.client.id === q.get('clientId')) &&
          (!q.get('salesEngineerId') || row.salesEngineer?.id === q.get('salesEngineerId')) &&
          (!q.get('serviceStatus') || (q.get('serviceStatus') === 'COMPLETED') === completed(row)) &&
          (!q.get('invoiceStatus') || (q.get('invoiceStatus') === 'RECORDED') === row.invoiceNumbers.length > 0) &&
          (!search || [row.reference, row.client.name, row.serviceReportNo ?? '', ...row.invoiceNumbers].some((text) => text.toLowerCase().includes(search))),
      )
      const done = selected.filter(completed).length
      return ok({
        items: selected,
        total: selected.length,
        page: Number(q.get('page') ?? 1),
        pageSize: 50,
        kpis: {
          rows: selected.length,
          completed: done,
          notCompleted: selected.length - done,
          invoiceFilled: selected.filter((row) => row.invoiceNumbers.length > 0).length,
          totalValue: sum(selected.map((row) => row.visitValue)),
          valueMissing: selected.filter((row) => row.visitValue === null).length,
          red: selected.filter((row) => row.colour === 'RED').length,
          blue: selected.filter((row) => row.colour === 'BLUE').length,
          green: selected.filter((row) => row.colour === 'GREEN').length,
        },
      })
    }
    return undefined
  })
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter initialEntries={['/finance/accounts']}>
      <AppProviders client={client}>
        <Routes>
          <Route path="/finance/accounts" element={<AccountsPage />} />
          <Route path="/amc/contracts/:id" element={<h1>Contract detail stand-in</h1>} />
          <Route path="/invoices" element={<h1>Invoice Tracking stand-in</h1>} />
        </Routes>
      </AppProviders>
    </MemoryRouter>,
  )
}

/** Generous wait for the figures when the whole suite runs at once. */
const COUNT_UP = { timeout: 5000 }

const figures = () => within(screen.getByRole('region', { name: 'Accounts figures' }))
const card = (id: string) => document.querySelector(`[data-kpi="${id}"]`) as HTMLElement
const cardOrder = () => [...document.querySelectorAll('[data-kpi]')].map((element) => element.getAttribute('data-kpi'))
const rowOf = (reference: string) => screen.getAllByText(reference)[0]?.closest('tr') as HTMLElement
const headers = () => within(screen.getByRole('table')).getAllByRole('columnheader').map((cell) => cell.textContent)

beforeEach(() => {
  signIn()
  // Reduced motion: the cards show their figure at once instead of counting up, so the checks do not depend on animation frames.
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('Accounts page', () => {
  it('shows one coloured row per service, the five cards from the API and every column in the written order', async () => {
    accountsApi(VIEWER, [RED, BLUE, GREEN, RENEWAL])
    renderPage()

    expect(await screen.findByRole('heading', { name: 'Accounts' })).toBeInTheDocument()
    await screen.findByText('AMC-0007')

    expect(headers()).toEqual([
      '#',
      'AMC Reference',
      'Client',
      'System',
      'Frequency',
      'Service',
      'Scheduled Month',
      'Service Status',
      'Service Report No.',
      'Value (Ex VAT, OMR)',
      'Invoice No.',
      'Zoho Invoice Value (Ex VAT, OMR)',
      'Sales Engineer',
    ])
    expect(rowOf('AMC-0007')).toHaveAttribute('data-colour', 'RED')
    expect(rowOf('AMC-0008')).toHaveAttribute('data-colour', 'BLUE')
    expect(rowOf('AMC-0009')).toHaveAttribute('data-colour', 'GREEN')
    // Waiting for Renewal keeps its own label and is shown Red.
    expect(rowOf('AMC-0010')).toHaveAttribute('data-colour', 'RED')
    expect(within(rowOf('AMC-0010')).getByText('Waiting for Renewal')).toBeInTheDocument()
    // Three colours only, none of Master AMC Status's.
    expect(screen.getByRole('list', { name: 'Row colours' }).children).toHaveLength(3)
    expect(screen.queryByText(/Yellow/)).not.toBeInTheDocument()

    expect(cardOrder()).toEqual(['rows', 'completed', 'notCompleted', 'invoiceFilled', 'totalValue'])
    await waitFor(() => {
      expect(card('rows')).toHaveTextContent(/Rows4/)
      expect(card('completed')).toHaveTextContent(/Completed2/)
      expect(card('notCompleted')).toHaveTextContent(/Not Completed2/)
      expect(card('invoiceFilled')).toHaveTextContent(/Invoice No. Filled1/)
    }, COUNT_UP)
    // 405 + 1234.5 + 405; the row without a value adds nothing and is reported.
    expect(card('totalValue')).toHaveTextContent('Total Value (Ex VAT)')
    expect(card('totalValue')).toHaveTextContent('2,044.500')
    expect(card('totalValue')).toHaveTextContent('1 service has no value set')
    // Approved: amounts are OMR excluding VAT, and the card says so.
    expect(card('totalValue')).toHaveTextContent('Ex VAT')
  })

  it('shows report and invoice numbers, never a payment status, and a dash for anything missing', async () => {
    accountsApi(VIEWER, [RED, BLUE, GREEN])
    renderPage()

    await screen.findByText('AMC-0009')
    expect(within(rowOf('AMC-0009')).getByText('Zoho: INV-1, INV-2')).toBeInTheDocument()
    expect(within(rowOf('AMC-0009')).getByText('SR-15')).toBeInTheDocument()
    expect(within(rowOf('AMC-0008')).getByText('Unpaid')).toBeInTheDocument()
    expect(within(rowOf('AMC-0007')).getByText('No service report number recorded')).toBeInTheDocument()
    expect(within(rowOf('AMC-0008')).getByText('No visit value set')).toBeInTheDocument()
    // A Zoho record alone does not make a service Paid: the manual Invoice No. decides.
    expect(within(rowOf('AMC-0009')).getByText('Unpaid')).toBeInTheDocument()
  })

  it('applies every filter together only on Apply, recalculates the cards, and resets', async () => {
    const api = accountsApi(VIEWER, [RED, BLUE, GREEN, RENEWAL])
    renderPage()

    await screen.findByText('AMC-0007')
    await waitFor(() => expect(screen.getByRole('option', { name: 'Esha Engineer' })).toBeInTheDocument())
    const before = api.find('GET', '/accounts').length
    await userEvent.type(screen.getByLabelText('Search'), 'sr-14')
    await userEvent.selectOptions(screen.getByLabelText('Client'), '10')
    await userEvent.selectOptions(screen.getByLabelText('Sales Engineer'), '4')
    await userEvent.selectOptions(screen.getByLabelText('Scheduled month'), '10')
    await userEvent.selectOptions(screen.getByLabelText('Scheduled year'), '2026')
    await userEvent.selectOptions(screen.getByLabelText('Paid / Unpaid'), 'NOT_RECORDED')
    await userEvent.selectOptions(screen.getByLabelText('Service Status'), 'COMPLETED')
    // Nothing is requested until Apply.
    expect(api.find('GET', '/accounts')).toHaveLength(before)

    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
    const expected = { search: 'sr-14', clientId: '10', salesEngineerId: '4', month: '10', year: '2026', invoiceStatus: 'NOT_RECORDED', serviceStatus: 'COMPLETED', page: '1', pageSize: '50' }
    await waitFor(() => expect(Object.fromEntries(api.find('GET', '/accounts').at(-1)?.query ?? [])).toEqual(expected))
    await waitFor(() => expect(screen.queryByText('AMC-0007')).not.toBeInTheDocument())
    expect(screen.getAllByText('AMC-0008').length).toBeGreaterThan(0)
    await waitFor(() => {
      expect(card('rows')).toHaveTextContent(/Rows1/)
      expect(card('notCompleted')).toHaveTextContent(/Not Completed0/)
    }, COUNT_UP)

    await userEvent.click(screen.getByRole('button', { name: 'Reset' }))
    await waitFor(() => expect(Object.fromEntries(api.find('GET', '/accounts').at(-1)?.query ?? [])).toEqual({ page: '1', pageSize: '50' }))
    expect(screen.getByLabelText('Search')).toHaveValue('')
    expect(await screen.findByText('AMC-0007')).toBeInTheDocument()
  })

  it('offers invoice-recorded filters, never paid / unpaid', async () => {
    accountsApi(VIEWER, [RED])
    renderPage()
    await screen.findByText('AMC-0007')

    const options = within(screen.getByLabelText('Paid / Unpaid')).getAllByRole('option').map((option) => option.textContent)
    expect(options).toEqual(['All', 'Paid', 'Unpaid'])
    expect(screen.getAllByText(/does not verify that money was received/).length).toBeGreaterThan(0)
  })

  it('renames and reorders the KPI cards, remembers them per user, and resets both', async () => {
    accountsApi(VIEWER, [RED, GREEN])
    const view = renderPage()
    await screen.findByText('AMC-0007')

    await userEvent.click(screen.getByRole('button', { name: 'Customize KPI cards' }))
    await userEvent.type(screen.getByLabelText('Display name for Rows'), 'Services')
    await userEvent.click(screen.getByRole('button', { name: 'Move Total Value (Ex VAT) earlier' }))
    expect(cardOrder()).toEqual(['rows', 'completed', 'notCompleted', 'totalValue', 'invoiceFilled'])
    await userEvent.click(screen.getByRole('button', { name: 'Customize KPI cards', pressed: true }))
    await waitFor(() => expect(card('rows')).toHaveTextContent(/^Services2/), COUNT_UP)

    view.unmount()
    renderPage()
    await screen.findByText('AMC-0007')
    expect(cardOrder()).toEqual(['rows', 'completed', 'notCompleted', 'totalValue', 'invoiceFilled'])
    await waitFor(() => expect(card('rows')).toHaveTextContent(/^Services/), COUNT_UP)

    await userEvent.click(screen.getByRole('button', { name: 'Reset KPI Names' }))
    await userEvent.click(screen.getByRole('button', { name: 'Reset KPI Order' }))
    expect(cardOrder()).toEqual(['rows', 'completed', 'notCompleted', 'invoiceFilled', 'totalValue'])
    expect(card('rows')).toHaveTextContent(/^Rows/)
    expect(screen.getByRole('button', { name: 'Reset KPI Names' })).toBeDisabled()
  })

  it('shows one Hide Columns control, beside Apply and Reset in the Filters section, not in the page header', async () => {
    accountsApi(EXPORTER, [GREEN])
    renderPage()
    await screen.findByText('AMC-0009')

    const buttons = screen.getAllByRole('button', { name: /Hide Columns/ })
    expect(buttons).toHaveLength(1)
    const filters = within(screen.getByRole('form', { name: 'Filters' }))
    expect(filters.getByRole('button', { name: 'Hide Columns · 11 of 11 shown' })).toBe(buttons[0])
    expect(filters.getByRole('button', { name: 'Apply' })).toBeInTheDocument()
    expect(filters.getByRole('button', { name: 'Reset' })).toBeInTheDocument()
    // Excel and PDF stay in the header, outside the filters.
    expect(filters.queryByRole('group', { name: 'Export Accounts' })).not.toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Export Accounts' })).toBeInTheDocument()

    // Opening the column chooser does not submit the filters, and Actions is not a choice.
    await userEvent.click(buttons[0])
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getAllByRole('checkbox')).toHaveLength(11)
    expect(dialog.queryByRole('checkbox', { name: 'Actions' })).not.toBeInTheDocument()
  })

  it('hides columns, keeps AMC Reference, remembers the choice and resets to default', async () => {
    accountsApi(VIEWER, [GREEN])
    const view = renderPage()
    await screen.findByText('AMC-0009')

    await userEvent.click(screen.getByRole('button', { name: /Hide Columns/ }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.queryByRole('checkbox', { name: 'AMC Reference' })).not.toBeInTheDocument()
    await userEvent.click(dialog.getByRole('checkbox', { name: 'Invoice No.' }))
    await userEvent.click(dialog.getByRole('checkbox', { name: 'Sales Engineer' }))
    await userEvent.click(dialog.getByRole('button', { name: 'Apply' }))

    expect(headers()).not.toContain('Invoice No.')
    expect(headers()).not.toContain('Sales Engineer')
    expect(headers()).toContain('AMC Reference')
    expect(headers()).not.toContain('Actions')
    expect(screen.getByRole('button', { name: 'Hide Columns · 9 of 11 shown' })).toBeInTheDocument()

    view.unmount()
    renderPage()
    await screen.findByText('AMC-0009')
    expect(headers()).not.toContain('Invoice No.')

    await userEvent.click(screen.getByRole('button', { name: /Hide Columns/ }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reset to Default' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Apply' }))
    expect(headers()).toContain('Invoice No.')
  })

  it('downloads Excel and PDF with the applied filters and the hidden columns', async () => {
    const saved: string[] = []
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:test', revokeObjectURL: () => undefined }))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download)
    })
    const api = accountsApi(EXPORTER, [RED, GREEN], (request) => (request.path === '/accounts/export' ? ok(null) : undefined))
    renderPage()

    await screen.findByText('AMC-0007')
    await userEvent.selectOptions(screen.getByLabelText('Paid / Unpaid'), 'RECORDED')
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await userEvent.click(screen.getByRole('button', { name: /Hide Columns/ }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('checkbox', { name: 'System' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Apply' }))

    await userEvent.click(screen.getByRole('button', { name: 'Export Accounts to Excel' }))
    await waitFor(() => expect(saved).toEqual(['accounts.xlsx']))
    expect(Object.fromEntries(api.find('GET', '/accounts/export')[0]?.query ?? [])).toEqual({ invoiceStatus: 'RECORDED', hidden: 'system', format: 'xlsx' })
    await userEvent.click(screen.getByRole('button', { name: 'Export Accounts to PDF' }))
    await waitFor(() => expect(api.find('GET', '/accounts/export')[1]?.query.get('format')).toBe('pdf'))
  })

  it('offers no download without the export permission', async () => {
    accountsApi(VIEWER, [RED])
    renderPage()
    await screen.findByText('AMC-0007')
    expect(screen.queryByRole('group', { name: 'Export Accounts' })).not.toBeInTheDocument()
  })

  it('links the AMC reference to the contract and has no Actions column, View or Record Zoho invoice button', async () => {
    accountsApi(INVOICER, [RED, BLUE, GREEN])
    renderPage()
    await screen.findByText('AMC-0008')

    expect(within(rowOf('AMC-0008')).getByRole('link', { name: 'Contract AMC-0008' })).toHaveAttribute('href', '/amc/contracts/8')
    expect(headers()).not.toContain('Actions')
    expect(screen.queryByRole('link', { name: /View contract/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Record a Zoho invoice/ })).not.toBeInTheDocument()
    // Every row has exactly one cell per header.
    for (const row of screen.getAllByRole('row').slice(1).filter((row) => row.closest('tfoot') === null)) expect(within(row).getAllByRole('cell')).toHaveLength(headers().length)
  })

  it('lets the Invoice No. be entered only on a completed service, each service on its own', async () => {
    const OTHER_OPEN = makeItem({ id: '5', reference: 'AMC-0008', contract: { id: '8', status: 'ACTIVE' }, service: { sequenceNo: 2, cycleNo: 1, serviceCode: 'Q2' } })
    const OPEN_PAID = makeItem({ id: '6', reference: 'AMC-0011', contract: { id: '11', status: 'ACTIVE' }, manualInvoiceNo: 'OLD-1', paymentStatus: 'PAID', colour: 'RED' })
    const api = accountsApi(INVOICE_EDITOR, [RED, BLUE, OTHER_OPEN, OPEN_PAID], (request) => (request.method === 'PATCH' ? ok({ id: '2' }) : undefined))
    renderPage()
    await screen.findByText('AMC-0011')

    // Not completed: field and OK disabled, with the reason.
    const open = within(rowOf('AMC-0007'))
    expect(open.getByLabelText('Invoice No. for AMC-0007 Q1')).toBeDisabled()
    expect(open.getByRole('button', { name: 'Save Invoice No. for AMC-0007 Q1' })).toBeDisabled()
    expect(open.getByText('Complete the service before entering an invoice number.')).toBeInTheDocument()

    // Two services of the same contract: Q1 completed and editable, Q2 not completed and disabled.
    const q1 = screen.getByLabelText('Invoice No. for AMC-0008 Q1')
    const q2 = screen.getByLabelText('Invoice No. for AMC-0008 Q2')
    expect(q1).toBeEnabled()
    expect(q2).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save Invoice No. for AMC-0008 Q2' })).toBeDisabled()

    // Not completed but already Paid: the number stays visible and may be cleared.
    const paid = screen.getByLabelText('Invoice No. for AMC-0011 Q1')
    expect(paid).toHaveValue('OLD-1')
    expect(paid).toHaveAttribute('readonly')
    expect(screen.getByRole('button', { name: 'Clear Invoice No. for AMC-0011 Q1' })).toBeEnabled()

    // Completed: a number is saved through the manual Invoice No. API of that service only.
    await userEvent.type(q1, 'INV-77')
    await userEvent.click(screen.getByRole('button', { name: 'Save Invoice No. for AMC-0008 Q1' }))
    await waitFor(() => expect(api.find('PATCH', '/amc/visits/2/manual-invoice')).toHaveLength(1))
    expect(api.find('PATCH', '/amc/visits/2/manual-invoice')[0]?.body).toEqual({ invoiceNo: 'INV-77', expectedUpdatedAt: BLUE.updatedAt })
    expect(api.find('PATCH', '/amc/visits/5/manual-invoice')).toHaveLength(0)
  })

  it('has no editable invoice field for a user who may not edit invoices', async () => {
    accountsApi(VIEWER, [BLUE])
    renderPage()
    await screen.findByText('AMC-0008')
    expect(within(rowOf('AMC-0008')).queryByRole('button', { name: /Record a Zoho invoice/ })).not.toBeInTheDocument()
    expect(within(rowOf('AMC-0008')).queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })

  it('shows the reason when the services cannot be loaded, and an empty state for no match', async () => {
    accountsApi(VIEWER, [], (request) =>
      request.path === '/accounts' && request.query.get('serviceStatus') !== 'COMPLETED' ? fail(503, 'FEATURE_UNAVAILABLE', 'This feature needs a database update that has not been applied yet.') : undefined,
    )
    renderPage()

    expect(await screen.findByText(/needs a database update/)).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('Service Status'), 'COMPLETED')
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(await screen.findByText('No services found')).toBeInTheDocument()
  })

  it('stacks the cards and filters in one column on a phone-width screen', async () => {
    accountsApi(VIEWER, [RED])
    renderPage()
    await screen.findByText('AMC-0007')
    expect(figures().getByRole('list')).toHaveClass('grid-cols-1')
    expect(screen.getByRole('form', { name: 'Filters' })).not.toHaveClass('grid-cols-2')
    expect(screen.getByRole('table').parentElement).toHaveClass('overflow-x-auto')
  })
})

describe('Accounts routing and permissions', () => {
  it('is routed at /finance/accounts and listed once in the menu under Finance', async () => {
    accountsApi(ADMIN, [RED])
    renderApp('/finance/accounts')

    expect(await screen.findByRole('heading', { name: 'Accounts' })).toBeInTheDocument()
    const menu = within(screen.getByRole('navigation', { name: 'Main' }))
    expect(menu.getAllByRole('link', { name: 'Accounts' })).toHaveLength(1)
    expect(menu.getByRole('link', { name: 'Accounts' })).toHaveAttribute('href', '/finance/accounts')
  })

  it('stays hidden and closed without its own permission', async () => {
    const user: SessionUser = { ...VIEWER, id: '10', roles: [{ id: '4', code: 'EXECUTION', name: 'Execution' }], permissions: ['AMC_SCHEDULE:VIEW', 'AMC_EXECUTION:VIEW', 'INVOICES:VIEW'] }
    const api = accountsApi(user, [RED])
    renderApp('/finance/accounts')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(within(screen.getByRole('navigation', { name: 'Main' })).queryByRole('link', { name: 'Accounts' })).not.toBeInTheDocument()
    expect(api.find('GET', '/accounts')).toHaveLength(0)
  })

  it('stays hidden for a user with Invoice Tracking only', async () => {
    const user: SessionUser = { ...VIEWER, id: '11', permissions: ['INVOICES:VIEW'] }
    accountsApi(user, [RED])
    renderApp('/finance/accounts')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(within(screen.getByRole('navigation', { name: 'Main' })).queryByRole('link', { name: 'Accounts' })).not.toBeInTheDocument()
  })

  it('shows the contract reference as plain text to a user who may not open contracts', async () => {
    accountsApi({ ...VIEWER, permissions: ['ACCOUNTS:VIEW'] }, [RED])
    renderPage()
    await screen.findByText('AMC-0007')
    expect(within(rowOf('AMC-0007')).queryByRole('link')).not.toBeInTheDocument()
    expect(within(rowOf('AMC-0007')).getByText('AMC-0007')).toBeInTheDocument()
  })
})

describe('Accounts contract filter', () => {
  it('offers the contracts and sends the choice to the list and the download', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:test', revokeObjectURL: () => undefined }))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const api = accountsApi(EXPORTER, [RED, GREEN], (request) => (request.path === '/accounts/export' ? ok(null) : undefined))
    renderPage()

    await screen.findByRole('option', { name: 'AMC-0007 · Alpha Towers · FIRE' })
    await userEvent.selectOptions(screen.getByLabelText('AMC Contract'), '7')
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(api.find('GET', '/accounts').at(-1)?.query.get('contractId')).toBe('7'))

    await userEvent.click(screen.getByRole('button', { name: 'Export Accounts to Excel' }))
    await waitFor(() => expect(api.find('GET', '/accounts/export')[0]?.query.get('contractId')).toBe('7'))
  })
})

describe('Accounts acknowledgement indicator (read only)', () => {
  it('shows the acknowledgement state beside the Invoice No. only when the API sends it, without changing Paid', async () => {
    const PAID_ACK = makeItem({ ...GREEN, id: '7', reference: 'AMC-0020', manualInvoiceNo: 'INV-77', paymentStatus: 'PAID', acknowledgementStatus: 'ACKNOWLEDGED' })
    const PAID_PENDING = makeItem({ ...GREEN, id: '8', reference: 'AMC-0021', manualInvoiceNo: 'INV-78', paymentStatus: 'PAID', acknowledgementStatus: 'PENDING' })
    accountsApi(VIEWER, [PAID_ACK, PAID_PENDING, RED])
    renderPage()
    await screen.findByText('AMC-0020')

    expect(within(rowOf('AMC-0020')).getByRole('link', { name: 'Ack: Acknowledged' })).toHaveAttribute('href', '/finance/invoice-acknowledgements')
    expect(within(rowOf('AMC-0021')).getByRole('link', { name: 'Ack: Pending' })).toBeInTheDocument()
    expect(within(rowOf('AMC-0007')).queryByText(/^Ack:/)).not.toBeInTheDocument()
    // Paid / Unpaid colours are untouched by the indicator.
    expect(rowOf('AMC-0021')).toHaveAttribute('data-colour', 'GREEN')
  })
})

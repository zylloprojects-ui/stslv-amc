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
  permissions: ['AMC_SCHEDULE:VIEW', 'INVOICES:VIEW', 'AMC_CONTRACTS:VIEW'],
}
const INVOICER: SessionUser = { ...VIEWER, id: '8', permissions: [...VIEWER.permissions, 'INVOICES:CREATE'] }
const EXPORTER: SessionUser = { ...VIEWER, id: '9', permissions: [...VIEWER.permissions, 'INVOICES:EXPORT'] }

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
    paymentStatus: 'NOT_AVAILABLE',
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
  it('shows one coloured row per service, the five cards from the API and every column in order', async () => {
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
      'Visit Value',
      'Service Status',
      'Service Report No.',
      'Invoice No.',
      'Paid / Unpaid',
      'Sales Engineer',
      'Actions',
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
    expect(card('totalValue')).toHaveTextContent('Total Visit Value')
    expect(card('totalValue')).toHaveTextContent('2,044.500')
    expect(card('totalValue')).toHaveTextContent('1 service has no value set')
    // Never labelled Ex VAT while the VAT basis is unconfirmed.
    expect(figures().queryByText(/Ex VAT/i)).not.toBeInTheDocument()
  })

  it('shows report and invoice numbers, never a payment status, and a dash for anything missing', async () => {
    accountsApi(VIEWER, [RED, BLUE, GREEN])
    renderPage()

    await screen.findByText('AMC-0009')
    expect(within(rowOf('AMC-0009')).getByText('INV-1')).toBeInTheDocument()
    expect(within(rowOf('AMC-0009')).getByText('INV-2')).toBeInTheDocument()
    expect(within(rowOf('AMC-0009')).getByText('SR-15')).toBeInTheDocument()
    expect(within(rowOf('AMC-0008')).getByText('No invoice recorded')).toBeInTheDocument()
    expect(within(rowOf('AMC-0007')).getByText('No service report number recorded')).toBeInTheDocument()
    expect(within(rowOf('AMC-0008')).getByText('No visit value set')).toBeInTheDocument()
    // An invoice number is not a payment.
    for (const reference of ['AMC-0007', 'AMC-0008', 'AMC-0009']) expect(within(rowOf(reference)).getByText('Not available')).toBeInTheDocument()
    expect(screen.queryByText(/^Paid$/)).not.toBeInTheDocument()
    expect(screen.queryByText(/^Unpaid$/)).not.toBeInTheDocument()
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
    await userEvent.selectOptions(screen.getByLabelText('Invoice Status'), 'NOT_RECORDED')
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

    const options = within(screen.getByLabelText('Invoice Status')).getAllByRole('option').map((option) => option.textContent)
    expect(options).toEqual(['All', 'Invoice recorded', 'No invoice recorded'])
    expect(screen.getByText(/Paid \/ Unpaid cannot be filtered/)).toBeInTheDocument()
  })

  it('renames and reorders the KPI cards, remembers them per user, and resets both', async () => {
    accountsApi(VIEWER, [RED, GREEN])
    const view = renderPage()
    await screen.findByText('AMC-0007')

    await userEvent.click(screen.getByRole('button', { name: 'Customize KPI cards' }))
    await userEvent.type(screen.getByLabelText('Display name for Rows'), 'Services')
    await userEvent.click(screen.getByRole('button', { name: 'Move Total Visit Value earlier' }))
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

  it('hides columns, keeps AMC Reference and Actions, remembers the choice and resets to default', async () => {
    accountsApi(VIEWER, [GREEN])
    const view = renderPage()
    await screen.findByText('AMC-0009')

    await userEvent.click(screen.getByRole('button', { name: /Hide Columns/ }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.queryByRole('checkbox', { name: 'AMC Reference' })).not.toBeInTheDocument()
    await userEvent.click(dialog.getByRole('checkbox', { name: 'Paid / Unpaid' }))
    await userEvent.click(dialog.getByRole('checkbox', { name: 'Sales Engineer' }))
    await userEvent.click(dialog.getByRole('button', { name: 'Apply' }))

    expect(headers()).not.toContain('Paid / Unpaid')
    expect(headers()).not.toContain('Sales Engineer')
    expect(headers()).toContain('AMC Reference')
    expect(headers()).toContain('Actions')
    expect(screen.getByRole('button', { name: 'Hide Columns · 9 of 11 shown' })).toBeInTheDocument()

    view.unmount()
    renderPage()
    await screen.findByText('AMC-0009')
    expect(headers()).not.toContain('Paid / Unpaid')

    await userEvent.click(screen.getByRole('button', { name: /Hide Columns/ }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reset to Default' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Apply' }))
    expect(headers()).toContain('Paid / Unpaid')
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
    await userEvent.selectOptions(screen.getByLabelText('Invoice Status'), 'RECORDED')
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

  it('links the AMC reference and View to the contract, and a Blue row to Invoice Tracking for an invoicing user', async () => {
    accountsApi(INVOICER, [RED, BLUE, GREEN])
    renderPage()
    await screen.findByText('AMC-0008')

    expect(within(rowOf('AMC-0008')).getByRole('link', { name: 'Contract AMC-0008' })).toHaveAttribute('href', '/amc/contracts/8')
    // Only a completed service without an invoice offers recording one; it opens Invoice Tracking and saves nothing here.
    expect(within(rowOf('AMC-0007')).queryByRole('link', { name: /Record an invoice/ })).not.toBeInTheDocument()
    expect(within(rowOf('AMC-0009')).queryByRole('link', { name: /Record an invoice/ })).not.toBeInTheDocument()
    // The link names the visit, so Invoice Tracking opens its form with that visit ticked.
    expect(within(rowOf('AMC-0008')).getByRole('link', { name: 'Record an invoice for AMC-0008 in Invoice Tracking' })).toHaveAttribute('href', `/invoices?recordForVisit=${BLUE.id}`)
    await userEvent.click(within(rowOf('AMC-0008')).getByRole('link', { name: 'Record an invoice for AMC-0008 in Invoice Tracking' }))
    expect(await screen.findByRole('heading', { name: 'Invoice Tracking stand-in' })).toBeInTheDocument()
  })

  it('offers no invoice link to a user who may not record invoices, and has no editable invoice field', async () => {
    accountsApi(VIEWER, [BLUE])
    renderPage()
    await screen.findByText('AMC-0008')
    expect(within(rowOf('AMC-0008')).queryByRole('link', { name: /Record an invoice/ })).not.toBeInTheDocument()
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

  it('stays hidden and closed for a user who may not view invoices', async () => {
    const user: SessionUser = { ...VIEWER, id: '10', roles: [{ id: '4', code: 'EXECUTION', name: 'Execution' }], permissions: ['AMC_SCHEDULE:VIEW', 'AMC_EXECUTION:VIEW'] }
    const api = accountsApi(user, [RED])
    renderApp('/finance/accounts')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(within(screen.getByRole('navigation', { name: 'Main' })).queryByRole('link', { name: 'Accounts' })).not.toBeInTheDocument()
    expect(api.find('GET', '/accounts')).toHaveLength(0)
  })

  it('stays hidden for a user with invoices but no schedule access', async () => {
    const user: SessionUser = { ...VIEWER, id: '11', permissions: ['INVOICES:VIEW'] }
    accountsApi(user, [RED])
    renderApp('/finance/accounts')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(within(screen.getByRole('navigation', { name: 'Main' })).queryByRole('link', { name: 'Accounts' })).not.toBeInTheDocument()
  })

  it('shows the contract reference as plain text and no View link to a user who may not open contracts', async () => {
    accountsApi({ ...VIEWER, permissions: ['AMC_SCHEDULE:VIEW', 'INVOICES:VIEW'] }, [RED])
    renderPage()
    await screen.findByText('AMC-0007')
    expect(within(rowOf('AMC-0007')).queryByRole('link')).not.toBeInTheDocument()
    expect(within(rowOf('AMC-0007')).getByText('No access')).toBeInTheDocument()
  })
})

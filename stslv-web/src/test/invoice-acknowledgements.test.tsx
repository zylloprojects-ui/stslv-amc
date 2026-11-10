import { QueryClient } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppProviders } from '../App'
import { HELP_TOPICS } from '../help/helpTopics'
import { helpTopicVisible } from '../help/helpModel'
import type { SessionUser } from '../lib/types'
import { InvoiceAcknowledgementsPage } from '../pages/invoiceAcknowledgements/InvoiceAcknowledgementsPage'
import type { AcknowledgementItem } from '../pages/invoiceAcknowledgements/invoiceAcknowledgementTypes'
import { ADMIN, fail, mockApi, ok, renderApp, signIn, type MockReply, type MockRequest } from './helpers'

// Finance -> Invoice Acknowledgements: one row per INVOICE. Most tests render the page alone over a stand-in API;
// navigation goes through App.tsx.

const base: SessionUser = { id: '20', email: 'ack@example.com', fullName: 'Amal Acknowledger', roles: [{ id: '9', code: 'CUSTOM', name: 'Custom' }], permissions: [] }
const VIEW_ONLY: SessionUser = { ...base, id: '21', permissions: ['INVOICE_ACKNOWLEDGEMENTS:VIEW'] }
// The approved defaults: Finance Executive View/Create/Export (+ Accounts); Admin View/Create/Edit/Export.
const FINANCE: SessionUser = { ...base, id: '22', roles: [{ id: '3', code: 'FINANCE_EXECUTIVE', name: 'Finance Executive' }], permissions: ['INVOICE_ACKNOWLEDGEMENTS:VIEW', 'INVOICE_ACKNOWLEDGEMENTS:CREATE', 'INVOICE_ACKNOWLEDGEMENTS:EXPORT', 'ACCOUNTS:VIEW', 'AMC_CONTRACTS:VIEW'] }
const ADMIN_ROLE: SessionUser = { ...FINANCE, id: '23', roles: [{ id: '2', code: 'ADMINISTRATOR', name: 'Admin' }], permissions: [...FINANCE.permissions, 'INVOICE_ACKNOWLEDGEMENTS:EDIT'] }
const VIEWER_ROLE: SessionUser = { ...base, id: '24', roles: [{ id: '6', code: 'VIEWER', name: 'Viewer' }], permissions: ['ACCOUNTS:VIEW', 'INVOICES:VIEW', 'DASHBOARD:VIEW'] }

const DOC = {
  attachmentId: '501',
  version: 1,
  originalName: 'Stamped INV-100.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 2048,
  uploadedBy: { id: '22', fullName: 'Amal Acknowledger' },
  uploadedAt: '2026-11-10T06:00:00.000Z',
}

function makeItem(overrides: Partial<AcknowledgementItem> = {}): AcknowledgementItem {
  return {
    invoiceId: '1',
    basis: 'ZOHO',
    invoiceNo: 'INV-100',
    client: { id: '10', name: 'Alpha Towers' },
    contracts: [{ id: '7', reference: 'STS-AMC-001', version: 1 }],
    serviceCount: 2,
    serviceReportNos: ['SR-1', 'SR-2'],
    invoiceDate: '2026-03-01',
    zohoCancelled: false,
    invoiceEnteredAt: '2026-03-01T05:00:00.000Z',
    amountsVisible: true,
    invoiceValue: '600.000',
    serviceValue: '600.000',
    status: 'PENDING',
    acknowledgementId: null,
    document: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    reconciliation: [],
    ...overrides,
  }
}

const MULTI = makeItem()
const RENEWAL = makeItem({ invoiceId: '2', basis: 'SERVICE', invoiceNo: 'INV-200', contracts: [{ id: '8', reference: 'STS-AMC-001 (V2)', version: 2 }], serviceCount: 1, invoiceDate: null, invoiceValue: null, serviceValue: '400.000' })
const DONE = makeItem({
  invoiceId: '3',
  invoiceNo: 'INV-300',
  client: { id: '11', name: 'Beta Mall' },
  contracts: [{ id: '9', reference: 'STS-AMC-002', version: 1 }],
  serviceCount: 1,
  status: 'ACKNOWLEDGED',
  acknowledgementId: '90',
  document: { ...DOC, attachmentId: '777', originalName: 'Beta ack.pdf' },
  acknowledgedAt: '2026-11-10T07:30:00.000Z',
  acknowledgedBy: { id: '22', fullName: 'Amal Acknowledger' },
})
const DUP_A = makeItem({ invoiceId: '4', basis: 'SERVICE', invoiceNo: 'INV-DUP', serviceCount: 1, invoiceDate: null, invoiceValue: null, reconciliation: ['SAME_NUMBER'] })

const OPTIONS = {
  clients: [{ id: '10', name: 'Alpha Towers' }, { id: '11', name: 'Beta Mall' }],
  contracts: [{ id: '7', reference: 'STS-AMC-001', client: 'Alpha Towers', system: 'FIRE' }],
  limits: { maxMb: 12, types: 'PDF, PNG and JPEG' },
}

const SERVICES = [
  { visitId: '31', contract: { id: '7', reference: 'STS-AMC-001', version: 1 }, service: { sequenceNo: 2, cycleNo: 1, serviceCode: 'Q2' }, scheduledDate: '2026-05-15', completedDate: '2026-05-16', serviceReportNo: 'SR-1', invoiceNo: 'INV-100', basis: 'ZOHO', linkedAt: '2026-11-10T06:00:00.000Z', serviceValue: '300.000' },
  { visitId: '32', contract: { id: '7', reference: 'STS-AMC-001', version: 1 }, service: { sequenceNo: 3, cycleNo: 1, serviceCode: 'Q3' }, scheduledDate: '2026-08-15', completedDate: '2026-08-16', serviceReportNo: 'SR-2', invoiceNo: 'INV-100', basis: 'ZOHO', linkedAt: '2026-11-10T06:00:00.000Z', serviceValue: '300.000' },
]

/** A stand-in for the API: filters like the real one; attach and confirm change the held rows only on success. */
function ackApi(user: SessionUser, start: AcknowledgementItem[], override?: (request: MockRequest) => MockReply | undefined) {
  let items = start.map((item) => ({ ...item }))
  const amounts = user.permissions.includes('ACCOUNTS:VIEW')
  const shape = (item: AcknowledgementItem) => (amounts ? item : { ...item, amountsVisible: false, serviceValue: null, invoiceValue: null })
  const replace = (next: AcknowledgementItem) => {
    items = items.map((item) => (item.invoiceId === next.invoiceId ? next : item))
    return ok(shape(next))
  }

  return mockApi((request) => {
    const replaced = override?.(request)
    if (replaced) return replaced
    if (request.path === '/auth/me') return ok({ user })
    if (request.path === '/invoice-acknowledgements/options') return ok(OPTIONS)
    if (request.method === 'GET' && request.path === '/invoice-acknowledgements') {
      const q = request.query
      const selected = items.filter(
        (row) =>
          (!q.get('status') || row.status === q.get('status')) &&
          (!q.get('reconciliation') || row.reconciliation.length > 0) &&
          (!q.get('clientId') || row.client.id === q.get('clientId')) &&
          (!q.get('invoiceNo') || row.invoiceNo.toLowerCase().includes(q.get('invoiceNo')!.toLowerCase())) &&
          (!q.get('search') || [row.invoiceNo, row.client.name, ...row.contracts.map((c) => c.reference)].some((text) => text.toLowerCase().includes(q.get('search')!.toLowerCase()))),
      )
      const acknowledged = selected.filter((row) => row.status === 'ACKNOWLEDGED').length
      return ok({
        items: selected.map(shape),
        total: selected.length,
        page: 1,
        pageSize: 50,
        kpis: {
          total: selected.length,
          pending: selected.length - acknowledged,
          awaitingConfirmation: selected.filter((row) => row.status === 'PENDING' && row.document).length,
          acknowledged,
          needsReconciliation: selected.filter((row) => row.reconciliation.length > 0).length,
          invoiceValueTotal: amounts ? '1200.000' : null,
          serviceValueTotal: amounts ? '1600.000' : null,
        },
      })
    }
    const match = /^\/invoice-acknowledgements\/(\d+)\/(document|confirm|replace|history|services|reconciliation|separate|link|choose|reassociate)$/.exec(request.path)
    const item = match ? items.find((row) => row.invoiceId === match[1]) : undefined
    if (match && item) {
      if (match[2] === 'document' && request.method === 'POST') return replace({ ...item, acknowledgementId: '95', document: { ...DOC, attachmentId: '601', originalName: 'chosen.pdf' } })
      if (match[2] === 'document' && request.method === 'DELETE') return replace({ ...item, document: null })
      if (match[2] === 'document' && request.method === 'GET') return ok({})
      if (match[2] === 'history') return ok(item.document ? [{ ...item.document, acknowledgementId: item.acknowledgementId, invoiceNumber: item.invoiceNo, isCurrent: true, ofCurrentAcknowledgement: true, acknowledgementStatus: item.status }] : [])
      if (match[2] === 'services') return ok(amounts ? SERVICES : SERVICES.map((service) => ({ ...service, serviceValue: null })))
      if (match[2] === 'reconciliation')
        return ok({
          reasons: item.reconciliation,
          sameNumber: item.reconciliation.includes('SAME_NUMBER') ? [{ invoiceId: '5', basis: 'SERVICE', serviceCount: 1, contracts: ['STS-AMC-001 (V2)'], status: 'PENDING', hasDocument: false }] : [],
          acknowledgements: [],
          replacements: item.zohoCancelled
            ? [
                { zohoInvoiceId: '70', invoiceNumber: item.invoiceNo, invoiceDate: '2026-04-01', verified: true, problem: null },
                { zohoInvoiceId: '71', invoiceNumber: item.invoiceNo, invoiceDate: '2026-04-02', verified: false, problem: "This record is allocated to 1 of the invoice's 2 services, so it cannot be verified as the same invoice." },
              ]
            : [],
        })
      if (match[2] === 'separate' || match[2] === 'link') return replace({ ...item, reconciliation: [], serviceCount: match[2] === 'link' ? 2 : item.serviceCount })
      if (match[2] === 'confirm') {
        if ((request.body as { attachmentId?: string }).attachmentId !== item.document?.attachmentId) return fail(409, 'CONFLICT', 'The attached document has changed since you selected it.')
        return replace({ ...item, status: 'ACKNOWLEDGED', acknowledgedAt: '2026-11-10T08:00:00.000Z', acknowledgedBy: { id: user.id, fullName: user.fullName } })
      }
      if (match[2] === 'replace') return replace({ ...item, document: { ...DOC, attachmentId: '888', version: 2, originalName: 'replacement.png', mimeType: 'image/png' } })
      if (match[2] === 'reassociate') return replace({ ...item, zohoCancelled: false, reconciliation: [], invoiceDate: '2026-04-01' })
    }
    return undefined
  })
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter initialEntries={['/finance/invoice-acknowledgements']}>
      <AppProviders client={client}>
        <Routes>
          <Route path="/finance/invoice-acknowledgements" element={<InvoiceAcknowledgementsPage />} />
          <Route path="/amc/contracts/:id" element={<h1>Contract detail stand-in</h1>} />
        </Routes>
      </AppProviders>
    </MemoryRouter>,
  )
}

const headers = () => within(screen.getByRole('table')).getAllByRole('columnheader').map((cell) => cell.textContent?.replace(/[▲▼↕]/g, '').trim())
const rowOf = (invoiceNo: string) => within(screen.getAllByRole('table')[0]!).getByText(invoiceNo).closest('tr') as HTMLElement
const pdf = (name = 'chosen.pdf', size = 10) => new File([new Uint8Array(size).fill(37)], name, { type: 'application/pdf' })

beforeEach(() => {
  signIn()
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('navigation and access', () => {
  it('appears as Invoice Ack under Accounts, after Invoices, and opens the page', async () => {
    ackApi(ADMIN, [MULTI])
    renderApp('/dashboard')

    await screen.findByRole('heading', { name: 'AMC Operations Dashboard' })
    const nav = screen.getByRole('navigation', { name: 'Main' })
    await userEvent.click(within(nav).getByRole('button', { name: 'Accounts' }))
    const links = within(nav).getAllByRole('link').map((link) => link.textContent)
    const accounts = ['Invoices', 'Invoice Ack', 'Invoice Tracking']
    expect(links.filter((text) => accounts.includes(text ?? ''))).toEqual(accounts)
    expect(within(nav).getByRole('link', { name: 'Invoice Ack' })).toHaveAttribute('href', '/finance/invoice-acknowledgements')

    await userEvent.click(within(nav).getByRole('link', { name: 'Invoice Ack' }))
    expect(await screen.findByRole('heading', { name: 'Invoice Acknowledgements' })).toBeInTheDocument()
    expect(document.title).toBe('Invoice Acknowledgements · STS-ELV AMC')
  })

  it('refuses the page to the Viewer role (no access by default), even with Accounts', async () => {
    ackApi(VIEWER_ROLE, [MULTI])
    renderApp('/finance/invoice-acknowledgements')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Invoice Ack' })).not.toBeInTheDocument()
  })

  it('opens the page for Finance Executive and Admin defaults', async () => {
    for (const user of [FINANCE, ADMIN_ROLE]) {
      ackApi(user, [MULTI])
      const view = renderApp('/finance/invoice-acknowledgements')
      expect(await screen.findByRole('heading', { name: 'Invoice Acknowledgements' })).toBeInTheDocument()
      view.unmount()
    }
  })

  it('shows the Help topic only to users who can open the page', () => {
    const topic = HELP_TOPICS.find((entry) => entry.id === 'invoice-acknowledgements')!
    const viewer = (permissions: string[]) => ({ can: (module: string) => permissions.includes(`${module}:VIEW`), canRead: () => false, isAdmin: false })

    expect(topic.guideChapter).toBe('Invoice Acknowledgements')
    expect(helpTopicVisible(topic, viewer(['INVOICE_ACKNOWLEDGEMENTS:VIEW']) as never)).toBe(true)
    expect(helpTopicVisible(topic, viewer(['ACCOUNTS:VIEW']) as never)).toBe(false)
    const text = JSON.stringify(topic)
    for (const phrase of ['OK / Confirm', 'green', 'Download', 'not payment', 'Linked Services', 'Reconcile', 'one acknowledgement']) expect(text).toContain(phrase)
  })
})

describe('one row per invoice', () => {
  it('shows the invoice columns, the renewal version, linked-service counts, the cards and status colours', async () => {
    ackApi(FINANCE, [MULTI, RENEWAL, DONE, DUP_A])
    renderPage()
    await screen.findByText('INV-100')

    expect(headers()).toEqual([
      '#',
      'Invoice No.',
      'Client',
      'AMC Contract / Version',
      'Invoice Date',
      'Invoice Value (Ex VAT, OMR)',
      'Service Value (Ex VAT, OMR)',
      'Linked Services',
      'Acknowledgement Status',
      'Acknowledged Date',
      'Acknowledged By',
      'Uploaded By',
      'Document',
      'Actions',
    ])
    expect(within(rowOf('INV-200')).getByText('STS-AMC-001 (V2)')).toBeInTheDocument()
    expect(within(rowOf('INV-100')).getByRole('button', { name: /View the 2 linked services of Invoice INV-100/ })).toHaveTextContent('2 services')
    expect(within(rowOf('INV-300')).getByText('Acknowledged').closest('[data-status]')).toHaveClass('bg-emerald-100', 'text-emerald-800')
    expect(within(rowOf('INV-100')).getByText('Pending').closest('[data-status]')).toHaveClass('bg-amber-100')
    expect(within(rowOf('INV-300')).getAllByText('Amal Acknowledger').length).toBeGreaterThan(0)
    expect(within(rowOf('INV-200')).getByTitle('No Invoice Tracking date recorded')).toBeInTheDocument()
    await waitFor(() => expect(document.querySelector('[data-kpi="reconcile"]')).toHaveTextContent(/Needs Reconciliation1/))
    expect(screen.getByText(/Total Filtered \(4 invoices, all pages, each invoice once\)/)).toBeInTheDocument()
  })

  it('opens the Linked Services viewer, with values only for Accounts viewers', async () => {
    ackApi(FINANCE, [MULTI])
    const view = renderPage()
    await screen.findByText('INV-100')
    await userEvent.click(within(rowOf('INV-100')).getByRole('button', { name: /linked services/ }))
    const dialog = screen.getByRole('dialog', { name: /Linked Services · Invoice INV-100/ })
    expect(await within(dialog).findByText('SR-1')).toBeInTheDocument()
    expect(within(dialog).getAllByText('300.000')).toHaveLength(2)
    expect(within(dialog).getAllByText('Invoice Tracking record')).toHaveLength(2)
    view.unmount()

    ackApi(VIEW_ONLY, [{ ...MULTI, amountsVisible: false }])
    renderPage()
    await screen.findByText('INV-100')
    await userEvent.click(within(rowOf('INV-100')).getByRole('button', { name: /linked services/ }))
    const hidden = screen.getByRole('dialog', { name: /Linked Services/ })
    expect(await within(hidden).findByText('SR-2')).toBeInTheDocument()
    expect(within(hidden).queryByText('300.000')).not.toBeInTheDocument()
  })

  it('leaves out amounts and actions for View only', async () => {
    ackApi(VIEW_ONLY, [MULTI, DONE])
    renderPage()
    await screen.findByText('INV-100')

    expect(headers()).not.toContain('Invoice Value (Ex VAT, OMR)')
    expect(headers()).not.toContain('Service Value (Ex VAT, OMR)')
    expect(screen.queryByText(/Total Filtered/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Attach acknowledgement/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Replace/ })).not.toBeInTheDocument()
    expect(within(rowOf('INV-300')).getByRole('button', { name: /View the acknowledgement document/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Excel/ })).not.toBeInTheDocument()
  })

  it('applies search and filters through the API, sorts by a column, and resets', async () => {
    const api = ackApi(FINANCE, [MULTI, RENEWAL, DONE, DUP_A])
    renderPage()
    await screen.findByText('INV-100')

    await userEvent.type(screen.getByLabelText('Search'), 'Beta')
    await userEvent.selectOptions(screen.getByLabelText('Acknowledgement'), 'ACKNOWLEDGED')
    await userEvent.type(screen.getByLabelText('Invoice No.'), 'INV-3')
    await userEvent.selectOptions(screen.getByLabelText('Date filter'), 'ACKNOWLEDGED_DATE')
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(screen.queryByText('INV-100')).not.toBeInTheDocument())
    expect(screen.getByText('INV-300')).toBeInTheDocument()
    const last = api.find('GET', '/invoice-acknowledgements').at(-1)!.query
    expect([last.get('search'), last.get('status'), last.get('invoiceNo'), last.get('dateBasis')]).toEqual(['Beta', 'ACKNOWLEDGED', 'INV-3', 'ACKNOWLEDGED_DATE'])

    await userEvent.click(screen.getByRole('button', { name: 'Reset' }))
    await screen.findByText('INV-100')
    await userEvent.selectOptions(screen.getByLabelText('Reconciliation'), 'NEEDED')
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(screen.queryByText('INV-100')).not.toBeInTheDocument())
    expect(screen.getByText('INV-DUP')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }))
    await screen.findByText('INV-100')

    await userEvent.click(screen.getByRole('button', { name: /^Invoice No\./ }))
    await waitFor(() => expect(api.find('GET', '/invoice-acknowledgements').at(-1)!.query.get('sort')).toBe('invoiceNo'))
    expect(screen.getByRole('columnheader', { name: /Invoice No\./ })).toHaveAttribute('aria-sort', 'ascending')
    await userEvent.click(screen.getByRole('button', { name: /^Invoice No\./ }))
    await waitFor(() => expect(api.find('GET', '/invoice-acknowledgements').at(-1)!.query.get('dir')).toBe('desc'))
  })

  it('refuses a From date after the To date before asking the API', async () => {
    const api = ackApi(FINANCE, [MULTI])
    renderPage()
    await screen.findByText('INV-100')
    const before = api.find('GET', '/invoice-acknowledgements').length

    await userEvent.type(screen.getByLabelText('From'), '2026-05-01')
    await userEvent.type(screen.getByLabelText('To'), '2026-04-01')
    expect(screen.getByRole('alert')).toHaveTextContent('The From date must be on or before the To date.')
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    expect(api.find('GET', '/invoice-acknowledgements')).toHaveLength(before)
  })

  it('hides and shows columns, remembered per user, and sends them to the export', async () => {
    const api = ackApi(FINANCE, [MULTI])
    renderPage()
    await screen.findByText('INV-100')

    await userEvent.click(screen.getByRole('button', { name: /Hide Columns/ }))
    const dialog = screen.getByRole('dialog', { name: 'Hide columns' })
    await userEvent.click(within(dialog).getByLabelText('Document'))
    await userEvent.click(within(dialog).getByLabelText('Uploaded By'))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }))

    expect(headers()).not.toContain('Document')
    expect(headers()).not.toContain('Uploaded By')
    expect(JSON.parse(localStorage.getItem('stslev.invoice-acknowledgements.hidden-columns.22') ?? '[]')).toEqual(['document', 'uploadedBy'])

    await userEvent.click(screen.getByRole('button', { name: /Excel/ }))
    await waitFor(() => expect(api.find('GET', '/invoice-acknowledgements/export')).toHaveLength(1))
    expect(api.find('GET', '/invoice-acknowledgements/export')[0]!.query.get('hidden')).toBe('document,uploadedBy')
  })

  it('shows an error with Try again when the list cannot load', async () => {
    let failing = true
    ackApi(FINANCE, [MULTI], (request) => (failing && request.path === '/invoice-acknowledgements' ? fail(503, 'FEATURE_UNAVAILABLE', 'Invoice Acknowledgements need a database update.') : undefined))
    renderPage()

    expect(await screen.findByText(/need a database update/)).toBeInTheDocument()
    failing = false
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('INV-100')).toBeInTheDocument()
  })
})

describe('attach and confirm', () => {
  it('uploads one document for the invoice, shows its name, and turns green only after OK / Confirm succeeds', async () => {
    const api = ackApi(FINANCE, [MULTI])
    renderPage()
    await screen.findByText('INV-100')

    await userEvent.click(within(rowOf('INV-100')).getByRole('button', { name: /Attach acknowledgement for Invoice INV-100 · Alpha Towers/ }))
    const dialog = screen.getByRole('dialog', { name: /Attach Acknowledgement/ })
    expect(within(dialog).getByText(/2 services on this invoice: one acknowledgement covers them all/)).toBeInTheDocument()
    const confirm = within(dialog).getByRole('button', { name: /OK, confirm/ })
    expect(confirm).toBeDisabled()

    await userEvent.upload(within(dialog).getByTestId('acknowledgement-file'), pdf())
    expect(await within(dialog).findByTestId('selected-document')).toHaveTextContent('chosen.pdf')
    expect(api.find('POST', '/invoice-acknowledgements/1/document')).toHaveLength(1)
    await waitFor(() => expect(rowOf('INV-100')).toHaveAttribute('data-status', 'PENDING'))
    expect(within(dialog).getByText(/still Pending/)).toBeInTheDocument()

    await userEvent.click(confirm)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('POST', '/invoice-acknowledgements/1/confirm')[0]!.body).toEqual({ attachmentId: '601' })
    expect(await screen.findByText(/INV-100 \(Alpha Towers\) is now Acknowledged/)).toBeInTheDocument()
    await waitFor(() => expect(rowOf('INV-100')).toHaveAttribute('data-status', 'ACKNOWLEDGED'))
    expect(within(rowOf('INV-100')).getByText('Acknowledged').closest('[data-status]')).toHaveClass('bg-emerald-100')
  })

  it('keeps the invoice Pending and shows the message when confirmation fails', async () => {
    ackApi(FINANCE, [makeItem({ document: DOC, acknowledgementId: '95' })], (request) =>
      request.path === '/invoice-acknowledgements/1/confirm' ? fail(404, 'FILE_MISSING', 'The attached document could not be found in storage. Attach it again, then confirm.') : undefined,
    )
    renderPage()
    await screen.findByText('INV-100')
    expect(within(rowOf('INV-100')).getByText(/awaiting OK \/ Confirm/)).toBeInTheDocument()

    await userEvent.click(within(rowOf('INV-100')).getByRole('button', { name: /Review and confirm/ }))
    const dialog = screen.getByRole('dialog', { name: /Attach Acknowledgement/ })
    await userEvent.click(within(dialog).getByRole('button', { name: /OK, confirm/ }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('could not be found in storage')
    expect(rowOf('INV-100')).toHaveAttribute('data-status', 'PENDING')
    expect(screen.queryByText(/is now Acknowledged/)).not.toBeInTheDocument()
  })

  it('checks type and size before uploading, and shows a server refusal', async () => {
    const api = ackApi(FINANCE, [MULTI], (request) =>
      request.method === 'POST' && request.path === '/invoice-acknowledgements/1/document' ? fail(400, 'VALIDATION_ERROR', 'Only PDF, PNG and JPEG files can be uploaded as an acknowledgement.') : undefined,
    )
    renderPage()
    await screen.findByText('INV-100')
    await userEvent.click(within(rowOf('INV-100')).getByRole('button', { name: /Attach acknowledgement/ }))
    const dialog = screen.getByRole('dialog', { name: /Attach Acknowledgement/ })
    const input = within(dialog).getByTestId('acknowledgement-file')

    await userEvent.upload(input, new File(['x'], 'notes.txt', { type: 'text/plain' }), { applyAccept: false })
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Only PDF, PNG and JPEG files')
    await userEvent.upload(input, pdf('huge.pdf', 12 * 1024 * 1024 + 1))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('at most 12 MB')
    expect(api.find('POST', '/invoice-acknowledgements/1/document')).toHaveLength(0)

    await userEvent.upload(input, pdf('fake.pdf'))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Only PDF, PNG and JPEG files')
    expect(within(dialog).getByRole('button', { name: /OK, confirm/ })).toBeDisabled()
  })

  it('removes an attached document before confirming', async () => {
    const api = ackApi(FINANCE, [makeItem({ document: DOC, acknowledgementId: '95' })])
    renderPage()
    await screen.findByText('INV-100')
    await userEvent.click(within(rowOf('INV-100')).getByRole('button', { name: /Review and confirm/ }))
    const dialog = screen.getByRole('dialog', { name: /Attach Acknowledgement/ })

    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(within(dialog).queryByTestId('selected-document')).not.toBeInTheDocument())
    expect(api.find('DELETE', '/invoice-acknowledgements/1/document')).toHaveLength(1)
  })
})

describe('reconciliation', () => {
  it('blocks acknowledgement on a flagged invoice and lets only Edit reconcile it', async () => {
    ackApi(FINANCE, [DUP_A])
    const view = renderPage()
    await screen.findByText('INV-DUP')
    expect(within(rowOf('INV-DUP')).getByText('Needs reconciliation')).toBeInTheDocument()
    expect(within(rowOf('INV-DUP')).queryByRole('button', { name: /Attach/ })).not.toBeInTheDocument()
    expect(within(rowOf('INV-DUP')).queryByRole('button', { name: /Reconcile/ })).not.toBeInTheDocument()
    expect(within(rowOf('INV-DUP')).getByText(/Waiting for an authorised user/)).toBeInTheDocument()
    view.unmount()

    const api = ackApi(ADMIN_ROLE, [DUP_A])
    renderPage()
    await screen.findByText('INV-DUP')
    await userEvent.click(within(rowOf('INV-DUP')).getByRole('button', { name: /Reconcile Invoice INV-DUP/ }))
    const dialog = screen.getByRole('dialog', { name: /Reconcile/ })
    const link = await within(dialog).findByRole('button', { name: 'Link as one invoice' })
    expect(link).toBeDisabled()
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Both services are on one invoice')
    await userEvent.click(link)

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('POST', '/invoice-acknowledgements/4/link')[0]!.body).toEqual({ otherInvoiceId: '5', reason: 'Both services are on one invoice' })
    expect(await screen.findByText(/linked as one invoice/)).toBeInTheDocument()
  })
})

describe('cancelled Invoice Tracking record', () => {
  const CANCELLED = makeItem({ invoiceId: '6', invoiceNo: 'INV-600', zohoCancelled: true, invoiceDate: null, invoiceValue: null, reconciliation: ['ZOHO_CANCELLED'] })

  it('warns without blocking acknowledgement, and re-associates only a verified record with a reason', async () => {
    const api = ackApi(ADMIN_ROLE, [CANCELLED])
    renderPage()
    await screen.findByText('INV-600')
    expect(within(rowOf('INV-600')).getByText('Invoice Tracking record cancelled')).toBeInTheDocument()
    expect(within(rowOf('INV-600')).queryByText('Needs reconciliation')).not.toBeInTheDocument()
    expect(within(rowOf('INV-600')).getByRole('button', { name: /Attach acknowledgement/ })).toBeInTheDocument()

    await userEvent.click(within(rowOf('INV-600')).getByRole('button', { name: /Reconcile Invoice INV-600/ }))
    const dialog = screen.getByRole('dialog', { name: /Reconcile/ })
    expect(await within(dialog).findByText(/cannot be verified as the same invoice/)).toBeInTheDocument()
    const buttons = within(dialog).getAllByRole('button', { name: 'Re-associate' })
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toBeDisabled()
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Re-entered in Zoho')
    await userEvent.click(buttons[0]!)

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('POST', '/invoice-acknowledgements/6/reassociate')[0]!.body).toEqual({ zohoInvoiceId: '70', reason: 'Re-entered in Zoho' })
    expect(await screen.findByText(/now refers to its re-entered Invoice Tracking record/)).toBeInTheDocument()
  })
})

describe('viewer and replacement', () => {
  it('opens the document in a viewer with Download inside it, fetched with the user token', async () => {
    const created = vi.fn(() => 'blob:ack')
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }))
    const api = ackApi(VIEW_ONLY, [DONE])
    renderPage()
    await screen.findByText('INV-300')

    await userEvent.click(within(rowOf('INV-300')).getByRole('button', { name: /View the acknowledgement document/ }))
    const dialog = screen.getByRole('dialog', { name: /Acknowledgement · Invoice INV-300 · Beta Mall/ })
    expect(await within(dialog).findByTitle(/Acknowledgement document of/)).toHaveAttribute('src', 'blob:ack')
    expect(api.find('GET', '/invoice-acknowledgements/3/document')[0]!.authorization).toBe('Bearer test-token')

    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    await userEvent.click(within(dialog).getByRole('button', { name: /Download the acknowledgement document/ }))
    expect(click).toHaveBeenCalled()
  })

  it('replaces an acknowledged document only with Edit and a reason', async () => {
    ackApi(ADMIN_ROLE, [DONE])
    renderPage()
    await screen.findByText('INV-300')

    await userEvent.click(within(rowOf('INV-300')).getByRole('button', { name: /Replace the acknowledgement document/ }))
    const dialog = screen.getByRole('dialog', { name: /Replace Document/ })
    const submit = within(dialog).getByRole('button', { name: 'Replace Document' })
    expect(submit).toBeDisabled()

    await userEvent.upload(within(dialog).getByTestId('replacement-file'), new File([new Uint8Array(8)], 'replacement.png', { type: 'image/png' }))
    expect(submit).toBeDisabled()
    await userEvent.type(within(dialog).getByLabelText(/Reason for replacing/), 'Clearer scan')
    await userEvent.click(submit)

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const call = vi.mocked(fetch).mock.calls.find(([url]) => String(url).includes('/invoice-acknowledgements/3/replace'))!
    expect((call[1]!.headers as Record<string, string>)['X-Replace-Reason']).toBe(encodeURIComponent('Clearer scan'))
    expect(await screen.findByText(/was replaced\. The earlier version is kept/)).toBeInTheDocument()
  })

  it('offers no Replace to Finance (Create without Edit)', async () => {
    ackApi(FINANCE, [DONE])
    renderPage()
    await screen.findByText('INV-300')
    expect(within(rowOf('INV-300')).queryByRole('button', { name: /Replace/ })).not.toBeInTheDocument()
    expect(within(rowOf('INV-300')).queryByRole('button', { name: /Attach/ })).not.toBeInTheDocument()
  })
})

describe('mobile layout', () => {
  it('keeps the table in a horizontal scroll area and stacks filters and cards on small screens', async () => {
    ackApi(FINANCE, [MULTI])
    renderPage()
    await screen.findByText('INV-100')

    expect(screen.getByRole('table').parentElement).toHaveClass('overflow-x-auto')
    expect(screen.getByRole('form', { name: 'Filters' })).toHaveClass('grid', 'sm:grid-cols-2', 'lg:grid-cols-4')
    expect(screen.getByRole('region', { name: 'Invoice acknowledgement figures' }).querySelector('ul')).toHaveClass('grid-cols-1', 'sm:grid-cols-2')
  })
})

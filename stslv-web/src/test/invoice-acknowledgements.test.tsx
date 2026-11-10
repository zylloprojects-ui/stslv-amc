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

// Finance -> Invoice Acknowledgements. Most tests render the page alone over a stand-in API; navigation goes through App.tsx.

const base: SessionUser = { id: '20', email: 'ack@example.com', fullName: 'Amal Acknowledger', roles: [{ id: '9', code: 'CUSTOM', name: 'Custom' }], permissions: [] }
const VIEWER: SessionUser = { ...base, id: '21', permissions: ['INVOICE_ACKNOWLEDGEMENTS:VIEW'] }
const ACKNOWLEDGER: SessionUser = { ...base, id: '22', permissions: ['INVOICE_ACKNOWLEDGEMENTS:VIEW', 'INVOICE_ACKNOWLEDGEMENTS:CREATE', 'ACCOUNTS:VIEW', 'AMC_CONTRACTS:VIEW'] }
const EDITOR: SessionUser = { ...ACKNOWLEDGER, id: '23', permissions: [...ACKNOWLEDGER.permissions, 'INVOICE_ACKNOWLEDGEMENTS:EDIT', 'INVOICE_ACKNOWLEDGEMENTS:EXPORT'] }
const FINANCE: SessionUser = { ...base, id: '24', permissions: ['ACCOUNTS:VIEW', 'INVOICES:VIEW'] }

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
    visitId: '1',
    acknowledgementId: null,
    reference: 'STS-AMC-001',
    contract: { id: '7', version: 1 },
    client: { id: '10', name: 'Alpha Towers' },
    system: { description: 'FIRE', typeName: 'Fire Alarm' },
    service: { sequenceNo: 1, cycleNo: 1, serviceCode: 'Q1' },
    scheduledDate: '2026-02-15',
    completedDate: '2026-02-16',
    serviceReportNo: 'SR-1',
    invoiceNo: 'INV-100',
    invoiceEnteredAt: '2026-03-01T05:00:00.000Z',
    invoiceDate: '2026-03-01',
    amountsVisible: true,
    serviceValue: '300.000',
    invoiceValue: '300.000',
    status: 'PENDING',
    document: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    ...overrides,
  }
}

const PENDING = makeItem()
const RENEWAL = makeItem({ visitId: '2', reference: 'STS-AMC-001 (V2)', contract: { id: '8', version: 2 }, invoiceNo: 'INV-200', invoiceDate: null, invoiceValue: null, serviceValue: '400.000' })
const DONE = makeItem({
  visitId: '3',
  acknowledgementId: '90',
  reference: 'STS-AMC-002',
  contract: { id: '9', version: 1 },
  client: { id: '11', name: 'Beta Mall' },
  invoiceNo: 'INV-300',
  status: 'ACKNOWLEDGED',
  document: { ...DOC, attachmentId: '777', originalName: 'Beta ack.pdf' },
  acknowledgedAt: '2026-11-10T07:30:00.000Z',
  acknowledgedBy: { id: '22', fullName: 'Amal Acknowledger' },
})

const OPTIONS = {
  clients: [{ id: '10', name: 'Alpha Towers' }, { id: '11', name: 'Beta Mall' }],
  contracts: [{ id: '7', reference: 'STS-AMC-001', client: 'Alpha Towers', system: 'FIRE' }],
  limits: { maxMb: 12, types: 'PDF, PNG and JPEG' },
}

/** A stand-in for the API: filters like the real one; attach and confirm change the held rows only on success. */
function ackApi(user: SessionUser, start: AcknowledgementItem[], override?: (request: MockRequest) => MockReply | undefined) {
  let items = start.map((item) => ({ ...item }))
  const amounts = user.permissions.includes('ACCOUNTS:VIEW')
  const shape = (item: AcknowledgementItem) => (amounts ? item : { ...item, amountsVisible: false, serviceValue: null, invoiceValue: null })
  const replace = (next: AcknowledgementItem) => {
    items = items.map((item) => (item.visitId === next.visitId ? next : item))
    return ok(shape(next))
  }

  const mock = mockApi((request) => {
    const replaced = override?.(request)
    if (replaced) return replaced
    if (request.path === '/auth/me') return ok({ user })
    if (request.path === '/invoice-acknowledgements/options') return ok(OPTIONS)
    if (request.method === 'GET' && request.path === '/invoice-acknowledgements') {
      const q = request.query
      const selected = items.filter(
        (row) =>
          (!q.get('status') || row.status === q.get('status')) &&
          (!q.get('clientId') || row.client.id === q.get('clientId')) &&
          (!q.get('invoiceNo') || row.invoiceNo.toLowerCase().includes(q.get('invoiceNo')!.toLowerCase())) &&
          (!q.get('search') || [row.reference, row.client.name, row.invoiceNo].some((text) => text.toLowerCase().includes(q.get('search')!.toLowerCase()))),
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
          serviceValueTotal: amounts ? '1000.000' : null,
          invoiceValueTotal: amounts ? '600.000' : null,
        },
      })
    }
    const match = /^\/invoice-acknowledgements\/(\d+)\/(document|confirm|replace|history)$/.exec(request.path)
    const item = match ? items.find((row) => row.visitId === match[1]) : undefined
    if (match && item) {
      if (match[2] === 'document' && request.method === 'POST') return replace({ ...item, acknowledgementId: '95', document: { ...DOC, attachmentId: '601', originalName: 'chosen.pdf' } })
      if (match[2] === 'document' && request.method === 'DELETE') return replace({ ...item, document: null })
      if (match[2] === 'document' && request.method === 'GET') return ok({})
      if (match[2] === 'history') return ok(item.document ? [{ ...item.document, invoiceNumber: item.invoiceNo, isCurrent: true }] : [])
      if (match[2] === 'confirm') {
        if ((request.body as { attachmentId?: string }).attachmentId !== item.document?.attachmentId) return fail(409, 'CONFLICT', 'The attached document has changed since you selected it.')
        return replace({ ...item, status: 'ACKNOWLEDGED', acknowledgedAt: '2026-11-10T08:00:00.000Z', acknowledgedBy: { id: user.id, fullName: user.fullName } })
      }
      if (match[2] === 'replace') return replace({ ...item, document: { ...DOC, attachmentId: '888', version: 2, originalName: 'replacement.png', mimeType: 'image/png' } })
    }
    return undefined
  })
  return mock
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
const rowOf = (invoiceNo: string) => within(screen.getByRole('table')).getByText(invoiceNo).closest('tr') as HTMLElement
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
  it('appears under Finance after Accounts, keeping the other Finance entries, and opens the page', async () => {
    ackApi(ADMIN, [PENDING])
    renderApp('/dashboard')

    await screen.findByRole('heading', { name: 'AMC Operations Dashboard' })
    const nav = screen.getByRole('navigation', { name: 'Main' })
    await userEvent.click(within(nav).getByRole('button', { name: 'Finance' }))
    const links = within(nav).getAllByRole('link').map((link) => link.textContent)
    const finance = ['Invoice Tracking', 'Accounts', 'Invoice Acknowledgements', 'Service Sales']
    expect(links.filter((text) => finance.includes(text ?? ''))).toEqual(finance)

    await userEvent.click(within(nav).getByRole('link', { name: 'Invoice Acknowledgements' }))
    expect(await screen.findByRole('heading', { name: 'Invoice Acknowledgements' })).toBeInTheDocument()
    expect(document.title).toBe('Invoice Acknowledgements · STS-ELV AMC')
  })

  it('hides the entry and refuses the page to a role without the module, even with Accounts', async () => {
    ackApi(FINANCE, [PENDING])
    renderApp('/finance/invoice-acknowledgements')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Invoice Acknowledgements' })).not.toBeInTheDocument()
  })

  it('shows the Help topic only to users who can open the page', () => {
    const topic = HELP_TOPICS.find((entry) => entry.id === 'invoice-acknowledgements')!
    const viewer = (permissions: string[]) => ({ can: (module: string) => permissions.includes(`${module}:VIEW`), canRead: () => false, isAdmin: false })

    expect(topic.guideChapter).toBe('Invoice Acknowledgements')
    expect(helpTopicVisible(topic, viewer(['INVOICE_ACKNOWLEDGEMENTS:VIEW']) as never)).toBe(true)
    expect(helpTopicVisible(topic, viewer(['ACCOUNTS:VIEW']) as never)).toBe(false)
    const text = JSON.stringify(topic)
    for (const phrase of ['OK / Confirm', 'green', 'Download', 'not payment', 'Create', 'Edit']) expect(text).toContain(phrase)
  })
})

describe('table, filters and columns', () => {
  it('shows the columns, the renewal version, the cards and Pending / Acknowledged colours', async () => {
    ackApi(ACKNOWLEDGER, [PENDING, RENEWAL, DONE])
    renderPage()
    await screen.findByText('INV-100')

    expect(headers()).toEqual([
      '#',
      'AMC Contract',
      'Client',
      'Service',
      'Invoice No.',
      'Invoice Date',
      'Service Value (Ex VAT, OMR)',
      'Invoice Value (Ex VAT, OMR)',
      'Service Report No.',
      'Acknowledgement Status',
      'Acknowledged Date',
      'Uploaded By',
      'Document',
      'Actions',
    ])
    expect(within(rowOf('INV-200')).getByText('STS-AMC-001 (V2)')).toBeInTheDocument()
    expect(rowOf('INV-100')).toHaveAttribute('data-status', 'PENDING')
    const green = within(rowOf('INV-300')).getByText('Acknowledged')
    expect(green.closest('[data-status]')).toHaveClass('bg-emerald-100', 'text-emerald-800')
    expect(within(rowOf('INV-100')).getByText('Pending').closest('[data-status]')).toHaveClass('bg-amber-100')
    // No invented date or value.
    expect(within(rowOf('INV-200')).getByTitle('No Zoho invoice date recorded')).toBeInTheDocument()
    expect(within(rowOf('INV-200')).getByTitle('No Zoho invoice value recorded')).toBeInTheDocument()
    await waitFor(() => expect(document.querySelector('[data-kpi="acknowledged"]')).toHaveTextContent(/Acknowledged1/))
    expect(document.querySelector('[data-kpi="pending"]')).toHaveTextContent(/Pending2/)
    expect(screen.getByText(/Total Filtered \(3 invoices, all pages\)/)).toBeInTheDocument()
    expect(screen.getByText(/It is not payment/)).toBeInTheDocument()
  })

  it('leaves out the amount columns for a role that cannot view Accounts', async () => {
    ackApi(VIEWER, [PENDING, DONE])
    renderPage()
    await screen.findByText('INV-100')

    expect(headers()).not.toContain('Service Value (Ex VAT, OMR)')
    expect(headers()).not.toContain('Invoice Value (Ex VAT, OMR)')
    expect(screen.queryByText(/Total Filtered/)).not.toBeInTheDocument()
    // View only: no Attach or Replace, but View Document stays.
    expect(screen.queryByRole('button', { name: /Attach acknowledgement/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Replace/ })).not.toBeInTheDocument()
    expect(within(rowOf('INV-300')).getByRole('button', { name: /View the acknowledgement document/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Excel/ })).not.toBeInTheDocument()
  })

  it('applies search and filters through the API, sorts by a column, and resets', async () => {
    const api = ackApi(ACKNOWLEDGER, [PENDING, RENEWAL, DONE])
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

    await userEvent.click(screen.getByRole('button', { name: /^Invoice No\./ }))
    await waitFor(() => expect(api.find('GET', '/invoice-acknowledgements').at(-1)!.query.get('sort')).toBe('invoiceNo'))
    expect(screen.getByRole('columnheader', { name: /Invoice No\./ })).toHaveAttribute('aria-sort', 'ascending')
    await userEvent.click(screen.getByRole('button', { name: /^Invoice No\./ }))
    await waitFor(() => expect(api.find('GET', '/invoice-acknowledgements').at(-1)!.query.get('dir')).toBe('desc'))
  })

  it('refuses a From date after the To date before asking the API', async () => {
    const api = ackApi(ACKNOWLEDGER, [PENDING])
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
    const api = ackApi(EDITOR, [PENDING])
    renderPage()
    await screen.findByText('INV-100')

    await userEvent.click(screen.getByRole('button', { name: /Hide Columns/ }))
    const dialog = screen.getByRole('dialog', { name: 'Hide columns' })
    await userEvent.click(within(dialog).getByLabelText('Document'))
    await userEvent.click(within(dialog).getByLabelText('Uploaded By'))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }))

    expect(headers()).not.toContain('Document')
    expect(headers()).not.toContain('Uploaded By')
    expect(JSON.parse(localStorage.getItem('stslev.invoice-acknowledgements.hidden-columns.23') ?? '[]')).toEqual(['document', 'uploadedBy'])

    await userEvent.click(screen.getByRole('button', { name: /Excel/ }))
    await waitFor(() => expect(api.find('GET', '/invoice-acknowledgements/export')).toHaveLength(1))
    expect(api.find('GET', '/invoice-acknowledgements/export')[0]!.query.get('hidden')).toBe('document,uploadedBy')
  })

  it('shows an error with Try again when the list cannot load', async () => {
    let failing = true
    ackApi(ACKNOWLEDGER, [PENDING], (request) => (failing && request.path === '/invoice-acknowledgements' ? fail(503, 'FEATURE_UNAVAILABLE', 'Invoice Acknowledgements need a database update.') : undefined))
    renderPage()

    expect(await screen.findByText(/need a database update/)).toBeInTheDocument()
    failing = false
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('INV-100')).toBeInTheDocument()
  })
})

describe('attach and confirm', () => {
  it('uploads the chosen document, shows its name, and turns green only after OK / Confirm succeeds', async () => {
    const api = ackApi(ACKNOWLEDGER, [PENDING])
    renderPage()
    await screen.findByText('INV-100')

    await userEvent.click(within(rowOf('INV-100')).getByRole('button', { name: /Attach acknowledgement for STS-AMC-001 · Invoice INV-100/ }))
    const dialog = screen.getByRole('dialog', { name: /Attach Acknowledgement/ })
    const confirm = within(dialog).getByRole('button', { name: /OK, confirm/ })
    expect(confirm).toBeDisabled()

    await userEvent.upload(within(dialog).getByTestId('acknowledgement-file'), pdf())
    expect(await within(dialog).findByTestId('selected-document')).toHaveTextContent('chosen.pdf')
    expect(api.find('POST', '/invoice-acknowledgements/1/document')).toHaveLength(1)
    // Saved, but still Pending.
    await waitFor(() => expect(rowOf('INV-100')).toHaveAttribute('data-status', 'PENDING'))
    expect(within(dialog).getByText(/still Pending/)).toBeInTheDocument()

    await userEvent.click(confirm)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('POST', '/invoice-acknowledgements/1/confirm')[0]!.body).toEqual({ attachmentId: '601' })
    expect(await screen.findByText(/INV-100 \(STS-AMC-001\) is now Acknowledged/)).toBeInTheDocument()
    await waitFor(() => expect(rowOf('INV-100')).toHaveAttribute('data-status', 'ACKNOWLEDGED'))
    expect(within(rowOf('INV-100')).getByText('Acknowledged').closest('[data-status]')).toHaveClass('bg-emerald-100')
  })

  it('keeps the invoice Pending and shows the message when confirmation fails', async () => {
    ackApi(ACKNOWLEDGER, [makeItem({ document: DOC, acknowledgementId: '95' })], (request) =>
      request.path === '/invoice-acknowledgements/1/confirm' ? fail(404, 'FILE_MISSING', 'The attached document could not be found in storage. Attach it again, then confirm.') : undefined,
    )
    renderPage()
    await screen.findByText('INV-100')
    expect(within(rowOf('INV-100')).getByText(/awaiting OK \/ Confirm/)).toBeInTheDocument()

    await userEvent.click(within(rowOf('INV-100')).getByRole('button', { name: /Review and confirm/ }))
    const dialog = screen.getByRole('dialog', { name: /Attach Acknowledgement/ })
    expect(within(dialog).getByTestId('selected-document')).toHaveTextContent('Stamped INV-100.pdf')
    await userEvent.click(within(dialog).getByRole('button', { name: /OK, confirm/ }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('could not be found in storage')
    expect(rowOf('INV-100')).toHaveAttribute('data-status', 'PENDING')
    expect(screen.queryByText(/is now Acknowledged/)).not.toBeInTheDocument()
  })

  it('checks type and size before uploading, and shows a server refusal', async () => {
    const api = ackApi(ACKNOWLEDGER, [PENDING], (request) =>
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
    expect(within(dialog).queryByTestId('selected-document')).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /OK, confirm/ })).toBeDisabled()
  })

  it('removes an attached document before confirming', async () => {
    const api = ackApi(ACKNOWLEDGER, [makeItem({ document: DOC, acknowledgementId: '95' })])
    renderPage()
    await screen.findByText('INV-100')
    await userEvent.click(within(rowOf('INV-100')).getByRole('button', { name: /Review and confirm/ }))
    const dialog = screen.getByRole('dialog', { name: /Attach Acknowledgement/ })

    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(within(dialog).queryByTestId('selected-document')).not.toBeInTheDocument())
    expect(api.find('DELETE', '/invoice-acknowledgements/1/document')).toHaveLength(1)
    expect(within(dialog).getByRole('button', { name: 'Choose document' })).toBeInTheDocument()
  })
})

describe('viewer and replacement', () => {
  it('opens the document in a viewer with Download inside it, fetched with the user token', async () => {
    const created = vi.fn(() => 'blob:ack')
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }))
    const api = ackApi(VIEWER, [DONE])
    renderPage()
    await screen.findByText('INV-300')

    await userEvent.click(within(rowOf('INV-300')).getByRole('button', { name: /View the acknowledgement document/ }))
    const dialog = screen.getByRole('dialog', { name: /Acknowledgement · STS-AMC-002 · Invoice INV-300/ })
    expect(await within(dialog).findByTitle(/Acknowledgement document of/)).toHaveAttribute('src', 'blob:ack')
    const request = api.find('GET', '/invoice-acknowledgements/3/document')[0]!
    expect(request.authorization).toBe('Bearer test-token')
    expect(within(dialog).getByTestId('selected-document')).toHaveTextContent('Beta ack.pdf')

    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    await userEvent.click(within(dialog).getByRole('button', { name: /Download the acknowledgement document/ }))
    expect(click).toHaveBeenCalled()
  })

  it('replaces an acknowledged document only with Edit and a reason', async () => {
    ackApi(EDITOR, [DONE])
    renderPage()
    await screen.findByText('INV-300')

    await userEvent.click(within(rowOf('INV-300')).getByRole('button', { name: /Replace the acknowledgement document/ }))
    const dialog = screen.getByRole('dialog', { name: /Replace Document/ })
    const submit = within(dialog).getByRole('button', { name: 'Replace Document' })
    expect(submit).toBeDisabled()

    await userEvent.upload(within(dialog).getByTestId('replacement-file'), new File([new Uint8Array(8)], 'replacement.png', { type: 'image/png' }))
    expect(submit).toBeDisabled()
    await userEvent.type(within(dialog).getByLabelText(/Reason for replacing/), 'Clearer scan')
    expect(submit).toBeEnabled()
    await userEvent.click(submit)

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const call = vi.mocked(fetch).mock.calls.find(([url]) => String(url).includes('/invoice-acknowledgements/3/replace'))!
    expect((call[1]!.headers as Record<string, string>)['X-Replace-Reason']).toBe(encodeURIComponent('Clearer scan'))
    expect(await screen.findByText(/was replaced\. The earlier version is kept/)).toBeInTheDocument()
    expect(rowOf('INV-300')).toHaveAttribute('data-status', 'ACKNOWLEDGED')
  })

  it('offers no Replace to a role with Create but not Edit', async () => {
    ackApi(ACKNOWLEDGER, [DONE])
    renderPage()
    await screen.findByText('INV-300')
    expect(within(rowOf('INV-300')).queryByRole('button', { name: /Replace/ })).not.toBeInTheDocument()
    expect(within(rowOf('INV-300')).queryByRole('button', { name: /Attach/ })).not.toBeInTheDocument()
  })
})

describe('mobile layout', () => {
  it('keeps the table in a horizontal scroll area and stacks filters on small screens', async () => {
    ackApi(ACKNOWLEDGER, [PENDING])
    renderPage()
    await screen.findByText('INV-100')

    expect(screen.getByRole('table').parentElement).toHaveClass('overflow-x-auto')
    expect(screen.getByRole('form', { name: 'Filters' })).toHaveClass('grid', 'sm:grid-cols-2', 'lg:grid-cols-4')
    expect(screen.getByRole('region', { name: 'Invoice acknowledgement figures' }).querySelector('ul')).toHaveClass('grid-cols-1', 'sm:grid-cols-2')
  })
})

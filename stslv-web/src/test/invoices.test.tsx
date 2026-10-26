import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { BillableProject, BillableVisit, BillableWork, Invoice } from '../lib/invoiceTypes'
import type { SessionUser } from '../lib/types'
import { ADMIN, fail, mockApi, ok, renderApp, signIn, type MockReply, type MockRequest } from './helpers'
import { makeProject, projectsApi } from './projectsApi'

// Invoice Tracking against a stand-in for the API. Every figure shown must be
// one the API returned; the only arithmetic on the screen is the exact check
// that the allocations add up to the amount excluding VAT. All data is invented.

const INVOICING: SessionUser = {
  id: '5',
  email: 'invoicing@example.com',
  fullName: 'Irfan Invoicing',
  roles: [{ id: '5', code: 'INVOICING', name: 'Invoicing' }],
  permissions: ['DASHBOARD:VIEW', 'CLIENTS:VIEW', 'AMC_SCHEDULE:VIEW', 'PROJECTS:VIEW', 'INVOICES:VIEW', 'INVOICES:CREATE', 'INVOICES:EDIT'],
}
const VIEWER: SessionUser = { ...INVOICING, permissions: ['DASHBOARD:VIEW', 'AMC_SCHEDULE:VIEW', 'PROJECTS:VIEW', 'INVOICES:VIEW'] }
const NO_INVOICES: SessionUser = { ...INVOICING, permissions: ['DASHBOARD:VIEW', 'PROJECTS:VIEW'] }

const HOTEL = { id: '10', name: 'Test Hotel' }
const MALL = { id: '11', name: 'Other Mall' }

const VISIT: BillableVisit = {
  id: '50',
  contractId: '40',
  client: HOTEL,
  systemDescription: 'FIRE',
  sequenceNo: 2,
  periodStart: '2026-04-01',
  periodEnd: '2026-06-30',
  completedDate: '2026-06-12',
  visitAmount: '405.000',
  invoiceEligibility: 'READY_FOR_INVOICE',
  invoicedAmount: '0.000',
}
const JOB: BillableProject = {
  id: '100',
  jobNumber: 'GPSA0001',
  description: 'Fire alarm panel replacement',
  client: HOTEL,
  completedDate: '2026-09-10',
  jobValue: '1000.000',
  invoiceState: 'PARTLY_INVOICED',
  invoicedValue: '400.250',
  uninvoicedValue: '599.750',
}
const MALL_JOB: BillableProject = {
  ...JOB,
  id: '101',
  jobNumber: 'GPSA0002',
  description: 'CCTV upgrade',
  client: MALL,
  jobValue: '250.000',
  invoiceState: 'READY_FOR_INVOICE',
  invoicedValue: '0.000',
  uninvoicedValue: '250.000',
}

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: '700',
    invoiceNumber: '3201',
    client: HOTEL,
    invoiceDate: '2026-09-15',
    amountExclVat: '400.250',
    vatAmount: '20.013',
    totalAmount: '420.263',
    status: 'ISSUED',
    source: 'ZOHO',
    sourceReference: null,
    notes: null,
    cancelledAt: null,
    cancelledBy: null,
    cancellationReason: null,
    createdBy: { id: '5', fullName: 'Irfan Invoicing' },
    createdAt: '2026-09-15T08:00:00.000Z',
    updatedAt: '2026-09-15T08:00:00.000Z',
    allocations: [{ id: '1', amount: '400.250', amcVisit: null, project: { id: '100', jobNumber: 'GPSA0001', description: 'Fire alarm panel replacement' } }],
    ...overrides,
  }
}

const ISSUED = makeInvoice()
const CANCELLED = makeInvoice({
  id: '701',
  invoiceNumber: '3150',
  amountExclVat: '405.000',
  vatAmount: '20.250',
  totalAmount: '425.250',
  status: 'CANCELLED',
  cancelledAt: '2026-09-02T08:00:00.000Z',
  cancelledBy: { id: '1', fullName: 'Asha Admin' },
  cancellationReason: 'Raised against the wrong visit',
  allocations: [{ id: '2', amount: '405.000', amcVisit: { ...VISIT, completedDate: VISIT.completedDate }, project: null }],
})

interface Seed {
  visits?: BillableVisit[]
  projects?: BillableProject[]
  invoices?: Invoice[]
}

/** The server's part: it stores what is sent and returns the totals it calculated. */
function invoicesApi(user: SessionUser, seed: Seed = {}, override?: (request: MockRequest) => MockReply | undefined) {
  const visits = seed.visits ?? [VISIT]
  const projects = seed.projects ?? [JOB, MALL_JOB]
  const invoices = [...(seed.invoices ?? [])]

  signIn()

  return mockApi((request) => {
    const overridden = override?.(request)
    if (overridden) return overridden

    const { method, path, query } = request
    const body = (request.body ?? {}) as Record<string, unknown>
    const [, , id, action] = path.split('/')

    if (path === '/auth/me') return ok({ user })

    if (method === 'GET' && path === '/invoices/billable') {
      const clientId = query.get('clientId')
      const work: BillableWork = {
        amcVisits: user.permissions.includes('AMC_SCHEDULE:VIEW')
          ? { items: visits.filter((visit) => !clientId || visit.client.id === clientId), pendingCount: 1, pendingAmount: '405.000' }
          : null,
        projects: user.permissions.includes('PROJECTS:VIEW')
          ? { items: projects.filter((project) => !clientId || project.client.id === clientId), pendingCount: 2, pendingValue: '849.750' }
          : null,
      }

      return ok(work)
    }
    if (method === 'GET' && path === '/invoices') {
      const items = invoices.filter((invoice) => !query.get('status') || invoice.status === query.get('status'))

      return ok({ items, total: items.length, page: 1, pageSize: 25, totals: { amountExclVat: '400.250', vatAmount: '20.013', totalAmount: '420.263' } })
    }
    if (method === 'GET' && id) {
      const invoice = invoices.find((item) => item.id === id)

      return invoice ? ok(invoice) : fail(404, 'NOT_FOUND', 'Invoice not found.')
    }
    if (method === 'POST' && path === '/invoices') {
      const created = makeInvoice({ id: '800', invoiceNumber: String(body.invoiceNumber), amountExclVat: '405.000', vatAmount: '20.250', totalAmount: '425.250' })

      invoices.unshift(created)
      return ok(created, 201)
    }
    if (method === 'PATCH' && id) {
      return ok({ ...(invoices.find((item) => item.id === id) as Invoice), invoiceNumber: String(body.invoiceNumber) })
    }
    if (method === 'POST' && action === 'cancel') {
      const index = invoices.findIndex((item) => item.id === id)
      const cancelled = { ...(invoices[index] as Invoice), status: 'CANCELLED' as const, cancellationReason: String(body.reason) }

      invoices[index] = cancelled
      return ok(cancelled)
    }

    return undefined
  })
}

const invoicesTable = () => screen.findByRole('table', { name: 'Invoices' })

async function fillDetails(dialog: HTMLElement, values: { number: string; date: string; amount: string; vat: string }) {
  await userEvent.type(within(dialog).getByLabelText(/^Invoice number/), values.number)
  fireEvent.change(within(dialog).getByLabelText(/^Invoice date/), { target: { value: values.date } })
  await userEvent.type(within(dialog).getByLabelText(/^Amount excluding VAT/), values.amount)
  await userEvent.type(within(dialog).getByLabelText(/^VAT amount/), values.vat)
}

describe('invoice tracking page', () => {
  it('lists the work waiting for an invoice with the pending figures the API calculated', async () => {
    invoicesApi(INVOICING)
    renderApp('/invoices')

    const visits = await screen.findByRole('table', { name: 'AMC visits waiting for an invoice' })
    const projects = screen.getByRole('table', { name: 'Projects waiting for an invoice' })

    expect(within(visits).getByText('Test Hotel')).toBeInTheDocument()
    expect(within(visits).getByText('405.000')).toBeInTheDocument()
    expect(screen.getByTestId('pending-visits')).toHaveTextContent('AMC visits: 1 · 405.000 (visit amounts as entered)')
    // Two bases, two figures: the AMC and project amounts are never added together.
    expect(screen.getByTestId('pending-projects')).toHaveTextContent('Projects: 2 · 849.750 (not yet invoiced, excluding VAT)')

    const job = within(within(projects).getByRole('link', { name: 'GPSA0001' }).closest('tr') as HTMLElement)
    expect(job.getByText('Partly invoiced')).toBeInTheDocument()
    expect(job.getByText('1,000.000')).toBeInTheDocument()
    expect(job.getByText('400.250')).toBeInTheDocument()
    expect(job.getByText('599.750')).toBeInTheDocument()
  })

  it('lists the invoices recorded, with the total the API calculated and cancelled invoices marked', async () => {
    invoicesApi(INVOICING, { invoices: [ISSUED, CANCELLED] })
    renderApp('/invoices')

    const rows = within(await invoicesTable()).getAllByRole('row').slice(1)
    const issued = within(rows[0] as HTMLElement)
    const cancelled = within(rows[1] as HTMLElement)

    expect(rows).toHaveLength(2)
    expect(issued.getByText('3201')).toBeInTheDocument()
    expect(issued.getByText('15 Sept 2026')).toBeInTheDocument()
    expect(issued.getByRole('link', { name: 'GPSA0001' })).toHaveAttribute('href', '/projects/100')
    expect(issued.getByText('400.250')).toBeInTheDocument()
    expect(issued.getByText('20.013')).toBeInTheDocument()
    expect(issued.getByText('420.263')).toBeInTheDocument()
    expect(issued.getByText('Issued')).toBeInTheDocument()
    expect(cancelled.getByText('Cancelled')).toBeInTheDocument()
    expect(cancelled.getByText('Cancelled: Raised against the wrong visit')).toBeInTheDocument()
    // A cancelled invoice cannot be changed or cancelled again.
    expect(cancelled.queryByRole('button', { name: /^Edit/ })).not.toBeInTheDocument()
    expect(cancelled.queryByRole('button', { name: /^Cancel/ })).not.toBeInTheDocument()
    expect(screen.getByTestId('invoices-total')).toHaveTextContent('400.250')
  })

  it('shows empty states when nothing is waiting and nothing is recorded', async () => {
    invoicesApi(INVOICING, { visits: [], projects: [] })
    renderApp('/invoices')

    expect(await screen.findByText('Nothing is waiting for an invoice')).toBeInTheDocument()
    expect(await screen.findByText('No invoices recorded yet')).toBeInTheDocument()
  })

  it('filters the invoices through the API', async () => {
    const api = invoicesApi(INVOICING, { invoices: [ISSUED, CANCELLED] })
    renderApp('/invoices')
    await invoicesTable()

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'ISSUED')
    await waitFor(() => expect(screen.queryByText('3150')).not.toBeInTheDocument())
    expect(api.find('GET', '/invoices').at(-1)?.query.get('status')).toBe('ISSUED')

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-01' } })
    await waitFor(() => expect(api.find('GET', '/invoices').at(-1)?.query.get('dateFrom')).toBe('2026-09-01'))
  })
})

describe('recording an invoice', () => {
  it('records a Zoho invoice against a waiting visit, exactly as typed', async () => {
    const api = invoicesApi(INVOICING)
    renderApp('/invoices')

    await userEvent.click(await screen.findByRole('button', { name: 'Record invoice for Test Hotel FIRE visit 2' }))
    const dialog = await screen.findByRole('dialog', { name: 'Record Invoice' })

    // The client is the client of the work; the visit is already ticked.
    expect(within(dialog).getByText('Test Hotel')).toBeInTheDocument()
    const visit = await within(dialog).findByRole('checkbox', { name: /AMC FIRE · visit 2/ })
    expect(visit).toBeChecked()
    // Nothing is filled in for the user: no date, no amounts, no VAT.
    expect(within(dialog).getByLabelText(/^Invoice date/)).toHaveValue('')
    expect(within(dialog).getByLabelText(/^VAT amount/)).toHaveValue('')
    expect(within(dialog).getByLabelText(/^Allocation for AMC FIRE/)).toHaveValue('')

    await fillDetails(dialog, { number: '3210', date: '2026-10-01', amount: '405', vat: '20.25' })
    expect(within(dialog).getByTestId('invoice-form-total')).toHaveTextContent('425.250')

    // An allocation that does not add up is stopped before anything is sent.
    await userEvent.type(within(dialog).getByLabelText(/^Allocation for AMC FIRE/), '404.999')
    expect(within(dialog).getByTestId('invoice-form-allocated')).toHaveTextContent('404.999 — must equal the amount excluding VAT (405.000).')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record invoice' }))
    expect(await within(dialog).findByText(/The allocations add up to 404.999, but the amount excluding VAT is 405.000/)).toBeInTheDocument()
    expect(api.find('POST', '/invoices')).toHaveLength(0)

    await userEvent.clear(within(dialog).getByLabelText(/^Allocation for AMC FIRE/))
    await userEvent.type(within(dialog).getByLabelText(/^Allocation for AMC FIRE/), '405.000')
    expect(within(dialog).getByTestId('invoice-form-allocated')).toHaveTextContent('405.000 — equal to the amount excluding VAT.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record invoice' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('POST', '/invoices')[0]?.body).toEqual({
      clientId: '10',
      invoiceNumber: '3210',
      invoiceDate: '2026-10-01',
      amountExclVat: '405',
      vatAmount: '20.25',
      sourceReference: '',
      notes: '',
      allocations: [{ amcVisitId: '50', amount: '405.000' }],
    })
    expect(screen.getByText('Invoice 3210 of 405.000 excl. VAT recorded for Test Hotel.')).toBeInTheDocument()
    expect(within(await invoicesTable()).getByText('3210')).toBeInTheDocument()
  })

  it('lets one invoice cover a visit and a project of the chosen client', async () => {
    const api = invoicesApi(INVOICING)
    renderApp('/invoices')

    await userEvent.click(await screen.findByRole('button', { name: 'Record Invoice' }))
    const dialog = await screen.findByRole('dialog', { name: 'Record Invoice' })

    // Only clients with completed work waiting are offered.
    const client = await within(dialog).findByLabelText(/^Client/)
    expect(within(client).getAllByRole('option').map((option) => option.textContent)).toEqual(['Select a client…', 'Test Hotel', 'Other Mall'])
    await userEvent.selectOptions(client, '10')

    const project = await within(dialog).findByRole('checkbox', { name: /GPSA0001 — Fire alarm panel replacement/ })
    expect(within(dialog).queryByRole('checkbox', { name: /GPSA0002/ })).not.toBeInTheDocument()
    expect(api.find('GET', '/invoices/billable').at(-1)?.query.get('includeInvoiced')).toBe('true')

    await userEvent.click(project)
    // The part of the job value no invoice covers yet is offered; it can be changed.
    expect(within(dialog).getByLabelText(/^Allocation for GPSA0001/)).toHaveValue('599.750')
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /AMC FIRE · visit 2/ }))
    await userEvent.type(within(dialog).getByLabelText(/^Allocation for AMC FIRE/), '405')

    await fillDetails(dialog, { number: '3211', date: '2026-10-02', amount: '1004.750', vat: '0' })
    expect(within(dialog).getByTestId('invoice-form-allocated')).toHaveTextContent('1,004.750 — equal to the amount excluding VAT.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record invoice' }))

    await waitFor(() => expect(api.find('POST', '/invoices')).toHaveLength(1))
    expect(api.find('POST', '/invoices')[0]?.body).toMatchObject({
      clientId: '10',
      allocations: [
        { amcVisitId: '50', amount: '405' },
        { projectId: '100', amount: '599.750' },
      ],
    })
  })

  it('requires every invoice detail and at least one piece of work', async () => {
    const api = invoicesApi(INVOICING)
    renderApp('/invoices')

    await userEvent.click(await screen.findByRole('button', { name: 'Record Invoice' }))
    const dialog = await screen.findByRole('dialog', { name: 'Record Invoice' })
    await within(dialog).findByLabelText(/^Client/)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record invoice' }))

    expect(await within(dialog).findByText('Select a client.')).toBeInTheDocument()
    expect(within(dialog).getByText('Invoice number is required.')).toBeInTheDocument()
    expect(within(dialog).getByText('Invoice date is required.')).toBeInTheDocument()
    expect(within(dialog).getByText('Amount excluding VAT is required.')).toBeInTheDocument()
    expect(within(dialog).getByText('VAT amount is required. Enter 0 if the invoice has no VAT.')).toBeInTheDocument()

    await userEvent.selectOptions(within(dialog).getByLabelText(/^Client/), '11')
    await within(dialog).findByRole('checkbox', { name: /GPSA0002/ })
    await fillDetails(dialog, { number: '3212', date: '2026-10-02', amount: '250.0001', vat: '0' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record invoice' }))
    expect(await within(dialog).findByText(/at most 3 decimal places/)).toBeInTheDocument()

    await userEvent.clear(within(dialog).getByLabelText(/^Amount excluding VAT/))
    await userEvent.type(within(dialog).getByLabelText(/^Amount excluding VAT/), '250')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record invoice' }))
    expect(await within(dialog).findByText('Tick at least one visit or project that this invoice covers.')).toBeInTheDocument()
    expect(api.find('POST', '/invoices')).toHaveLength(0)
  })

  it('shows what the API refuses, on the field or the allocations it concerns', async () => {
    let attempt = 0
    invoicesApi(INVOICING, {}, (request) => {
      if (request.method !== 'POST' || request.path !== '/invoices') return undefined
      attempt += 1

      return attempt === 1
        ? fail(409, 'CONFLICT', 'Invoice 3201 is already recorded.', [{ field: 'invoiceNumber', message: 'Invoice 3201 is already recorded.' }])
        : fail(400, 'VALIDATION_ERROR', 'Some allocations are invalid.', [
            { field: 'allocations.0', message: 'Visit 2 for "Test Hotel" (FIRE) is not completed. An invoice can only be recorded against completed work.' },
          ])
    })
    renderApp('/invoices')

    await userEvent.click(await screen.findByRole('button', { name: 'Record invoice for Test Hotel FIRE visit 2' }))
    const dialog = await screen.findByRole('dialog', { name: 'Record Invoice' })
    await within(dialog).findByRole('checkbox', { name: /AMC FIRE · visit 2/ })
    await fillDetails(dialog, { number: '3201', date: '2026-10-01', amount: '405', vat: '20.25' })
    await userEvent.type(within(dialog).getByLabelText(/^Allocation for AMC FIRE/), '405')

    await userEvent.click(within(dialog).getByRole('button', { name: 'Record invoice' }))
    expect(await within(dialog).findByText('Invoice 3201 is already recorded.')).toBeInTheDocument()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Record invoice' }))
    expect(await within(dialog).findByText(/is not completed. An invoice can only be recorded against completed work./)).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Record Invoice' })).toBeInTheDocument()
  })
})

describe('changing and cancelling an invoice', () => {
  it('edits an invoice with its allocations kept', async () => {
    const api = invoicesApi(INVOICING, { invoices: [ISSUED] })
    renderApp('/invoices')

    await userEvent.click(await screen.findByRole('button', { name: 'Edit invoice 3201' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit Invoice 3201' })

    expect(within(dialog).getByLabelText(/^Invoice date/)).toHaveValue('2026-09-15')
    expect(await within(dialog).findByRole('checkbox', { name: /GPSA0001/ })).toBeChecked()
    expect(within(dialog).getByLabelText(/^Allocation for GPSA0001/)).toHaveValue('400.250')

    await userEvent.clear(within(dialog).getByLabelText(/^Invoice number/))
    await userEvent.type(within(dialog).getByLabelText(/^Invoice number/), '3202')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(api.find('PATCH', '/invoices/700')).toHaveLength(1))
    expect(api.find('PATCH', '/invoices/700')[0]?.body).toMatchObject({
      invoiceNumber: '3202',
      clientId: '10',
      amountExclVat: '400.250',
      vatAmount: '20.013',
      allocations: [{ projectId: '100', amount: '400.250' }],
    })
    expect(await screen.findByText('Invoice 3202 was updated.')).toBeInTheDocument()
  })

  it('cancels an invoice only with a reason, and says the work is ready for invoice again', async () => {
    const api = invoicesApi(INVOICING, { invoices: [ISSUED] })
    renderApp('/invoices')

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel invoice 3201' }))
    const dialog = await screen.findByRole('dialog', { name: 'Cancel invoice' })

    expect(dialog).toHaveTextContent('it does not cancel the invoice in Zoho')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel invoice' }))
    expect(await within(dialog).findByText('Reason is required.')).toBeInTheDocument()
    expect(api.find('POST', '/invoices/700/cancel')).toHaveLength(0)

    await userEvent.type(within(dialog).getByLabelText(/^Reason/), 'Voided in Zoho')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel invoice' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('POST', '/invoices/700/cancel')[0]?.body).toEqual({ reason: 'Voided in Zoho' })
    expect(screen.getByText('Invoice 3201 was cancelled. The work it covered is ready for invoice again.')).toBeInTheDocument()
    expect(await within(await invoicesTable()).findByText('Cancelled: Voided in Zoho')).toBeInTheDocument()
  })

  it('shows the full record of an invoice, including who cancelled it and why', async () => {
    invoicesApi(INVOICING, { invoices: [CANCELLED] })
    renderApp('/invoices')

    await userEvent.click(await screen.findByRole('button', { name: 'View invoice 3150' }))
    const dialog = await screen.findByRole('dialog', { name: 'Invoice details' })

    expect(await within(dialog).findByText('425.250')).toBeInTheDocument()
    expect(dialog).toHaveTextContent('by Asha Admin — Raised against the wrong visit')
    expect(dialog).toHaveTextContent('AMC FIRE · visit 2')
    expect(within(dialog).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Cancel invoice' })).not.toBeInTheDocument()
  })
})

describe('invoice permissions', () => {
  it('lets a user who may only view see everything and change nothing', async () => {
    invoicesApi(VIEWER, { invoices: [ISSUED] })
    renderApp('/invoices')

    await invoicesTable()
    await screen.findByRole('table', { name: 'AMC visits waiting for an invoice' })
    expect(screen.getByRole('button', { name: 'View invoice 3201' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Record Invoice' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Record invoice for/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Edit invoice/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Cancel invoice/ })).not.toBeInTheDocument()
  })

  it('refuses the page to a user without the Invoices permission', async () => {
    const api = invoicesApi(NO_INVOICES)
    renderApp('/invoices')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(api.find('GET', '/invoices')).toHaveLength(0)
  })

  it('says why work is missing when the user may not view the AMC Schedule or Projects', async () => {
    invoicesApi({ ...INVOICING, permissions: ['DASHBOARD:VIEW', 'INVOICES:VIEW'] }, { visits: [], projects: [] })
    renderApp('/invoices')

    expect(await screen.findByText('Completed work is listed for roles that may also view the AMC Schedule or Projects.')).toBeInTheDocument()
  })
})

describe('invoices on the project page', () => {
  const COMPLETED = makeProject({ status: 'COMPLETED', completedDate: '2026-09-10', invoicedValue: '400.250', uninvoicedValue: '599.750' })
  const partly = (request: MockRequest) => {
    if (request.method === 'GET' && request.path === '/projects/100') {
      return ok({ ...COMPLETED, allowedStatuses: ['IN_PROGRESS'], invoiceState: 'PARTLY_INVOICED', readyForInvoice: false })
    }
    if (request.method === 'GET' && request.path === '/invoices') {
      return ok({ items: [ISSUED], total: 1, page: 1, pageSize: 50, totals: { amountExclVat: '400.250', vatAmount: '20.013', totalAmount: '420.263' } })
    }
    if (request.method === 'GET' && request.path === '/invoices/billable') {
      return ok({ amcVisits: { items: [], pendingCount: 0, pendingAmount: '0.000' }, projects: { items: [JOB], pendingCount: 1, pendingValue: '599.750' } })
    }

    return undefined
  }

  it('shows the invoices of the project and what is not yet invoiced, as the API reports them', async () => {
    const api = projectsApi(ADMIN, { projects: [COMPLETED] }, partly)
    renderApp('/projects/100')

    expect(await screen.findByText('Partly invoiced.')).toBeInTheDocument()
    const summary = screen.getByLabelText('Financial summary')
    expect(within(summary).getByText('Invoiced').nextElementSibling).toHaveTextContent('400.250')
    expect(within(summary).getByText('Not yet invoiced').nextElementSibling).toHaveTextContent('599.750')

    const table = await invoicesTable()
    expect(within(table).getByText('3201')).toBeInTheDocument()
    expect(api.find('GET', '/invoices')[0]?.query.get('projectId')).toBe('100')
    expect(screen.getByRole('link', { name: 'Open in Invoice Tracking' })).toHaveAttribute('href', '/invoices?projectId=100')

    // Recording from the project offers the part of the job value not yet invoiced.
    await userEvent.click(screen.getByRole('button', { name: 'Record invoice' }))
    const dialog = await screen.findByRole('dialog', { name: 'Record Invoice' })
    expect(await within(dialog).findByRole('checkbox', { name: /GPSA0001/ })).toBeChecked()
    expect(within(dialog).getByLabelText(/^Allocation for GPSA0001/)).toHaveValue('599.750')
  })

  it('does not show invoices to a user without the Invoices permission', async () => {
    const api = projectsApi(NO_INVOICES, { projects: [COMPLETED] }, partly)
    renderApp('/projects/100')

    expect(await screen.findByText('Partly invoiced.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Invoices' })).not.toBeInTheDocument()
    expect(api.find('GET', '/invoices')).toHaveLength(0)
  })
})

describe('invoice reports', () => {
  const EXPORTER: SessionUser = { ...INVOICING, permissions: [...INVOICING.permissions, 'INVOICES:EXPORT'] }
  const exportsOk = (request: MockRequest) => (request.path === '/invoices/export' || request.path === '/invoices/billable/export' ? ok(null) : undefined)

  /** Stands in for the browser's "save this file": records the name each download was saved under. */
  function captureSaves(): string[] {
    const saved: string[] = []

    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:test', revokeObjectURL: () => undefined }))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download)
    })

    return saved
  }

  it('exports the invoices that match the current filters, as Excel or PDF', async () => {
    const saved = captureSaves()
    const api = invoicesApi(EXPORTER, { invoices: [ISSUED, CANCELLED] }, exportsOk)
    renderApp('/invoices')
    await invoicesTable()

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'ISSUED')
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-01' } })
    await waitFor(() => expect(api.find('GET', '/invoices').at(-1)?.query.get('dateFrom')).toBe('2026-09-01'))

    const group = screen.getByRole('group', { name: 'Export invoices' })
    await userEvent.click(within(group).getByRole('button', { name: 'Export invoices to Excel' }))
    await waitFor(() => expect(saved).toEqual(['invoice-tracking.xlsx']))
    expect(Object.fromEntries(api.find('GET', '/invoices/export')[0]?.query ?? [])).toEqual({ format: 'xlsx', status: 'ISSUED', dateFrom: '2026-09-01' })

    await userEvent.click(within(group).getByRole('button', { name: 'Export invoices to PDF' }))
    await waitFor(() => expect(saved).toEqual(['invoice-tracking.xlsx', 'invoice-tracking.pdf']))
    expect(api.find('GET', '/invoices/export')[1]?.query.get('format')).toBe('pdf')
    // Exporting records nothing and changes nothing.
    expect(api.requests.filter((request) => request.method !== 'GET')).toHaveLength(0)
  })

  it('exports the work waiting for an invoice as its own report', async () => {
    const saved = captureSaves()
    const api = invoicesApi(EXPORTER, {}, exportsOk)
    renderApp('/invoices')
    await screen.findByRole('table', { name: 'AMC visits waiting for an invoice' })

    await userEvent.click(screen.getByRole('button', { name: 'Export pending invoices to PDF' }))

    await waitFor(() => expect(saved).toEqual(['pending-invoices.pdf']))
    // Waiting work only: the report can never be asked for work that is already invoiced.
    expect(Object.fromEntries(api.find('GET', '/invoices/billable/export')[0]?.query ?? [])).toEqual({ format: 'pdf' })
  })

  it('shows why a report was refused', async () => {
    const saved = captureSaves()
    invoicesApi(EXPORTER, { invoices: [ISSUED] }, (request) =>
      request.path === '/invoices/export' ? fail(422, 'EXPORT_TOO_LARGE', 'This export has 2500 rows; a PDF can hold at most 2000. Narrow the filters or export to Excel.') : undefined,
    )
    renderApp('/invoices')
    await invoicesTable()

    await userEvent.click(screen.getByRole('button', { name: 'Export invoices to PDF' }))

    expect(await screen.findByText('This export has 2500 rows; a PDF can hold at most 2000. Narrow the filters or export to Excel.')).toBeInTheDocument()
    expect(saved).toEqual([])
  })

  it('offers no export without the EXPORT permission, and no pending report when no waiting work may be seen', async () => {
    invoicesApi(INVOICING, { invoices: [ISSUED] })
    const first = renderApp('/invoices')
    await invoicesTable()
    expect(screen.queryByRole('button', { name: /^Export / })).not.toBeInTheDocument()
    first.unmount()

    invoicesApi({ ...EXPORTER, permissions: ['DASHBOARD:VIEW', 'INVOICES:VIEW', 'INVOICES:EXPORT'] }, { visits: [], projects: [], invoices: [ISSUED] })
    renderApp('/invoices')
    await invoicesTable()
    expect(screen.getByRole('group', { name: 'Export invoices' })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Export pending invoices' })).not.toBeInTheDocument()
  })
})

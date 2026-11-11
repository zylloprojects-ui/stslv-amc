import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Attachment } from '../components/AttachmentsPanel'
import { ADMIN, ok, renderApp, type MockRequest } from './helpers'
import { amcApi, EXECUTION, makeContract, makeVisit, attachRenewalDocument } from './amc-helpers'

// Contract register totals and columns, Contract 360 links and figures, the schedule's
// Paid / Unpaid, the consolidated filters, month cards, cancel reasons, renewal notes,
// the client code and document integrity. Every record here is invented.

const FIRE = makeContract({
  finalCredit: '0.001',
  createdBy: { id: '1', fullName: 'Asha Admin' },
  updatedBy: { id: '2', fullName: 'Bala Editor' },
  schedule: { ...makeContract().schedule, firstServiceDate: '2027-01-05', intervalMonths: 3, servicesPerCycle: 4 },
})

const listWithTotals = (request: MockRequest) =>
  request.method === 'GET' && request.path === '/amc/contracts'
    ? ok({ items: [FIRE], total: 3, page: 1, pageSize: 25, totals: { contractValue: '1234568.000', finalCredit: '0.003' } })
    : undefined

beforeEach(() => {
  localStorage.clear()
})

describe('AMC Contracts register', () => {
  it('shows AMC Reference, Credit, the Filtered Total from the API and an Upload Contract link', async () => {
    amcApi(ADMIN, { contracts: [FIRE], override: listWithTotals })
    renderApp('/amc/contracts')

    const table = await screen.findByRole('table', { name: 'AMC contracts' })
    expect(within(table).getByRole('columnheader', { name: 'AMC Reference' })).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: 'Credit' })).toBeInTheDocument()
    expect(within(table).getByRole('link', { name: 'AMC-0100' })).toHaveAttribute('href', '/amc/contracts/100')
    expect(within(table).getByRole('link', { name: 'Upload Contract for Test Hotel One FIRE' })).toHaveAttribute('href', '/amc/contracts/100?tab=documents')

    const total = within(table).getByRole('rowheader', { name: 'Filtered Total (3 contracts)' }).closest('tr') as HTMLElement
    expect(total).toHaveTextContent('1,234,568.000')
    expect(total).toHaveTextContent('0.003')
  })

  it('offers no Upload Contract link to someone who cannot upload', async () => {
    amcApi({ ...EXECUTION, permissions: ['AMC_CONTRACTS:VIEW'] }, { contracts: [FIRE] })
    renderApp('/amc/contracts')

    await screen.findByRole('table', { name: 'AMC contracts' })
    expect(screen.queryByText('Upload Contract')).not.toBeInTheDocument()
  })

  it('hides columns on the page and in the download, and keeps the total row lined up', async () => {
    const api = amcApi(ADMIN, { contracts: [FIRE], override: listWithTotals })
    renderApp('/amc/contracts')

    const table = await screen.findByRole('table', { name: 'AMC contracts' })
    await userEvent.click(screen.getByRole('button', { name: /^Columns/ }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'System' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Credit' }))

    expect(within(table).queryByRole('columnheader', { name: 'System' })).not.toBeInTheDocument()
    expect(within(table).queryByRole('columnheader', { name: 'Credit' })).not.toBeInTheDocument()
    const total = within(table).getByRole('rowheader', { name: /Filtered Total/ }).closest('tr') as HTMLElement
    expect(total).not.toHaveTextContent('0.003')
    const headerCount = within(table).getAllByRole('columnheader').length
    const spanned = [...total.children].reduce((sum, cell) => sum + (cell as HTMLTableCellElement).colSpan, 0)
    expect(spanned).toBe(headerCount)

    await userEvent.click(screen.getByRole('button', { name: /Excel/ }))
    await waitFor(() => expect(api.find('GET', '/amc/contracts/export').length).toBeGreaterThan(0))
    expect(api.find('GET', '/amc/contracts/export')[0]?.query.get('hidden')?.split(',').sort()).toEqual(['finalCredit', 'system'])
  })
})

describe('Contract 360', () => {
  const visit = makeVisit({ id: '500', manualInvoiceNo: 'MAN-1', paymentStatus: 'PAID', paidAt: '2027-02-01T08:00:00.000Z', colorState: 'FIRST_SERVICE', scheduledDate: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-10` })
  const contractApi = (user = ADMIN) =>
    amcApi(user, {
      contracts: [FIRE],
      visits: [visit],
      history: {
        '100': [
          { id: '2', action: 'amc_contract.updated', description: 'Second', user: null, changes: null, reason: null, createdAt: '2027-01-02T08:00:00.000Z' },
          { id: '1', action: 'amc_contract.created', description: 'First', user: null, changes: null, reason: null, createdAt: '2027-01-01T08:00:00.000Z' },
        ],
      },
      override: (request) => {
        if (request.path === '/amc/contracts/100/schedule/generations') return ok([{ generation: 1 }, { generation: 2 }])
        if (request.path === '/attachments') return ok(['1', '2'].map((id) => ({ id, documentId: id, version: 1, isCurrent: true, category: 'OTHER', title: `Doc ${id}`, originalName: `doc${id}.pdf`, mimeType: 'application/pdf', sizeBytes: 10, sha256: 'a'.repeat(64), notes: null, uploadedBy: { id: '1', fullName: 'Asha Admin' }, uploadedAt: '2026-10-20T08:00:00.000Z', versionCount: 1, integrity: 'VERIFIED' })))
        if (request.path === '/attachments/versions') return ok({ items: [], limits: { maxMb: 12, allowedTypes: ['PDF'] } })
        return undefined
      },
    })

  it('shows the reference, overview line, tiles, toolbar and linked modules with live counts and no Phase wording', async () => {
    contractApi()
    renderApp('/amc/contracts/100')

    expect(await screen.findByText(/^AMC-0100 · Version 1 · AMC contract/)).toBeInTheDocument()
    expect(screen.getByText('4 service(s) · every 3 month(s)')).toBeInTheDocument()

    const figures = screen.getByRole('region', { name: 'Contract figures' })
    expect(within(figures).getByText('First Service').nextElementSibling).toHaveTextContent('05 Jan 2027')
    expect(await within(figures).findByText('#2')).toBeInTheDocument()

    const toolbar = screen.getByRole('navigation', { name: 'Contract links' })
    expect(within(toolbar).getByRole('link', { name: 'Monthly Calendar' })).toHaveAttribute('href', '/amc/calendar')
    expect(within(toolbar).getByRole('link', { name: 'All Schedules' })).toHaveAttribute('href', '/amc/schedule?contractId=100')
    expect(await within(toolbar).findByRole('button', { name: 'Start Renewal' })).toBeInTheDocument()

    const linked = screen.getByRole('region', { name: 'Linked Modules' })
    expect(await within(linked).findByText('2 current document(s)')).toBeInTheDocument()
    expect(within(linked).getByText('No linked renewal yet')).toBeInTheDocument()
    expect(await within(linked).findByText('1 service(s) this month')).toBeInTheDocument()
    expect(linked).not.toHaveTextContent(/Phase/)
  })

  it('opens the Documents tab from the toolbar', async () => {
    contractApi()
    renderApp('/amc/contracts/100')

    const toolbar = await screen.findByRole('navigation', { name: 'Contract links' })
    await userEvent.click(within(toolbar).getByRole('button', { name: 'Documents' }))
    expect(screen.getByRole('tab', { name: /^Documents/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('opens directly on the tab the link names', async () => {
    contractApi()
    renderApp('/amc/contracts/100?tab=documents')

    expect(await screen.findByRole('tab', { name: /^Documents/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('adds Color, Paid date, a schedule link per row and exports for this contract', async () => {
    const api = contractApi()
    renderApp('/amc/contracts/100')

    const table = await screen.findByRole('table', { name: 'Visits of this contract' })
    expect(within(table).getByRole('columnheader', { name: 'Color' })).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: 'Paid date' })).toBeInTheDocument()
    expect(within(table).getByText('First Service')).toBeInTheDocument()
    expect(within(table).getByRole('link', { name: /in AMC Schedule$/ })).toHaveAttribute('href', '/amc/schedule?contractId=100')

    await userEvent.click(screen.getByRole('button', { name: /Excel/ }))
    await waitFor(() => expect(api.find('GET', '/amc/visits/export').length).toBeGreaterThan(0))
    expect(api.find('GET', '/amc/visits/export')[0]?.query.get('contractId')).toBe('100')
  })

  it('numbers the history, newest highest, and names who created and updated', async () => {
    contractApi()
    renderApp('/amc/contracts/100')

    await userEvent.click(await screen.findByRole('tab', { name: 'Contract history' }))
    const history = await screen.findByRole('list', { name: /Contract history/ })
    expect(history.children[0]).toHaveTextContent('#2')
    expect(history.children[1]).toHaveTextContent('#1')

    await userEvent.click(screen.getByRole('tab', { name: 'Details' }))
    expect(screen.getByText('Created by').nextElementSibling).toHaveTextContent('Asha Admin')
    expect(screen.getByText('Updated by').nextElementSibling).toHaveTextContent('Bala Editor')
  })

  it('hides Calendar, All Schedules and Renew from a role without them', async () => {
    contractApi({ ...EXECUTION, permissions: ['AMC_CONTRACTS:VIEW'] })
    renderApp('/amc/contracts/100')

    const toolbar = await screen.findByRole('navigation', { name: 'Contract links' })
    expect(within(toolbar).queryByRole('link', { name: 'Monthly Calendar' })).not.toBeInTheDocument()
    expect(within(toolbar).queryByRole('link', { name: 'All Schedules' })).not.toBeInTheDocument()
    expect(within(toolbar).queryByRole('button', { name: 'Start Renewal' })).not.toBeInTheDocument()
  })
})

describe('AMC Schedule', () => {
  it('filters by Paid or Unpaid, states the rule and links the AMC Reference', async () => {
    const api = amcApi(ADMIN, { contracts: [FIRE], visits: [makeVisit()] })
    renderApp('/amc/schedule')

    expect(await screen.findByText('Enter the manual Invoice No. and press OK to mark a service Paid; clear it to return it to Unpaid. No invoice is generated.')).toBeInTheDocument()
    expect(screen.getByText(/does not verify that money was received/)).toBeInTheDocument()

    await userEvent.selectOptions(screen.getByLabelText('Paid / Unpaid'), 'UNPAID')
    await waitFor(() => expect(api.find('GET', '/amc/visits').at(-1)?.query.get('paymentStatus')).toBe('UNPAID'))
  })

  it('follows ?contractId=, over all dates, in the list and the export, until cleared', async () => {
    const api = amcApi(ADMIN, { contracts: [FIRE], visits: [makeVisit()] })
    renderApp('/amc/schedule?contractId=100')

    // The banner names the contract by its stored AMC Reference Number, which arrives with its visits.
    expect(await screen.findByText((_, element) => element?.tagName === 'SPAN' && element.textContent === 'Showing contract AMC-0100 only.')).toBeInTheDocument()
    await waitFor(() => expect(api.find('GET', '/amc/visits').at(-1)?.query.get('contractId')).toBe('100'))
    expect(api.find('GET', '/amc/visits').at(-1)?.query.get('from')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /Excel/ }))
    await waitFor(() => expect(api.find('GET', '/amc/visits/export').length).toBeGreaterThan(0))
    expect(api.find('GET', '/amc/visits/export')[0]?.query.get('contractId')).toBe('100')

    await userEvent.click(screen.getByRole('button', { name: 'Show all contracts' }))
    await waitFor(() => expect(api.find('GET', '/amc/visits').at(-1)?.query.get('contractId')).toBeNull())
  })
})

describe('Consolidated schedule', () => {
  const service = (over: object) => ({ id: '1', serviceCode: 'Q1', sequenceNo: 1, scheduledDate: '2027-01-05', status: 'SCHEDULED', visitValue: '10.000', manualInvoiceNo: null, invoiceNumbers: [], ...over })

  it('takes the Client, Sales Engineer and System filters, also in the export, and marks each chip in words', async () => {
    const api = amcApi(ADMIN, {
      contracts: [FIRE],
      override: (request) => {
        if (request.path === '/amc/calendar/options') return ok({ clients: [{ id: '10', name: 'Test Hotel One' }], salesEngineers: [{ id: '5', name: 'Raghu' }], frequencies: [], years: [] })
        if (request.path === '/amc/visits/monthly-consolidated') {
          return ok({
            items: [{ id: '100', reference: 'AMC-0100', client: { id: '10', name: 'Test Hotel One' }, systemDescription: 'FIRE', frequency: 'Quarterly', salesEngineer: 'Raghu', services: [service({ manualInvoiceNo: 'MAN-1' }), service({ id: '2', serviceCode: 'Q2' })], totalValue: '20.000' }],
            total: 1,
            page: 1,
            pageSize: 50,
            totals: { contracts: 1, services: 2, completed: 0, totalValue: '20.000' },
          })
        }
        return undefined
      },
    })
    renderApp('/amc/schedule')

    await userEvent.click(await screen.findByRole('button', { name: 'Monthly by AMC' }))
    const form = await screen.findByRole('form', { name: 'Consolidated filters' })
    const table = await screen.findByRole('table', { name: 'Consolidated monthly schedule' })
    expect(within(table).getByText('Q1').closest('li')).toHaveTextContent('Paid')
    expect(within(table).getByText('Q2').closest('li')).toHaveTextContent('Unpaid')

    await screen.findByRole('option', { name: 'Raghu' })
    await userEvent.selectOptions(within(form).getByLabelText('Client'), '10')
    await userEvent.selectOptions(within(form).getByLabelText('Service Engineer'), '5')
    await userEvent.selectOptions(within(form).getByLabelText('System'), 'FIRE')
    await waitFor(() => {
      const query = api.find('GET', '/amc/visits/monthly-consolidated').at(-1)?.query

      expect([query?.get('clientId'), query?.get('salesEngineerId'), query?.get('system')]).toEqual(['10', '5', 'FIRE'])
    })

    await userEvent.click(within(form).getByRole('button', { name: /Excel/ }))
    await waitFor(() => expect(api.find('GET', '/amc/visits/monthly-consolidated/export').length).toBeGreaterThan(0))
    expect(api.find('GET', '/amc/visits/monthly-consolidated/export')[0]?.query.get('salesEngineerId')).toBe('5')
  })
})

describe('Renewal form and client code', () => {
  it('sends optional renewal notes only on a renewal, and shows the CL- code in the client list', async () => {
    const api = amcApi(ADMIN, {
      contracts: [FIRE],
      override: (request) => {
        if (request.path === '/amc/contracts/client-options') return ok([{ id: '10', code: 'CL-00010', name: 'Test Hotel One' }])
        if (request.path === '/masters/sales-engineers/options') return ok([{ id: '5', name: 'Raghu', employeeNo: null }])
        if (request.method === 'GET' && request.path === '/amc/contracts/100/masters') return ok({ salesEngineer: { id: '5', name: 'Raghu', isActive: true }, systemType: null })
        if (request.method === 'POST' && request.path === '/amc/contracts/100/renewals') return ok(makeContract({ id: '101', status: 'DRAFT' }), 201)
        return undefined
      },
    })
    renderApp('/amc/contracts/100')

    const toolbar = await screen.findByRole('navigation', { name: 'Contract links' })
    await userEvent.click(await within(toolbar).findByRole('button', { name: 'Start Renewal' }))
    const dialog = await screen.findByRole('dialog', { name: 'Renew AMC Contract' })

    expect(await within(dialog).findByRole('option', { name: 'Test Hotel One (CL-00010)' })).toBeInTheDocument()
    await userEvent.type(within(dialog).getByLabelText(/AMC Reference Number/), 'AMC-2028-101')
    await userEvent.type(within(dialog).getByLabelText('Valid from', { exact: false }), '2028-01-01')
    await userEvent.type(within(dialog).getByLabelText('Valid to', { exact: false }), '2028-12-31')
    await userEvent.type(within(dialog).getByLabelText('Renewal notes'), 'Two more sites')
    await within(dialog).findByRole('option', { name: 'Raghu' })
    await attachRenewalDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create renewal' }))

    await waitFor(() => expect(api.find('POST', '/amc/contracts/100/renewals')).toHaveLength(1))
    expect(api.find('POST', '/amc/contracts/100/renewals')[0]?.body).toMatchObject({ renewalNotes: 'Two more sites' })
  })

  it('does not offer renewal notes when adding an ordinary contract', async () => {
    amcApi(ADMIN, { contracts: [FIRE] })
    renderApp('/amc/contracts')

    await userEvent.click(await screen.findByRole('button', { name: 'Add Contract' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add AMC Contract' })
    await within(dialog).findByLabelText('System', { exact: false })
    expect(within(dialog).queryByLabelText('Renewal notes')).not.toBeInTheDocument()
  })
})

describe('Documents', () => {
  const DOC: Attachment = {
    id: '5',
    documentId: '5',
    version: 2,
    isCurrent: true,
    category: 'SIGNED_CONTRACT',
    title: 'Signed contract',
    originalName: 'signed.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 2048,
    sha256: 'abcdef123456'.padEnd(64, '0'),
    notes: null,
    uploadedBy: { id: '1', fullName: 'Asha Admin' },
    uploadedAt: '2026-10-20T08:00:00.000Z',
    versionCount: 2,
    integrity: 'VERIFIED',
  }
  const OLD: Attachment = { ...DOC, id: '4', version: 1, isCurrent: false, originalName: 'old.pdf', uploadedAt: '2026-10-01T08:00:00.000Z', integrity: 'FAILED' }

  it('shows the figures, the shortened checksum with its state, the version history and the stated limits', async () => {
    amcApi(ADMIN, {
      contracts: [FIRE],
      override: (request) => {
        if (request.path === '/attachments') return ok([DOC])
        if (request.path === '/attachments/versions') return ok({ items: [DOC, OLD], limits: { maxMb: 12, allowedTypes: ['PDF', 'PNG', 'JPEG'] } })
        return undefined
      },
    })
    renderApp('/amc/contracts/100?tab=documents')

    const panel = within(await screen.findByRole('tabpanel'))
    expect(await panel.findByText(/Allowed types: PDF, PNG, JPEG\. Size limit: 12 MB per file\./)).toBeInTheDocument()

    const figures = panel.getByLabelText('Documents figures')
    expect(within(figures).getByText('Current documents').nextElementSibling).toHaveTextContent('1')
    expect(within(figures).getByText('Versions').nextElementSibling).toHaveTextContent('2')
    expect(within(figures).getByText('Latest upload').nextElementSibling).not.toHaveTextContent('—')

    const current = panel.getByRole('table', { name: 'Documents' })
    expect(within(current).getByRole('columnheader', { name: 'Integrity' })).toBeInTheDocument()
    expect(within(current).getByText(/abcdef123456…/)).toBeInTheDocument()
    expect(within(current).getByText('Verified')).toBeInTheDocument()

    const history = panel.getByRole('table', { name: /Every version/ })
    expect(within(history).getByText('old.pdf')).toBeInTheDocument()
    expect(within(history).getByText('Failed')).toBeInTheDocument()
    expect(within(history).getByRole('button', { name: 'Download version 1 of Signed contract' })).toBeInTheDocument()
  })
})

describe('Calendar month cards', () => {
  it('count Paid and Unpaid per month and label the invoice figures as Zoho', async () => {
    const empty = { services: 0, scheduledValue: '0.000', amountMissing: 0, scheduled: 0, inProgress: 0, postponed: 0, completed: 0, cancelled: 0, overdue: 0, invoiced: 0, invoicedValue: '0.000', notYetInvoiced: 0, notYetInvoicedValue: '0.000', noInvoiceRequired: 0, notCompleted: 0, paid: 0, paidValue: '0.000', unpaid: 0, unpaidValue: '0.000' }
    const year = new Date().getFullYear()
    amcApi(ADMIN, {
      override: (request) => {
        if (request.path === '/amc/calendar/options') return ok({ clients: [], salesEngineers: [], frequencies: [], years: [year] })
        if (request.path === '/amc/reports/expiring') return ok({ asOf: `${year}-01-01`, days: 45, items: [], total: 0, pastValidity: 0 })
        if (request.path === '/amc/visits/year-summary') {
          return ok({ year, totals: empty, months: Array.from({ length: 12 }, (_, index) => ({ ...empty, month: index + 1, ...(index === 2 ? { services: 5, paid: 2, unpaid: 3, invoiced: 7, notYetInvoiced: 8 } : {}) })) })
        }
        return undefined
      },
    })
    renderApp('/amc/calendar')

    const card = within(await screen.findByRole('article', { name: `March ${year}` }))
    expect(card.getByText('Paid').nextElementSibling).toHaveTextContent('2')
    expect(card.getByText('Unpaid').nextElementSibling).toHaveTextContent('3')
    expect(card.getByText('Zoho invoiced').nextElementSibling).toHaveTextContent('7')
    expect(card.getByText('Zoho not yet invoiced').nextElementSibling).toHaveTextContent('8')
  })
})

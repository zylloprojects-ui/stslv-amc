import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { Invoice } from '../lib/invoiceTypes'
import type { SessionUser } from '../lib/types'
import { validityState } from '../pages/amc/contractValidity'
import type { ContractHistoryEntry } from '../pages/amc/types'
import { ACCOUNTANT, ADMIN, fail, renderApp } from './helpers'
import { amcApi, EXECUTION, makeContract, makeVisit } from './amc-helpers'

// The AMC Contract 360 page. Every record here is invented test data.

const FIRE = makeContract()

/** May view contracts, and nothing else: no schedule, no invoices. */
const CONTRACTS_ONLY: SessionUser = { ...EXECUTION, permissions: ['DASHBOARD:VIEW', 'AMC_CONTRACTS:VIEW'] }

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: '700',
    invoiceNumber: '3201',
    client: { id: '10', name: 'Test Hotel One' },
    invoiceDate: '2027-01-20',
    amountExclVat: '405.000',
    vatAmount: '20.250',
    totalAmount: '425.250',
    status: 'ISSUED',
    source: 'ZOHO',
    sourceReference: null,
    notes: null,
    cancelledAt: null,
    cancelledBy: null,
    cancellationReason: null,
    createdBy: { id: '5', fullName: 'Irfan Invoicing' },
    createdAt: '2027-01-20T08:00:00.000Z',
    updatedAt: '2027-01-20T08:00:00.000Z',
    allocations: [
      {
        id: '1',
        amount: '405.000',
        amcVisit: { id: '500', contractId: '100', systemDescription: 'FIRE', sequenceNo: 1, periodStart: '2027-01-01', periodEnd: '2027-03-31', completedDate: '2027-01-04' },
        project: null,
      },
    ],
    ...overrides,
  }
}

const OTHER_CONTRACT_INVOICE = makeInvoice({
  id: '701',
  invoiceNumber: '3299',
  allocations: [
    {
      id: '2',
      amount: '405.000',
      amcVisit: { id: '900', contractId: '555', systemDescription: 'CCTV', sequenceNo: 1, periodStart: '2027-01-01', periodEnd: '2027-03-31', completedDate: '2027-01-04' },
      project: null,
    },
  ],
})

const HISTORY: ContractHistoryEntry[] = [
  {
    id: '30',
    action: 'amc_contract.status_changed',
    description: 'AMC contract for "Test Hotel One" (FIRE) changed from ACTIVE to EXPIRED.',
    user: { id: '1', fullName: 'Asha Admin' },
    changes: { status: { from: 'ACTIVE', to: 'EXPIRED' } },
    reason: 'Term ended.',
    createdAt: '2027-02-01T09:30:00.000Z',
  },
  {
    id: '20',
    action: 'amc_contract.updated',
    description: 'AMC contract for "Test Hotel One" (FIRE) updated.',
    user: { id: '1', fullName: 'Asha Admin' },
    changes: { contractValue: { from: '1500.000', to: '1620.000' }, maintenanceFrequency: { from: 'MONTHLY', to: 'QUARTERLY' }, notes: { from: null, to: 'Keys at reception' } },
    reason: null,
    createdAt: '2027-01-10T09:30:00.000Z',
  },
  {
    id: '10',
    action: 'amc_contract.created',
    description: 'AMC contract for "Test Hotel One" (FIRE) created as ACTIVE.',
    user: null,
    changes: null,
    reason: null,
    createdAt: '2027-01-01T09:30:00.000Z',
  },
]

async function openPage(path = '/amc/contracts/100', title = 'Test Hotel One — FIRE') {
  renderApp(path)
  await screen.findByRole('heading', { name: title })

  return within(screen.getByRole('main'))
}

const region = (page: ReturnType<typeof within>, name: string) => within(page.getByRole('region', { name }))

describe('contract page', () => {
  it('shows the overview, validity and commercial details from the stored contract', async () => {
    amcApi(ADMIN, { contracts: [makeContract({ finalCredit: '1500.000', notes: 'Keys at reception' })] })
    const page = await openPage()

    const overview = region(page, 'Contract overview')
    expect(overview.getByText('Test Hotel One')).toBeInTheDocument()
    expect(overview.getByText('FIRE')).toBeInTheDocument()
    expect(overview.getByText('Test Engineer')).toBeInTheDocument()
    expect(overview.getByText('Quarterly')).toBeInTheDocument()
    expect(overview.getByText('Active')).toBeInTheDocument()
    expect(overview.getByText('Keys at reception')).toBeInTheDocument()

    const validity = region(page, 'Contract validity')
    expect(validity.getByText('01 Jan 2027')).toBeInTheDocument()
    expect(validity.getByText('31 Dec 2027')).toBeInTheDocument()
    expect(validity.getByText('365 calendar days (start and end dates included)')).toBeInTheDocument()

    const commercial = region(page, 'Commercial details')
    const row = (label: string) => commercial.getByText(label).parentElement as HTMLElement
    expect(row('Contract value')).toHaveTextContent('1,620.000')
    expect(row('Default visit amount')).toHaveTextContent('405.000')
    expect(row('Final credit')).toHaveTextContent('1,500.000')
  })

  it('lists only the visits of this contract, with dates and statuses', async () => {
    const api = amcApi(ADMIN, {
      contracts: [FIRE],
      visits: [
        makeVisit({ status: 'COMPLETED', completedDate: '2027-01-04', invoiceEligibility: 'INVOICED' }),
        makeVisit({ id: '501', sequenceNo: 2, periodStart: '2027-04-01', periodEnd: '2027-06-30', scheduledDate: '2027-04-01' }),
        makeVisit({ id: '900', contract: { id: '555', systemDescription: 'CCTV', maintenanceFrequency: 'QUARTERLY', status: 'ACTIVE' } as never, sequenceNo: 9 }),
      ],
    })
    const page = await openPage()

    const table = await page.findByRole('table', { name: 'Visits of this contract' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    expect(within(rows[0] as HTMLElement).getByText('Completed')).toBeInTheDocument()
    expect(within(rows[0] as HTMLElement).getByText('04 Jan 2027')).toBeInTheDocument()
    expect(within(rows[0] as HTMLElement).getByText('Invoiced')).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('01 Apr 2027 – 30 Jun 2027')).toBeInTheDocument()
    expect(api.find('GET', '/amc/visits')[0]?.query.get('contractId')).toBe('100')
  })

  it('lists the invoices recorded against the contract, asking for this contract only', async () => {
    const api = amcApi(ADMIN, { contracts: [FIRE], invoices: [makeInvoice(), OTHER_CONTRACT_INVOICE] })
    const page = await openPage()

    const invoices = region(page, 'Invoices')
    const table = await invoices.findByRole('table', { name: 'Invoices' })
    expect(within(table).getByText('3201')).toBeInTheDocument()
    expect(within(table).getByText('Issued')).toBeInTheDocument()
    expect(within(table).getByText('425.250')).toBeInTheDocument()
    expect(within(table).queryByText('3299')).not.toBeInTheDocument()
    expect(api.find('GET', '/invoices')[0]?.query.get('amcContractId')).toBe('100')
  })

  it('says so when no invoice has been recorded', async () => {
    amcApi(ADMIN, { contracts: [FIRE] })
    const page = await openPage()

    expect(await region(page, 'Invoices').findByText('No invoices recorded for this contract')).toBeInTheDocument()
  })

  it('shows the history, newest first, with action, user, time, description and changes in plain words', async () => {
    const api = amcApi(ADMIN, { contracts: [FIRE], history: { '100': HISTORY } })
    const page = await openPage()

    const history = region(page, 'Contract history')
    const entries = within(await history.findByRole('list', { name: 'Contract history, newest first' })).getAllByRole('listitem', { name: undefined })
    const top = entries.filter((item) => item.parentElement?.getAttribute('aria-label') === 'Contract history, newest first')

    expect(top).toHaveLength(3)
    expect(top[0]).toHaveTextContent('Status changed')
    expect(top[0]).toHaveTextContent('Asha Admin')
    expect(top[0]).toHaveTextContent('Status: Active → Expired')
    expect(top[0]).toHaveTextContent('Reason: Term ended.')
    expect(top[1]).toHaveTextContent('Contract updated')
    expect(top[1]).toHaveTextContent('Contract value: 1,500.000 → 1,620.000')
    expect(top[1]).toHaveTextContent('Frequency: Monthly → Quarterly')
    expect(top[1]).toHaveTextContent('Notes: — → Keys at reception')
    expect(top[2]).toHaveTextContent('Contract created')
    expect(top[2]).toHaveTextContent('System')
    expect(top[2]).toHaveTextContent('created as ACTIVE')
    expect(within(top[0] as HTMLElement).getByText(/2027/).tagName).toBe('TIME')
    expect(api.find('GET', '/amc/contracts/100/history')[0]?.query.get('page')).toBe('1')
  })

  it('says so when the contract has no recorded history', async () => {
    amcApi(ADMIN, { contracts: [FIRE] })
    const page = await openPage()

    expect(await region(page, 'Contract history').findByText('No history recorded for this contract')).toBeInTheDocument()
  })
})

describe('contract page permissions', () => {
  it('hides the schedule and the invoices from a role without them, and never asks for them', async () => {
    const api = amcApi(CONTRACTS_ONLY, { contracts: [FIRE], visits: [makeVisit()], invoices: [makeInvoice()] })
    const page = await openPage()

    expect(page.getByText('Your role does not include access to the AMC schedule.')).toBeInTheDocument()
    expect(page.queryByRole('region', { name: 'Invoices' })).not.toBeInTheDocument()
    await region(page, 'Contract history').findByText('No history recorded for this contract')
    expect(api.find('GET', '/amc/visits')).toHaveLength(0)
    expect(api.find('GET', '/invoices')).toHaveLength(0)
    expect(page.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
  })

  it('shows the schedule but not the invoices to the Execution role', async () => {
    const api = amcApi(EXECUTION, { contracts: [FIRE], visits: [makeVisit()] })
    const page = await openPage()

    expect(await page.findByRole('table', { name: 'Visits of this contract' })).toBeInTheDocument()
    expect(page.queryByRole('region', { name: 'Invoices' })).not.toBeInTheDocument()
    expect(api.find('GET', '/invoices')).toHaveLength(0)
  })

  it('refuses the page to a role without AMC Contracts access, without requesting the contract', async () => {
    const api = amcApi(ACCOUNTANT, { contracts: [FIRE] })
    renderApp('/amc/contracts/100')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(api.find('GET', '/amc/contracts/100')).toHaveLength(0)
  })
})

describe('contract page states', () => {
  it('shows a not-found message for an unknown contract', async () => {
    amcApi(ADMIN, { contracts: [FIRE] })
    renderApp('/amc/contracts/999')

    expect(await screen.findByText('Contract not found')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '← All contracts' })).toHaveAttribute('href', '/amc/contracts')
  })

  it('shows the error and loads again on request', async () => {
    let calls = 0
    amcApi(ADMIN, {
      contracts: [FIRE],
      override: (request) => {
        if (request.path === '/amc/contracts/100') {
          calls += 1
          if (calls === 1) return fail(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.')
        }
        return undefined
      },
    })
    renderApp('/amc/contracts/100')

    expect(await screen.findByText(/Something went wrong/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'Test Hotel One — FIRE' })).toBeInTheDocument()
  })

  it('shows an error in one section without hiding the rest of the page', async () => {
    amcApi(ADMIN, {
      contracts: [FIRE],
      override: (request) => (request.path === '/amc/contracts/100/history' ? fail(500, 'INTERNAL_ERROR', 'History is unavailable.') : undefined),
    })
    const page = await openPage()

    expect(await region(page, 'Contract history').findByText(/History is unavailable/)).toBeInTheDocument()
    expect(region(page, 'Contract overview').getByText('Test Engineer')).toBeInTheDocument()
  })
})

describe('contract page actions', () => {
  it('edits the contract from its page with the existing form', async () => {
    const api = amcApi(ADMIN, { contracts: [FIRE] })
    const page = await openPage()

    await userEvent.click(page.getByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit AMC Contract' })
    const notes = within(dialog).getByLabelText(/Notes/)
    await userEvent.clear(notes)
    await userEvent.type(notes, 'Gate code changed')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(api.find('PATCH', '/amc/contracts/100')).toHaveLength(1))
    expect(api.find('PATCH', '/amc/contracts/100')[0]?.body).toMatchObject({ notes: 'Gate code changed' })
    expect(await screen.findByRole('status')).toHaveTextContent('The contract was updated.')
  })

  it('reads the contract again after a change, so the page shows the stored values', async () => {
    const api = amcApi(ADMIN, { contracts: [FIRE] })
    const page = await openPage()

    await userEvent.click(page.getByRole('button', { name: 'Mark as expired' }))
    const confirm = await screen.findByRole('dialog', { name: 'Mark contract as expired' })
    await userEvent.click(within(confirm).getByRole('button', { name: 'Mark contract as expired' }))

    await waitFor(() => expect(api.find('GET', '/amc/contracts/100').length).toBeGreaterThan(1))
    expect(await region(page, 'Contract overview').findByText('Expired')).toBeInTheDocument()
  })
})

describe('validity in words', () => {
  it('counts the calendar days of the period, both ends included, across a leap day', () => {
    expect(validityState('2028-01-01', '2028-12-31', '2028-06-01')?.durationDays).toBe(366)
    expect(validityState('2027-01-01', '2027-12-31', '2027-06-01')?.durationDays).toBe(365)
    expect(validityState('2027-01-01', '2027-01-01', '2027-01-01')?.durationDays).toBe(1)
  })

  it('describes a period that has not started, is running, ends today or has ended', () => {
    expect(validityState('2027-01-01', '2027-12-31', '2026-12-29')).toMatchObject({ phase: 'upcoming', text: 'Starts in 3 days' })
    expect(validityState('2027-01-01', '2027-12-31', '2027-01-01')).toMatchObject({ phase: 'running', text: '364 days remaining' })
    expect(validityState('2027-01-01', '2027-12-31', '2027-12-30')).toMatchObject({ phase: 'running', text: '1 day remaining' })
    expect(validityState('2027-01-01', '2027-12-31', '2027-12-31')).toMatchObject({ phase: 'running', text: 'Ends today' })
    expect(validityState('2027-01-01', '2027-12-31', '2028-01-01')).toMatchObject({ phase: 'ended', text: 'Ended 1 day ago' })
    expect(validityState('2028-02-28', '2028-02-28', '2028-03-01')).toMatchObject({ phase: 'ended', text: 'Ended 2 days ago' })
  })

  it('gives nothing for dates it cannot read', () => {
    expect(validityState('not-a-date', '2027-12-31', '2027-06-01')).toBeNull()
    expect(validityState('2027-12-31', '2027-01-01', '2027-06-01')).toBeNull()
  })
})

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { formatJobDate, formatMonth } from '../lib/format'
import { ADMIN, mockApi, ok, renderApp, signIn } from './helpers'
import { amcApi, makeContract, makeVisit } from './amc-helpers'
import { currentMonth } from '../pages/amc/amcFormat'
import { makeProject, projectsApi } from './projectsApi'

// Historical records are imported from the client's earlier registers. The
// application shows them as those registers recorded them and offers no way to
// change them.

const NORMAL = makeProject()
const HISTORICAL = makeProject({
  id: '200',
  jobNumber: 'GPSA0901',
  description: 'Panel repair',
  status: 'HISTORICAL',
  legacyStatus: 'Completed',
  jobDate: '2025-02-01',
  jobDatePrecision: 'MONTH',
  jobValue: '500.000',
})

const MONTH = currentMonth()
const NORMAL_VISIT = makeVisit({ scheduledDate: `${MONTH}-02`, originalScheduledDate: `${MONTH}-02` })
const HISTORICAL_VISIT = makeVisit({
  id: '600',
  client: { id: '11', name: 'Test Hotel Two' },
  contract: { id: '101', status: 'DRAFT', systemDescription: 'CCTV', maintenanceFrequency: 'QUARTERLY' },
  sequenceNo: 2,
  periodStart: `${MONTH}-01`,
  periodEnd: `${MONTH}-28`,
  scheduledDate: `${MONTH}-01`,
  originalScheduledDate: `${MONTH}-01`,
  status: 'HISTORICAL',
  visitAmount: '775.000',
  invoiceEligibility: 'HISTORICAL',
})

describe('month-only dates', () => {
  it('shows the month and year, never a day that was not recorded', () => {
    expect(formatMonth('2025-02-01')).toBe('Feb 2025')
    expect(formatMonth(null)).toBe('—')
    expect(formatJobDate({ jobDate: '2025-02-01', jobDatePrecision: 'MONTH' })).toBe('Feb 2025')
    // A real first of the month on an ordinary project is still shown as a day.
    expect(formatJobDate({ jobDate: '2025-02-01', jobDatePrecision: 'DAY' })).toMatch(/^1 Feb 2025$/)
  })
})

describe('historical project', () => {
  it('is not offered when choosing the job for a new expense', async () => {
    projectsApi(ADMIN, { projects: [NORMAL, HISTORICAL] })
    renderApp('/expenses')

    await userEvent.click(await screen.findByRole('button', { name: 'Record Expense' }))
    const dialog = await screen.findByRole('dialog', { name: 'Record Expense' })
    const picker = await within(dialog).findByLabelText(/^Project \/ job/)

    await waitFor(() => expect(within(picker).getAllByRole('option').length).toBeGreaterThan(1))
    const options = within(picker)
      .getAllByRole('option')
      .map((option) => option.textContent)

    expect(options.some((text) => text?.includes('GPSA0001'))).toBe(true)
    expect(options.some((text) => text?.includes('GPSA0901'))).toBe(false)
  })
})

describe('historical visit in the schedule', () => {
  it('is marked Historical, with no planned date, no overdue flag and no invoicing state', async () => {
    amcApi(ADMIN, { visits: [NORMAL_VISIT, HISTORICAL_VISIT] })
    renderApp('/amc/schedule')

    const table = await screen.findByRole('table')
    const row = within(within(table).getByText('Test Hotel Two').closest('tr') as HTMLElement)

    expect(row.getByText('Historical')).toBeInTheDocument()
    expect(row.getByText('Not recorded')).toBeInTheDocument()
    expect(row.getByText('775.000')).toBeInTheDocument()
    expect(row.queryByText('Overdue')).not.toBeInTheDocument()
    expect(row.queryByText('Ready for invoice')).not.toBeInTheDocument()
  })

  it('can be viewed but not edited, while an ordinary visit still can', async () => {
    amcApi(ADMIN, { visits: [NORMAL_VISIT, HISTORICAL_VISIT] })
    renderApp('/amc/schedule')
    await screen.findByRole('table')

    expect(screen.queryByRole('button', { name: 'Edit Test Hotel Two CCTV visit 2' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit Test Hotel One FIRE visit 1' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'View Test Hotel Two CCTV visit 2' }))
    const dialog = await screen.findByRole('dialog', { name: 'Visit details' })

    expect(await within(dialog).findByText('Historical record.')).toBeInTheDocument()
    expect(within(dialog).getByText('Scheduled date').nextElementSibling).toHaveTextContent('Not recorded')
    expect(within(dialog).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
  })

  it('can be filtered by the Historical status through the API', async () => {
    const api = amcApi(ADMIN, { visits: [NORMAL_VISIT, HISTORICAL_VISIT] })
    renderApp('/amc/schedule')
    await screen.findByRole('table')

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'HISTORICAL')

    await waitFor(() => expect(api.find('GET', '/amc/visits').at(-1)?.query.get('status')).toBe('HISTORICAL'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'View Test Hotel One FIRE visit 1' })).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'View Test Hotel Two CCTV visit 2' })).toBeInTheDocument()
  })
})

describe('imported contract', () => {
  it('says from which date visits are generated and lists its historical visits', async () => {
    amcApi(ADMIN, {
      contracts: [
        makeContract({
          id: '101',
          client: { id: '11', name: 'Test Hotel Two', isActive: true },
          systemDescription: 'CCTV',
          status: 'DRAFT',
          scheduleCutoverDate: '2026-10-01',
          schedule: { visitCount: 1, completedCount: 0, openCount: 0, historicalCount: 1, cancelledCount: 0, amountMissingCount: 0, scheduledTotal: '775.000', valueDifference: '845.000' },
        }),
      ],
      visits: [HISTORICAL_VISIT],
    })
    renderApp('/amc/contracts')

    await userEvent.click(await screen.findByRole('link', { name: 'View Test Hotel Two CCTV' }))
    await screen.findByRole('heading', { name: 'Test Hotel Two — CCTV' })
    const dialog = screen.getByRole('main')

    expect(await within(dialog).findByText(/imported from an earlier register/)).toHaveTextContent('starting on or after 01 Oct 2026')
    expect(within(dialog).getByText(/1 historical/)).toBeInTheDocument()
    expect(within(dialog).getByText(/New visits are generated when the contract is activated/)).toBeInTheDocument()

    const table = await within(dialog).findByRole('table', { name: 'Visits of this contract' })
    const row = within(within(table).getAllByRole('row')[1] as HTMLElement)

    expect(row.getByText('Historical')).toBeInTheDocument()
    expect(row.getByText('Not recorded')).toBeInTheDocument()
  })

  it('shows nothing about an import on a contract entered in the application', async () => {
    amcApi(ADMIN, { contracts: [makeContract()], visits: [makeVisit()] })
    renderApp('/amc/contracts')

    await userEvent.click(await screen.findByRole('link', { name: 'View Test Hotel One FIRE' }))
    await screen.findByRole('heading', { name: 'Test Hotel One — FIRE' })
    const dialog = screen.getByRole('main')
    await within(dialog).findByRole('table', { name: 'Visits of this contract' })

    expect(within(dialog).queryByText(/imported from an earlier register/)).not.toBeInTheDocument()
    expect(within(dialog).queryByText(/historical/)).not.toBeInTheDocument()
  })
})

describe('dashboard', () => {
  const summary = (costs: Record<string, string>) => ({
    clients: null,
    amc: null,
    projects: {
      counts: { total: 10, active: 2, new: 1, inProgress: 1, completed: 1, cancelled: 0, historical: 7, readyForInvoice: 1, noInvoiceRequired: 0 },
      values: { totalJobValue: '3000.000', totalGrandValue: '3150.000', readyForInvoiceValue: '2000.250', historicalJobValue: '18500.000', historicalGrandValue: '19425.000' },
      costs: { trackedExpenses: '350.125', operationalJobMargin: '2649.875', ...costs },
    },
  })

  function dashboardApi(data: unknown) {
    signIn()

    return mockApi((request) => {
      if (request.path === '/auth/me') return ok({ user: ADMIN })
      if (request.path === '/dashboard/summary') return ok(data)
      return undefined
    })
  }

  it('shows none of the historical project values, now that the other-figures cards are hidden', async () => {
    dashboardApi(summary({ trackedExpensesOnCancelledProjects: '40.000', trackedExpensesOnHistoricalProjects: '12.500' }))
    renderApp('/dashboard')

    await screen.findByRole('heading', { name: 'AMC Operations Dashboard' })
    expect(screen.queryByRole('heading', { name: 'Tracked Expenses' })).not.toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('18,500.000')
    expect(document.body).not.toHaveTextContent('19,425.000')
  })
})

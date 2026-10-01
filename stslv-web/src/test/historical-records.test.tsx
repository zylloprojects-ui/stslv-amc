import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { formatJobDate, formatMonth } from '../lib/format'
import { ADMIN, mockApi, ok, renderApp, signIn } from './helpers'
import { amcApi, EXECUTION, makeContract, makeVisit } from './amc-helpers'
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

describe('historical project in the list', () => {
  it('is marked Historical with the status of the earlier register and a month-only date', async () => {
    projectsApi(ADMIN, { projects: [NORMAL, HISTORICAL] })
    renderApp('/projects')

    const table = await screen.findByRole('table', { name: 'Projects' })
    const row = within(within(table).getByRole('link', { name: 'GPSA0901' }).closest('tr') as HTMLElement)

    expect(row.getByText('Historical · Completed')).toBeInTheDocument()
    expect(row.getByText('Feb 2025')).toBeInTheDocument()
    expect(row.queryByText(/1 Feb 2025/)).not.toBeInTheDocument()
    // Value, VAT and grand value are shown like those of any project.
    expect(row.getByText('25.000')).toBeInTheDocument()
    expect(row.getByText('525.000')).toBeInTheDocument()
    // Not waiting for an invoice.
    expect(row.queryByText('Ready for invoice')).not.toBeInTheDocument()
  })

  it('can be viewed but not edited, while an ordinary project still can', async () => {
    projectsApi(ADMIN, { projects: [NORMAL, HISTORICAL] })
    renderApp('/projects')
    await screen.findByRole('table', { name: 'Projects' })

    expect(screen.getByRole('link', { name: 'View GPSA0901' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit GPSA0901' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit GPSA0001' })).toBeInTheDocument()
  })

  it('can be filtered by the Historical status through the API', async () => {
    const api = projectsApi(ADMIN, { projects: [NORMAL, HISTORICAL] })
    renderApp('/projects')
    await screen.findByRole('table', { name: 'Projects' })

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'HISTORICAL')

    await waitFor(() => expect(api.find('GET', '/projects').at(-1)?.query.get('status')).toBe('HISTORICAL'))
    await waitFor(() => expect(screen.queryByRole('link', { name: 'GPSA0001' })).not.toBeInTheDocument())
    expect(screen.getByRole('link', { name: 'GPSA0901' })).toBeInTheDocument()
  })
})

describe('historical project page', () => {
  it('explains what the record is and shows what the earlier register recorded', async () => {
    projectsApi(ADMIN, { projects: [HISTORICAL] })
    renderApp('/projects/200')

    expect(await screen.findByRole('heading', { name: 'Project GPSA0901' })).toBeInTheDocument()
    expect(screen.getByText('Historical record.')).toBeInTheDocument()
    expect(screen.getByText('Status in the earlier register').nextElementSibling).toHaveTextContent('Completed')
    expect(screen.getByText('Job date').nextElementSibling).toHaveTextContent('Feb 2025 (day not recorded)')
    // No completion date is shown, because none was recorded.
    expect(screen.getByText('Completed', { selector: 'dt' }).nextElementSibling).toHaveTextContent('Not recorded')
    expect(screen.getByLabelText('Financial summary')).toHaveTextContent('500.000')
  })

  it('offers no edit, no status change and no new procurement or expense', async () => {
    const api = projectsApi(ADMIN, { projects: [HISTORICAL] })
    renderApp('/projects/200')
    await screen.findByRole('heading', { name: 'Project GPSA0901' })
    await screen.findByText('No expenses recorded for this project')

    for (const name of ['Edit', 'Mark completed', 'Start work', 'Cancel project', 'Reopen project', 'Add procurement request', 'Record expense']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    }
    expect(screen.queryByText(/Ready for invoice/)).not.toBeInTheDocument()
    expect(api.find('PATCH', '/projects/200')).toHaveLength(0)
    expect(api.find('POST', '/projects/200/status')).toHaveLength(0)
  })

  it('still offers every action on an ordinary project', async () => {
    projectsApi(ADMIN, { projects: [NORMAL] })
    renderApp('/projects/100')
    await screen.findByRole('heading', { name: 'Project GPSA0001' })

    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mark completed' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Record expense' })).toBeInTheDocument()
    expect(screen.queryByText('Historical record.')).not.toBeInTheDocument()
    expect(screen.queryByText('Status in the earlier register')).not.toBeInTheDocument()
  })

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

describe('historical visit in the execution work list', () => {
  it('offers only a view, under all visits', async () => {
    amcApi(EXECUTION, { visits: [NORMAL_VISIT, HISTORICAL_VISIT] })
    renderApp('/amc/execution')
    await screen.findByRole('table')

    // The work that is due does not include it.
    expect(screen.getByRole('button', { name: 'View Test Hotel One FIRE visit 1' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'View Test Hotel Two CCTV visit 2' })).not.toBeInTheDocument()

    await userEvent.selectOptions(screen.getByLabelText('Show'), 'all')
    const row = within((await screen.findByRole('button', { name: 'View Test Hotel Two CCTV visit 2' })).closest('tr') as HTMLElement)

    expect(row.getByText('Historical')).toBeInTheDocument()
    expect(row.getByText('Not recorded')).toBeInTheDocument()
    expect(row.getAllByRole('button').map((button) => button.textContent)).toEqual(['View'])

    await userEvent.click(row.getByRole('button', { name: 'View Test Hotel Two CCTV visit 2' }))
    expect(await within(await screen.findByRole('dialog', { name: 'Visit details' })).findByText('Historical record.')).toBeInTheDocument()
  })

  it('is not a status a user can choose for a visit', async () => {
    amcApi(EXECUTION, { visits: [NORMAL_VISIT] })
    renderApp('/amc/execution')

    await userEvent.selectOptions(await screen.findByLabelText('Show'), 'all')
    await userEvent.click(await screen.findByRole('button', { name: 'Update Test Hotel One FIRE visit 1' }))
    const dialog = await screen.findByRole('dialog', { name: 'Update visit' })
    const options = within(within(dialog).getByLabelText(/^Status/))
      .getAllByRole('option')
      .map((option) => option.textContent)

    expect(options).toEqual(['Scheduled', 'In progress', 'Completed', 'Postponed', 'Cancelled'])
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

    await userEvent.click(await screen.findByRole('button', { name: 'View Test Hotel Two CCTV' }))
    const dialog = await screen.findByRole('dialog', { name: 'AMC contract details' })

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

    await userEvent.click(await screen.findByRole('button', { name: 'View Test Hotel One FIRE' }))
    const dialog = await screen.findByRole('dialog', { name: 'AMC contract details' })
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

  const cardOf = async (label: string) => (await screen.findByRole('heading', { name: label, level: 3 })).closest('div.rounded-lg') as HTMLElement

  it('shows the operational figures only: the value of historical projects is in none of them', async () => {
    dashboardApi(summary({ trackedExpensesOnCancelledProjects: '0.000', trackedExpensesOnHistoricalProjects: '0.000' }))
    renderApp('/dashboard')

    expect(await within(await cardOf('Active Projects')).findByText('2')).toBeInTheDocument()
    expect(within(await cardOf('Projects Ready for Invoice')).getByText('1')).toBeInTheDocument()
    expect(within(await cardOf('Ready-for-Invoice Value')).getByText('2,000.250')).toBeInTheDocument()
    expect(within(await cardOf('Tracked Expenses')).getByText('Cancelled projects left out')).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('18,500.000')
    expect(document.body).not.toHaveTextContent('19,425.000')
  })

  it('states apart any expense recorded against historical projects, beside those of cancelled projects', async () => {
    dashboardApi(summary({ trackedExpensesOnCancelledProjects: '40.000', trackedExpensesOnHistoricalProjects: '12.500' }))
    renderApp('/dashboard')

    const card = await cardOf('Tracked Expenses')

    expect(await within(card).findByText('350.125')).toBeInTheDocument()
    expect(within(card).getByText('Plus 40.000 on cancelled projects and 12.500 on historical projects')).toBeInTheDocument()
  })
})

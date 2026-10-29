import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { currentMonth, monthLabel, monthRange } from '../pages/amc/amcFormat'
import type { ExpiringContracts, VisitYearFigures, VisitYearSummary } from '../pages/amc/calendar/calendarTypes'
import type { SessionUser } from '../lib/types'
import { afterPageSplit, ACCOUNTANT, ADMIN, fail, ok, renderApp, type MockRequest } from './helpers'
import { amcApi, EXECUTION, makeVisit, VIEWER } from './amc-helpers'

// The Monthly Calendar's Year view, filters, monthly downloads and renewal
// warnings. Every record here is invented test data.

const YEAR = 2027
const OPERATIONAL = 'SCHEDULED,IN_PROGRESS,COMPLETED,POSTPONED,CANCELLED'

function figures(overrides: Partial<VisitYearFigures> = {}): VisitYearFigures {
  return {
    services: 0,
    scheduledValue: '0.000',
    amountMissing: 0,
    scheduled: 0,
    inProgress: 0,
    postponed: 0,
    completed: 0,
    cancelled: 0,
    overdue: 0,
    invoiced: 0,
    invoicedValue: '0.000',
    notYetInvoiced: 0,
    notYetInvoicedValue: '0.000',
    noInvoiceRequired: 0,
    notCompleted: 0,
    ...overrides,
  }
}

const MARCH = figures({
  services: 3,
  scheduledValue: '810.000',
  amountMissing: 1,
  completed: 2,
  scheduled: 1,
  overdue: 1,
  cancelled: 1,
  invoiced: 1,
  invoicedValue: '405.000',
  notYetInvoiced: 1,
  notYetInvoicedValue: '405.000',
  notCompleted: 1,
})

function summaryFor(year: number): VisitYearSummary {
  return {
    year,
    months: Array.from({ length: 12 }, (_, index) => ({ month: index + 1, ...(year === YEAR && index === 2 ? MARCH : figures()) })),
    totals: year === YEAR ? MARCH : figures(),
  }
}

const OPTIONS = {
  clients: [{ id: '10', name: 'Test Hotel One' }],
  salesEngineers: [{ id: '7', name: 'Sara Sales' }],
  systemTypes: [],
  frequencies: [
    { code: 'MONTHLY', label: 'Monthly' },
    { code: 'QUARTERLY', label: 'Quarterly' },
  ],
  years: [2025, YEAR],
  reportNumberAvailable: true,
}

const EXPIRING: ExpiringContracts = {
  asOf: '2027-03-10',
  days: 45,
  items: [
    { id: '7', client: { id: '10', name: 'Test Hotel One' }, systemDescription: 'FIRE', validTo: '2027-04-01', daysLeft: 22 },
    { id: '12', client: { id: '11', name: 'Test Hotel Two' }, systemDescription: 'CCTV', validTo: '2027-03-01', daysLeft: -9 },
  ],
  total: 2,
  pastValidity: 1,
}

interface Setup {
  user?: SessionUser
  expiring?: ExpiringContracts | 'error'
  summary?: 'error'
}

function calendarApi({ user = ADMIN, expiring = EXPIRING, summary }: Setup = {}) {
  return amcApi(user, {
    visits: [makeVisit({ id: '501', scheduledDate: `${YEAR}-03-04` })],
    override: (request: MockRequest) => {
      if (request.path === '/amc/visits/year-summary') {
        return summary === 'error' ? fail(500, 'INTERNAL_ERROR', 'Something went wrong.') : ok(summaryFor(Number(request.query.get('year'))))
      }
      if (request.path === '/amc/calendar/options') return ok(OPTIONS)
      if (request.path === '/amc/reports/expiring') return expiring === 'error' ? fail(500, 'INTERNAL_ERROR', 'Something went wrong.') : ok(expiring)
      if (request.path === '/amc/visits/export') return ok({})
      return undefined
    },
  })
}

const monthsOf = async (year: number) => within(await screen.findByRole('region', { name: `Months of ${year}` }))

describe('Monthly Calendar, Year view', () => {
  it('is the page’s first view and shows twelve months of the year', async () => {
    const api = calendarApi()
    renderApp(`/amc/calendar?month=${YEAR}-03`)

    expect(await screen.findByRole('heading', { name: 'Monthly Calendar' })).toBeInTheDocument()
    const months = await monthsOf(YEAR)
    expect(months.getAllByRole('article')).toHaveLength(12)
    expect(months.getByRole('button', { name: `Open January ${YEAR} in month view` })).toBeInTheDocument()
    expect(months.getByRole('button', { name: `Open December ${YEAR} in month view` })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Year view' })).toHaveAttribute('aria-pressed', 'true')

    const request = api.find('GET', '/amc/visits/year-summary')[0]
    expect(request?.query.get('year')).toBe(String(YEAR))
    // Like the Month view, historical visits are not asked for.
    expect(request?.query.get('status')).toBe(OPERATIONAL)
    // The day grid is not loaded until it is shown.
    expect(api.find('GET', '/amc/visits')).toHaveLength(0)
  })

  it('shows each month’s services, value, invoicing and status', async () => {
    calendarApi()
    renderApp(`/amc/calendar?month=${YEAR}-03`)

    const march = within((await monthsOf(YEAR)).getByRole('article', { name: `March ${YEAR}` }))
    expect(march.getByText('3')).toBeInTheDocument()
    expect(march.getByText('810.000')).toBeInTheDocument()
    expect(march.getByText('1 without amount')).toBeInTheDocument()
    const status = within(march.getByRole('list', { name: `Visit status in March ${YEAR}` }))
    expect(status.getByText(/completed/)).toHaveTextContent('2 completed')
    expect(status.getByText(/overdue/)).toHaveTextContent('1 overdue')
    expect(status.getByText(/cancelled/)).toHaveTextContent('1 cancelled')

    const april = within((await monthsOf(YEAR)).getByRole('article', { name: `April ${YEAR}` }))
    expect(april.getByText('No visits')).toBeInTheDocument()
  })

  it('shows the year’s figures, with Invoiced and Not yet invoiced instead of paid', async () => {
    calendarApi()
    renderApp(`/amc/calendar?month=${YEAR}-03`)

    await monthsOf(YEAR)
    const figures = within(screen.getByLabelText(`Figures for ${YEAR}`))
    expect(figures.getByText('Services in year').nextSibling).toHaveTextContent('3')
    expect(figures.getByText('1 cancelled visit not counted')).toBeInTheDocument()
    expect(figures.getByText('Scheduled value').nextSibling).toHaveTextContent('810.000')
    expect(figures.getByText('1 service without an amount, not included')).toBeInTheDocument()
    expect(figures.getByText('Invoiced').nextSibling).toHaveTextContent('1')
    expect(figures.getByText(/an invoice is not proof of payment/)).toBeInTheDocument()
    expect(figures.getByText('Not yet invoiced').nextSibling).toHaveTextContent('1')
    expect(screen.queryByText(/\bpaid\b/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/ex vat/i)).not.toBeInTheDocument()
  })

  it('moves between years with the buttons and the year list', async () => {
    const api = calendarApi()
    renderApp(`/amc/calendar?month=${YEAR}-03`)

    await monthsOf(YEAR)
    await userEvent.click(screen.getByRole('button', { name: 'Next year' }))
    expect(await monthsOf(YEAR + 1)).toBeTruthy()
    await waitFor(() => expect(api.find('GET', '/amc/visits/year-summary').at(-1)?.query.get('year')).toBe(String(YEAR + 1)))

    await userEvent.selectOptions(screen.getByLabelText('Year'), '2025')
    expect(await monthsOf(2025)).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'This year' }))
    expect(await monthsOf(Number(currentMonth().slice(0, 4)))).toBeTruthy()
  })

  it('opens a month in the day grid, and comes back to the same year', async () => {
    const api = calendarApi()
    renderApp(`/amc/calendar?month=${YEAR}-01`)

    await userEvent.click((await monthsOf(YEAR)).getByRole('button', { name: `Open March ${YEAR} in month view` }))

    expect(await screen.findByRole('group', { name: `Visits in ${monthLabel(`${YEAR}-03`)}` })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Month view' })).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(api.find('GET', '/amc/visits').at(-1)?.query.get('from')).toBe(`${YEAR}-03-01`))

    await userEvent.click(screen.getByRole('button', { name: 'Year view' }))
    expect(await monthsOf(YEAR)).toBeTruthy()
  })

  it('keeps the filters when switching views, and sends them to both', async () => {
    const api = calendarApi()
    renderApp(`/amc/calendar?month=${YEAR}-03`)

    await monthsOf(YEAR)
    await userEvent.selectOptions(await screen.findByLabelText('Sales engineer'), '7')
    await userEvent.selectOptions(screen.getByLabelText('Frequency'), 'QUARTERLY')
    await userEvent.selectOptions(screen.getByLabelText('Billing status'), 'NOT_YET_INVOICED')
    await userEvent.selectOptions(screen.getByLabelText('Visit status'), 'COMPLETED')
    await userEvent.selectOptions(await screen.findByLabelText('Client'), '10')

    await waitFor(() => {
      const query = api.find('GET', '/amc/visits/year-summary').at(-1)?.query
      expect(Object.fromEntries(query ?? [])).toEqual({
        year: String(YEAR),
        clientId: '10',
        salesEngineerId: '7',
        frequency: 'QUARTERLY',
        status: 'COMPLETED',
        billingStatus: 'NOT_YET_INVOICED',
      })
    })

    await userEvent.click(screen.getByRole('button', { name: 'Month view' }))
    await waitFor(() => {
      const query = api.find('GET', '/amc/visits').at(-1)?.query
      expect(query?.get('salesEngineerId')).toBe('7')
      expect(query?.get('billingStatus')).toBe('NOT_YET_INVOICED')
      expect(query?.get('from')).toBe(`${YEAR}-03-01`)
    })
    expect(screen.getByLabelText('Billing status')).toHaveValue('NOT_YET_INVOICED')
  })

  it('offers every billing status, and none called paid', async () => {
    calendarApi()
    renderApp(`/amc/calendar?month=${YEAR}-03`)

    await monthsOf(YEAR)
    const options = within(screen.getByLabelText('Billing status')).getAllByRole('option').map((option) => option.textContent)
    expect(options).toEqual(['All', 'Invoiced', 'Not yet invoiced', 'No invoice required', 'Not completed', 'Cancelled'])
  })

  it('downloads one month, with the page’s filters, as Excel or PDF', async () => {
    const saved: string[] = []
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:test', revokeObjectURL: () => undefined }))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download)
    })
    const api = calendarApi()
    renderApp(`/amc/calendar?month=${YEAR}-03`)

    await monthsOf(YEAR)
    await userEvent.selectOptions(screen.getByLabelText('Billing status'), 'INVOICED')
    await userEvent.click(screen.getByRole('button', { name: `Export March ${YEAR} visits to Excel` }))

    await waitFor(() => expect(saved).toEqual([`monthly-calendar-${YEAR}-03.xlsx`]))
    expect(Object.fromEntries(api.find('GET', '/amc/visits/export')[0]?.query ?? [])).toEqual({
      format: 'xlsx',
      ...monthRange(`${YEAR}-03`),
      status: OPERATIONAL,
      billingStatus: 'INVOICED',
    })

    await userEvent.click(screen.getByRole('button', { name: `Export March ${YEAR} visits to PDF` }))
    await waitFor(() => expect(saved).toHaveLength(2))
    expect(api.find('GET', '/amc/visits/export')[1]?.query.get('format')).toBe('pdf')
    // A month without visits has nothing to download.
    expect(screen.queryByRole('button', { name: `Export April ${YEAR} visits to Excel` })).not.toBeInTheDocument()
  })

  it('offers no download to a role without the export permission', async () => {
    calendarApi({ user: VIEWER })
    renderApp(`/amc/calendar?month=${YEAR}-03`)

    await monthsOf(YEAR)
    expect(screen.queryByRole('button', { name: /Export/ })).not.toBeInTheDocument()
  })

  it('says so when the year cannot be loaded', async () => {
    calendarApi({ summary: 'error' })
    renderApp(`/amc/calendar?month=${YEAR}-03`)

    expect(await screen.findByText('Something went wrong.')).toBeInTheDocument()
  })
})

describe('Monthly Calendar renewal warnings', () => {
  it('lists contracts ending within 45 days, and those already past their validity', async () => {
    const api = calendarApi()
    renderApp(`/amc/calendar?month=${YEAR}-03`)

    const warnings = within(await screen.findByRole('region', { name: 'Renewal warnings: 2 contracts ending within 45 days' }))
    expect(warnings.getByText('AMC-0007')).toBeInTheDocument()
    expect(warnings.getByText(/Ends in 22 days/)).toBeInTheDocument()
    expect(warnings.getByText(/Validity ended 9 days ago, still marked Active/)).toBeInTheDocument()
    expect(warnings.getByRole('link', { name: 'Open contract AMC-0007' })).toHaveAttribute('href', '/amc/contracts/7')
    expect(api.find('GET', '/amc/reports/expiring')[0]?.query.get('days')).toBe('45')
  })

  it('narrows the warnings to the chosen client', async () => {
    calendarApi()
    renderApp(`/amc/calendar?month=${YEAR}-03`)

    await screen.findByRole('region', { name: /Renewal warnings: 2/ })
    await userEvent.selectOptions(await screen.findByLabelText('Client'), '10')
    expect(await screen.findByRole('region', { name: 'Renewal warnings: 1 contract ending within 45 days' })).toBeInTheDocument()
  })

  it('shows nothing when no contract is ending', async () => {
    calendarApi({ expiring: { ...EXPIRING, items: [], total: 0, pastValidity: 0 } })
    renderApp(`/amc/calendar?month=${YEAR}-03`)

    await monthsOf(YEAR)
    expect(screen.queryByRole('region', { name: /Renewal warnings/ })).not.toBeInTheDocument()
  })

  it('says so when the warnings cannot be loaded, and the calendar still works', async () => {
    calendarApi({ expiring: 'error' })
    renderApp(`/amc/calendar?month=${YEAR}-03`)

    expect(await screen.findByText('Renewal warnings could not be loaded.')).toBeInTheDocument()
    expect(await monthsOf(YEAR)).toBeTruthy()
  })

  it('is not requested for a role that cannot view contracts', async () => {
    const scheduleOnly: SessionUser = { ...EXECUTION, permissions: afterPageSplit(['DASHBOARD:VIEW', 'AMC_SCHEDULE:VIEW']) }
    const api = calendarApi({ user: scheduleOnly })
    renderApp(`/amc/calendar?month=${YEAR}-03`)

    await monthsOf(YEAR)
    expect(api.find('GET', '/amc/reports/expiring')).toHaveLength(0)
    // Without contract or client access, those filters are shown greyed out with the reason, not as empty lists.
    expect(screen.getByLabelText('System')).toBeDisabled()
    expect(screen.getByLabelText('System')).toHaveTextContent('Not available for your role (needs AMC Contracts)')
    expect(screen.getByLabelText('Client')).toBeDisabled()
    expect(screen.getByLabelText('Client')).toHaveTextContent('Not available for your role (needs the client list)')
    expect(api.find('GET', '/amc/contracts/systems')).toHaveLength(0)
  })
})

describe('Monthly Calendar access', () => {
  it('is listed as Monthly Calendar and refused without schedule access', async () => {
    const api = calendarApi({ user: ACCOUNTANT })
    renderApp('/amc/calendar')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(api.find('GET', '/amc/visits/year-summary')).toHaveLength(0)
  })
})

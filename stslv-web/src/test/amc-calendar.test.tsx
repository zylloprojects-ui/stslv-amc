import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { currentMonth, formatDate, monthLabel, shiftMonth } from '../pages/amc/amcFormat'
import { ACCOUNTANT, ADMIN, renderApp } from './helpers'
import { amcApi, EXECUTION, makeVisit } from './amc-helpers'

// The AMC Calendar page. Every record here is invented test data.

const MONTH = currentMonth()
const day = (n: number) => `${MONTH}-${String(n).padStart(2, '0')}`

const VISITS = [
  makeVisit({ id: '501', sequenceNo: 1, scheduledDate: day(3), status: 'COMPLETED', completedDate: day(3) }),
  makeVisit({ id: '502', sequenceNo: 2, scheduledDate: day(3), client: { id: '11', name: 'Test Hotel Two' }, contract: { id: '101', status: 'ACTIVE', systemDescription: 'CCTV', maintenanceFrequency: 'MONTHLY' } }),
  makeVisit({ id: '503', sequenceNo: 3, scheduledDate: day(3), status: 'POSTPONED' }),
  makeVisit({ id: '504', sequenceNo: 4, scheduledDate: day(3) }),
  makeVisit({ id: '505', sequenceNo: 5, scheduledDate: day(12), isOverdue: true }),
  makeVisit({ id: '506', sequenceNo: 6, scheduledDate: `${shiftMonth(MONTH, 1)}-05` }),
]

async function monthGrid() {
  return within(await screen.findByRole('group', { name: `Visits in ${monthLabel(MONTH)}` }))
}

describe('AMC Calendar', () => {
  it('places the month’s visits on their scheduled days, asking only for that month', async () => {
    const api = amcApi(ADMIN, { visits: VISITS })
    renderApp('/amc/calendar')

    const grid = await monthGrid()
    const third = within(grid.getByRole('group', { name: `${formatDate(day(3))}, 4 visits` }))
    expect(third.getAllByRole('button', { name: /Test Hotel/ })).toHaveLength(3)
    expect(third.getByRole('button', { name: '+1 more' })).toBeInTheDocument()
    expect(grid.getByRole('group', { name: `${formatDate(day(12))}, 1 visit` })).toBeInTheDocument()
    expect(screen.getByText('5 visits this month')).toBeInTheDocument()

    const request = api.find('GET', '/amc/visits')[0]
    expect(request?.query.get('from')).toBe(`${MONTH}-01`)
    expect(request?.query.get('to')?.startsWith(MONTH)).toBe(true)
    expect(request?.query.get('status')?.split(',')).not.toContain('HISTORICAL')
  })

  it('marks overdue visits and labels each visit with its status', async () => {
    amcApi(ADMIN, { visits: VISITS })
    renderApp('/amc/calendar')

    const grid = await monthGrid()
    expect(grid.getByRole('button', { name: 'Test Hotel One — FIRE, visit 5, Scheduled, overdue' })).toBeInTheDocument()
    expect(grid.getByRole('button', { name: 'Test Hotel One — FIRE, visit 1, Completed' })).toBeInTheDocument()
  })

  it('shows every visit of a busy day on request, with a link to the contract', async () => {
    amcApi(ADMIN, { visits: VISITS })
    renderApp('/amc/calendar')

    const grid = await monthGrid()
    await userEvent.click(grid.getByRole('button', { name: '+1 more' }))

    const dayList = within(screen.getByRole('region', { name: `Visits on ${formatDate(day(3))}` }))
    expect(dayList.getAllByRole('listitem')).toHaveLength(4)
    expect(dayList.getAllByRole('link', { name: 'Open contract' })[0]).toHaveAttribute('href', '/amc/contracts/100')
  })

  it('opens the existing visit details from the calendar', async () => {
    amcApi(ADMIN, { visits: VISITS })
    renderApp('/amc/calendar')

    const grid = await monthGrid()
    await userEvent.click(grid.getByRole('button', { name: /visit 5, Scheduled, overdue/ }))

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('moves between months and back to the current one', async () => {
    const api = amcApi(ADMIN, { visits: VISITS })
    renderApp('/amc/calendar')

    await monthGrid()
    await userEvent.click(screen.getByRole('button', { name: 'Next month' }))

    const next = shiftMonth(MONTH, 1)
    expect(await screen.findByRole('group', { name: `Visits in ${monthLabel(next)}` })).toBeInTheDocument()
    await waitFor(() => expect(api.find('GET', '/amc/visits').some((request) => request.query.get('from') === `${next}-01`)).toBe(true))
    expect(await screen.findByText('1 visit this month')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'This month' }))
    expect(await monthGrid()).toBeTruthy()
  })

  it('filters by status and client through the API', async () => {
    const api = amcApi(ADMIN, { visits: VISITS })
    renderApp('/amc/calendar')

    await monthGrid()
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'POSTPONED')
    await waitFor(() => expect(screen.getByText('1 visit this month')).toBeInTheDocument())
    expect(api.find('GET', '/amc/visits').at(-1)?.query.get('status')).toBe('POSTPONED')

    await userEvent.selectOptions(screen.getByLabelText('Status'), '')
    await userEvent.selectOptions(await screen.findByLabelText('Client'), '11')
    await waitFor(() => expect(api.find('GET', '/amc/visits').at(-1)?.query.get('clientId')).toBe('11'))
    expect(await screen.findByText('1 visit this month')).toBeInTheDocument()
  })

  it('says so when a month has no visits', async () => {
    amcApi(ADMIN, { visits: [] })
    renderApp('/amc/calendar')

    expect(await screen.findByText('No visits this month')).toBeInTheDocument()
  })

  it('is open to the Execution role', async () => {
    amcApi(EXECUTION, { visits: VISITS })
    renderApp('/amc/calendar')
    expect(await monthGrid()).toBeTruthy()
  })

  it('refuses the page to a role without schedule access, without requesting visits', async () => {
    const api = amcApi(ACCOUNTANT, { visits: VISITS })
    renderApp('/amc/calendar')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(api.find('GET', '/amc/visits')).toHaveLength(0)
  })
})

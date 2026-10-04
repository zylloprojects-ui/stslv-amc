import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { currentMonth, formatDate, formatMoney, isZeroMoney, monthLabel, monthRange, shiftMonth } from '../pages/amc/amcFormat'
import { ACCOUNTANT, ADMIN, fail, renderApp } from './helpers'
import { amcApi, makeVisit, VIEWER } from './amc-helpers'

// Visits are placed in the current month, which is what the schedule opens on.
const MONTH = currentMonth()
const NEXT = shiftMonth(MONTH, 1)
const day = (month: string, date: string) => `${month}-${date}`

const FIRST = makeVisit({ scheduledDate: day(MONTH, '01'), originalScheduledDate: day(MONTH, '01') })
const SECOND = makeVisit({
  id: '501',
  contract: { id: '101', status: 'ACTIVE', systemDescription: 'CCTV', maintenanceFrequency: 'MONTHLY' },
  client: { id: '11', name: 'Test Hotel Two' },
  sequenceNo: 3,
  scheduledDate: day(MONTH, '15'),
  originalScheduledDate: day(MONTH, '10'),
  isRescheduled: true,
  status: 'COMPLETED',
  completedDate: day(MONTH, '15'),
  completedBy: { id: '3', fullName: 'Esa Execution' },
  workPerformed: 'Cameras cleaned and tested',
  visitAmount: '9000.000',
  amountIsCustom: true,
  invoiceEligibility: 'READY_FOR_INVOICE',
})
const LATER = makeVisit({ id: '502', sequenceNo: 2, scheduledDate: day(NEXT, '01'), originalScheduledDate: day(NEXT, '01') })

describe('money and date formatting', () => {
  it('formats amounts as text with three decimals, without floating-point arithmetic', () => {
    expect(formatMoney('9000.000')).toBe('9,000.000')
    expect(formatMoney('1577.276')).toBe('1,577.276')
    expect(formatMoney('0.000')).toBe('0.000')
    expect(formatMoney('99999999999.999')).toBe('99,999,999,999.999')
    expect(formatMoney('-620.000')).toBe('-620.000')
    expect(formatMoney(null)).toBe('—')
    expect(isZeroMoney('0.000')).toBe(true)
    expect(isZeroMoney('0.001')).toBe(false)
    expect(isZeroMoney(null)).toBe(false)
  })

  it('formats calendar days and months without time-zone shifts', () => {
    expect(formatDate('2027-01-05')).toBe('05 Jan 2027')
    expect(formatDate(null)).toBe('—')
    expect(monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' })
    expect(monthRange('2027-12')).toEqual({ from: '2027-12-01', to: '2027-12-31' })
    expect(shiftMonth('2027-12', 1)).toBe('2028-01')
    expect(shiftMonth('2027-01', -1)).toBe('2026-12')
    expect(monthLabel('2027-03')).toBe('March 2027')
  })
})

describe('schedule', () => {
  it('opens on the current month and lists its dated visits with status, amount and invoicing state', async () => {
    const api = amcApi(ADMIN, { visits: [FIRST, SECOND, LATER] })
    renderApp('/amc/schedule')

    const table = await screen.findByRole('table', { name: `AMC schedule for ${monthLabel(MONTH)}` })
    const rows = within(table).getAllByRole('row').slice(1)

    expect(rows).toHaveLength(2)
    const first = within(rows[0] as HTMLElement)
    expect(first.getByText(formatDate(FIRST.scheduledDate))).toBeInTheDocument()
    expect(first.getByText('Test Hotel One')).toBeInTheDocument()
    expect(first.getByText('Scheduled')).toBeInTheDocument()
    expect(first.getByText('405.000')).toBeInTheDocument()

    const second = within(rows[1] as HTMLElement)
    expect(second.getByText('Completed')).toBeInTheDocument()
    expect(second.getByText('9,000.000')).toBeInTheDocument()
    expect(second.getByText('Ready for invoice')).toBeInTheDocument()
    expect(second.getByText(`was ${formatDate(SECOND.originalScheduledDate)}`)).toBeInTheDocument()

    expect(screen.getByText(/Total amount/)).toHaveTextContent('Total amount 810.000 (cancelled visits excluded)')
    expect(screen.queryByText('Module implementation in progress')).not.toBeInTheDocument()

    const query = api.find('GET', '/amc/visits')[0]?.query
    expect(query?.get('from')).toBe(monthRange(MONTH).from)
    expect(query?.get('to')).toBe(monthRange(MONTH).to)
  })

  it('moves between months and can show all dates', async () => {
    const api = amcApi(ADMIN, { visits: [FIRST, LATER] })
    renderApp('/amc/schedule')
    await screen.findByRole('table', { name: `AMC schedule for ${monthLabel(MONTH)}` })

    await userEvent.click(screen.getByRole('button', { name: 'Next month' }))

    const table = await screen.findByRole('table', { name: `AMC schedule for ${monthLabel(NEXT)}` })
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(1)
    expect(api.find('GET', '/amc/visits').at(-1)?.query.get('from')).toBe(monthRange(NEXT).from)

    await userEvent.click(screen.getByRole('button', { name: 'All dates' }))

    const all = await screen.findByRole('table', { name: 'AMC schedule' })
    expect(within(all).getAllByRole('row').slice(1)).toHaveLength(2)
    expect(api.find('GET', '/amc/visits').at(-1)?.query.has('from')).toBe(false)

    // A month can also be picked directly.
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2027-02' } })
    expect(await screen.findByText('No visits in February 2027')).toBeInTheDocument()
    expect(api.find('GET', '/amc/visits').at(-1)?.query.get('to')).toBe('2027-02-28')
  })

  it('filters by client, status, system and invoicing state through the API', async () => {
    const api = amcApi(ADMIN, { visits: [FIRST, SECOND], contracts: [] })
    renderApp('/amc/schedule')
    await screen.findByRole('table', { name: `AMC schedule for ${monthLabel(MONTH)}` })

    await userEvent.selectOptions(screen.getByLabelText('Client'), '11')
    await waitFor(() => expect(screen.queryByText('Test Hotel One', { selector: 'td' })).not.toBeInTheDocument())

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'COMPLETED')
    await userEvent.selectOptions(screen.getByLabelText('Invoicing'), 'READY_FOR_INVOICE')

    await waitFor(() => expect(api.find('GET', '/amc/visits').at(-1)?.query.get('invoiceEligibility')).toBe('READY_FOR_INVOICE'))
    const query = api.find('GET', '/amc/visits').at(-1)?.query
    expect(query?.get('clientId')).toBe('11')
    expect(query?.get('status')).toBe('COMPLETED')
    expect(screen.getByText('Test Hotel Two', { selector: 'td' })).toBeInTheDocument()
  })

  it('shows the stored details of a visit', async () => {
    const api = amcApi(ADMIN, { visits: [SECOND] })
    renderApp('/amc/schedule')

    await userEvent.click(await screen.findByRole('button', { name: 'View Test Hotel Two CCTV visit 3' }))
    const dialog = await screen.findByRole('dialog', { name: 'Visit details' })

    expect(await within(dialog).findByText('Cameras cleaned and tested')).toBeInTheDocument()
    expect(dialog).toHaveTextContent('9,000.000 (set on this visit)')
    expect(dialog).toHaveTextContent(`(originally ${formatDate(SECOND.originalScheduledDate)})`)
    expect(dialog).toHaveTextContent('recorded by Esa Execution')
    expect(within(dialog).getByText('Ready for invoice')).toBeInTheDocument()
    expect(api.find('GET', '/amc/visits/501')).toHaveLength(1)
  })

  it('shows an error with a retry when the schedule cannot be loaded', async () => {
    let failing = true
    amcApi(ADMIN, {
      visits: [FIRST],
      override: (request) => (failing && request.path === '/amc/visits' ? fail(500, 'INTERNAL_ERROR', 'An unexpected error occurred.') : undefined),
    })
    renderApp('/amc/schedule')

    expect(await screen.findByRole('alert')).toHaveTextContent('An unexpected error occurred.')
    failing = false
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('Test Hotel One', { selector: 'td' })).toBeInTheDocument()
  })
})

describe('edit visit', () => {
  it('changes the amount of one visit, sent as text', async () => {
    const api = amcApi(ADMIN, { visits: [FIRST] })
    renderApp('/amc/schedule')

    await userEvent.click(await screen.findByRole('button', { name: 'Edit Test Hotel One FIRE visit 1' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit visit' })
    const amount = within(dialog).getByLabelText('Visit amount')

    expect(amount).toHaveValue('405.000')
    expect(within(dialog).getByLabelText(/Scheduled date/)).toHaveValue(FIRST.scheduledDate)

    await userEvent.clear(amount)
    await userEvent.type(amount, '0')
    await userEvent.type(within(dialog).getByLabelText('Planning notes'), 'No charge this period')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('PATCH', '/amc/visits/500')[0]?.body).toEqual({
      visitAmount: '0',
      scheduledDate: FIRST.scheduledDate,
      assignedTo: '',
      notes: 'No charge this period',
    })
    expect(screen.getByRole('status')).toHaveTextContent('Visit 1 for Test Hotel One (FIRE) was updated.')
  })

  it('rejects an invalid amount before calling the API', async () => {
    const api = amcApi(ADMIN, { visits: [FIRST] })
    renderApp('/amc/schedule')

    await userEvent.click(await screen.findByRole('button', { name: 'Edit Test Hotel One FIRE visit 1' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit visit' })
    const amount = within(dialog).getByLabelText('Visit amount')

    await userEvent.clear(amount)
    await userEvent.type(amount, '405.1234')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    expect(await within(dialog).findByText('Enter an amount of zero or more with at most 3 decimal places.')).toBeInTheDocument()
    expect(api.find('PATCH', '/amc/visits/500')).toHaveLength(0)
  })

  it('does not offer to reschedule a completed visit', async () => {
    const api = amcApi(ADMIN, { visits: [SECOND] })
    renderApp('/amc/schedule')

    await userEvent.click(await screen.findByRole('button', { name: 'Edit Test Hotel Two CCTV visit 3' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit visit' })

    expect(within(dialog).getByLabelText(/Scheduled date/)).toBeDisabled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(api.find('PATCH', '/amc/visits/501')).toHaveLength(1))
    expect(api.find('PATCH', '/amc/visits/501')[0]?.body).not.toHaveProperty('scheduledDate')
  })
})

describe('schedule permissions', () => {
  it('lets a view-only role see amounts but not edit them', async () => {
    amcApi(VIEWER, { visits: [FIRST] })
    renderApp('/amc/schedule')

    expect(await screen.findByRole('button', { name: 'View Test Hotel One FIRE visit 1' })).toBeInTheDocument()
    expect(screen.getByText('405.000')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'View Test Hotel One FIRE visit 1' }))
    const dialog = await screen.findByRole('dialog', { name: 'Visit details' })
    await within(dialog).findByText('Test Engineer')
    expect(within(dialog).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
  })

  it('refuses the page to a role without AMC Schedule access, without requesting its data', async () => {
    const api = amcApi(ACCOUNTANT, { visits: [FIRST] })
    renderApp('/amc/schedule')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(api.find('GET', '/amc/visits')).toHaveLength(0)
  })
})

import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { currentMonth, monthLabel } from '../pages/amc/amcFormat'
import { ADMIN, ok, renderApp } from './helpers'
import { amcApi, EXECUTION, makeVisit, VIEWER } from './amc-helpers'

// Visit actions on the AMC Schedule: the execution form (start, complete,
// postpone, cancel, work notes), saved through PATCH /amc/execution/visits/:id
// exactly as before. Only the execution permissions open it.

const MONTH = currentMonth()
const VISIT = makeVisit({ scheduledDate: `${MONTH}-02`, originalScheduledDate: `${MONTH}-02`, periodStart: `${MONTH}-01`, periodEnd: `${MONTH}-28` })
const ACTIONS = 'Visit actions for Test Hotel One FIRE visit 1'

const SUMMARY = {
  amc: {
    visits: { due: 4, overdue: 1, dueThisMonth: 3, completedThisMonth: 2 },
    invoicing: { readyForInvoice: { count: 1, amount: '405.000' }, amountRequired: { count: 0 } },
  },
}
const withSummary = (request: { method: string; path: string }) =>
  request.method === 'GET' && request.path === '/dashboard/summary' ? ok(SUMMARY) : undefined

describe('AMC Schedule visit actions', () => {
  it('lets an execution user postpone a visit with a new date and a reason, through the execution API', async () => {
    const api = amcApi(EXECUTION, { visits: [VISIT] })
    renderApp('/amc/schedule')

    await userEvent.click(await screen.findByRole('button', { name: ACTIONS }))
    const dialog = await screen.findByRole('dialog', { name: 'Update visit' })
    expect(api.find('GET', '/amc/execution/visits/500')).toHaveLength(1)

    await userEvent.selectOptions(within(dialog).getByLabelText(/^Status/), 'POSTPONED')
    fireEvent.change(within(dialog).getByLabelText(/^Planned date/), { target: { value: `${MONTH}-20` } })
    await userEvent.type(within(dialog).getByLabelText(/^Reason for postponing/), 'Site closed for inspection')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(api.find('PATCH', '/amc/execution/visits/500')).toHaveLength(1))
    expect(api.find('PATCH', '/amc/execution/visits/500')[0]?.body).toEqual({
      status: 'POSTPONED',
      workPerformed: '',
      executionNotes: '',
      scheduledDate: `${MONTH}-20`,
      statusReason: 'Site closed for inspection',
    })
    expect(await screen.findByText('Visit 1 for Test Hotel One (FIRE) is now postponed.')).toBeInTheDocument()
    // Nothing went through the planning endpoint.
    expect(api.find('PATCH', '/amc/visits/500')).toHaveLength(0)
  })

  it('starts a visit (In progress) without asking for a reason or a completion date', async () => {
    const api = amcApi(EXECUTION, { visits: [VISIT] })
    renderApp('/amc/schedule')

    await userEvent.click(await screen.findByRole('button', { name: ACTIONS }))
    const dialog = await screen.findByRole('dialog', { name: 'Update visit' })
    await userEvent.selectOptions(within(dialog).getByLabelText(/^Status/), 'IN_PROGRESS')
    expect(within(dialog).queryByLabelText(/^Reason/)).not.toBeInTheDocument()
    expect(within(dialog).queryByLabelText(/^Completion date/)).not.toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(api.find('PATCH', '/amc/execution/visits/500')[0]?.body).toMatchObject({ status: 'IN_PROGRESS' }))
  })

  it('offers no visit actions without the AMC Execution edit permission', async () => {
    amcApi(VIEWER, { visits: [VISIT] })
    renderApp('/amc/schedule')

    await screen.findByRole('table', { name: `AMC schedule for ${monthLabel(MONTH)}` })
    expect(screen.queryByRole('button', { name: ACTIONS })).not.toBeInTheDocument()
  })

  it('never offers actions on a historical row', async () => {
    amcApi(ADMIN, { visits: [{ ...VISIT, status: 'HISTORICAL' }] })
    renderApp('/amc/schedule')

    await screen.findByRole('table', { name: `AMC schedule for ${monthLabel(MONTH)}` })
    expect(screen.queryByRole('button', { name: ACTIONS })).not.toBeInTheDocument()
  })

  it('says the cards count all dates while the list follows the month filter', async () => {
    amcApi(ADMIN, { visits: [VISIT], override: withSummary })
    renderApp('/amc/schedule')

    const note = await screen.findByRole('note', { name: 'What the figures count' })
    expect(note).toHaveTextContent('The cards do not follow the filters below.')
    expect(note).toHaveTextContent(`List: visits scheduled in ${monthLabel(MONTH)}, with the filters below.`)
    expect(screen.getByLabelText('Scheduled month')).toHaveValue(MONTH)

    await userEvent.click(screen.getByRole('button', { name: 'All dates' }))
    expect(await screen.findByText(/visits of all dates, with the filters below/)).toBeInTheDocument()
  })
})

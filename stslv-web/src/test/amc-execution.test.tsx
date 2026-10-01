import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { todayIso } from '../pages/amc/amcFormat'
import { ACCOUNTANT, ADMIN, fail, renderApp } from './helpers'
import { amcApi, EXECUTION, makeVisit, VIEWER } from './amc-helpers'

const OVERDUE = makeVisit({ scheduledDate: '2026-01-01', originalScheduledDate: '2026-01-01', periodStart: '2026-01-01', periodEnd: '2026-03-31', isOverdue: true })
const STARTED = makeVisit({
  id: '501',
  client: { id: '11', name: 'Test Hotel Two' },
  contract: { id: '101', status: 'ACTIVE', systemDescription: 'CCTV', maintenanceFrequency: 'MONTHLY' },
  sequenceNo: 2,
  status: 'IN_PROGRESS',
  executionNotes: 'Waiting for access',
})
const DONE = makeVisit({
  id: '502',
  sequenceNo: 3,
  status: 'COMPLETED',
  completedDate: '2026-09-20',
  completedBy: { id: '3', fullName: 'Esa Execution' },
  workPerformed: 'Panel tested',
  invoiceEligibility: 'READY_FOR_INVOICE',
})

describe('work list', () => {
  it('lists the work that is due from the API, without amounts', async () => {
    const api = amcApi(EXECUTION, { visits: [OVERDUE, STARTED, DONE] })
    renderApp('/amc/execution')

    const table = await screen.findByRole('table', { name: 'AMC visits: Due and overdue' })
    const rows = within(table).getAllByRole('row').slice(1)

    expect(rows).toHaveLength(2)
    const first = within(rows[0] as HTMLElement)
    expect(first.getByText('01 Jan 2026')).toBeInTheDocument()
    expect(first.getByText('Test Hotel One')).toBeInTheDocument()
    expect(first.getByText('Scheduled')).toBeInTheDocument()
    expect(first.getByText('Overdue')).toBeInTheDocument()
    expect(first.getByText('Test Engineer')).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('In progress')).toBeInTheDocument()

    // The execution screen carries no money.
    expect(within(table).queryByText('Amount')).not.toBeInTheDocument()
    expect(within(table).queryByText('405.000')).not.toBeInTheDocument()
    expect(screen.queryByText('Module implementation in progress')).not.toBeInTheDocument()
    expect(api.find('GET', '/amc/execution/visits')[0]?.query.get('scope')).toBe('due')
    expect(api.find('GET', '/amc/visits')).toHaveLength(0)
  })

  it('switches between due, upcoming and completed work through the API', async () => {
    const api = amcApi(EXECUTION, { visits: [OVERDUE, DONE] })
    renderApp('/amc/execution')
    await screen.findByRole('table', { name: 'AMC visits: Due and overdue' })

    await userEvent.selectOptions(screen.getByLabelText('Show'), 'completed')

    const table = await screen.findByRole('table', { name: 'AMC visits: Completed' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(1)
    expect(within(rows[0] as HTMLElement).getByText('20 Sep 2026')).toBeInTheDocument()
    expect(api.find('GET', '/amc/execution/visits').at(-1)?.query.get('scope')).toBe('completed')

    await userEvent.selectOptions(screen.getByLabelText('Show'), 'upcoming')
    await waitFor(() => expect(api.find('GET', '/amc/execution/visits').at(-1)?.query.get('scope')).toBe('upcoming'))
    expect(api.find('GET', '/amc/execution/visits').at(-1)?.query.get('days')).toBe('30')
  })

  it('shows an empty state when nothing is due', async () => {
    amcApi(EXECUTION, { visits: [DONE] })
    renderApp('/amc/execution')

    expect(await screen.findByText('No visits are due.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})

describe('update execution', () => {
  it('starts a visit with one action', async () => {
    const api = amcApi(EXECUTION, { visits: [OVERDUE] })
    renderApp('/amc/execution')

    await userEvent.click(await screen.findByRole('button', { name: 'Start Test Hotel One FIRE visit 1' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Visit 1 for Test Hotel One (FIRE) is now in progress.')
    expect(api.find('PATCH', '/amc/execution/visits/500')[0]?.body).toEqual({ status: 'IN_PROGRESS' })
    // The list is read again: the visit is now in progress and can no longer be started.
    expect(await screen.findByText('In progress')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Start / })).not.toBeInTheDocument()
  })

  it('completes a visit with the completion date and the work performed', async () => {
    const api = amcApi(EXECUTION, { visits: [OVERDUE, STARTED] })
    renderApp('/amc/execution')

    await userEvent.click(await screen.findByRole('button', { name: 'Complete Test Hotel Two CCTV visit 2' }))
    const dialog = await screen.findByRole('dialog', { name: 'Complete visit' })

    // The date defaults to today and the existing notes are kept.
    expect(within(dialog).getByLabelText(/Completion date/)).toHaveValue(todayIso())
    expect(within(dialog).getByLabelText('Execution notes')).toHaveValue('Waiting for access')
    expect(within(dialog).queryByLabelText(/Status/)).not.toBeInTheDocument()

    fireEvent.change(within(dialog).getByLabelText(/Completion date/), { target: { value: '2026-09-28' } })
    await userEvent.type(within(dialog).getByLabelText('Work performed'), 'Cameras cleaned and tested')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark as completed' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('PATCH', '/amc/execution/visits/501')[0]?.body).toEqual({
      status: 'COMPLETED',
      completedDate: '2026-09-28',
      workPerformed: 'Cameras cleaned and tested',
      executionNotes: 'Waiting for access',
    })
    expect(screen.getByRole('status')).toHaveTextContent('Visit 2 for Test Hotel Two (CCTV) was completed.')
    // Completed work leaves the list of due work.
    await waitFor(() => expect(screen.queryByText('Test Hotel Two', { selector: 'td' })).not.toBeInTheDocument())
    expect(screen.getByText('Test Hotel One', { selector: 'td' })).toBeInTheDocument()
  })

  it('requires a completion date that is not in the future', async () => {
    const api = amcApi(EXECUTION, { visits: [OVERDUE] })
    renderApp('/amc/execution')

    await userEvent.click(await screen.findByRole('button', { name: 'Complete Test Hotel One FIRE visit 1' }))
    const dialog = await screen.findByRole('dialog', { name: 'Complete visit' })
    const date = within(dialog).getByLabelText(/Completion date/)

    fireEvent.change(date, { target: { value: '' } })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark as completed' }))
    expect(await within(dialog).findByText('Enter the date the visit was completed.')).toBeInTheDocument()

    fireEvent.change(date, { target: { value: '2999-01-01' } })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark as completed' }))
    expect(await within(dialog).findByText('The completion date cannot be in the future.')).toBeInTheDocument()

    expect(api.find('PATCH', '/amc/execution/visits/500')).toHaveLength(0)
  })

  it('postpones a visit to a new date with a reason', async () => {
    const api = amcApi(EXECUTION, { visits: [OVERDUE] })
    renderApp('/amc/execution')

    await userEvent.click(await screen.findByRole('button', { name: 'Update Test Hotel One FIRE visit 1' }))
    const dialog = await screen.findByRole('dialog', { name: 'Update visit' })

    await userEvent.selectOptions(within(dialog).getByLabelText(/Status/), 'POSTPONED')
    fireEvent.change(within(dialog).getByLabelText(/Planned date/), { target: { value: '2026-02-10' } })
    await userEvent.type(within(dialog).getByLabelText('Reason for postponing'), 'Client requested a later date')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('PATCH', '/amc/execution/visits/500')[0]?.body).toEqual({
      status: 'POSTPONED',
      scheduledDate: '2026-02-10',
      statusReason: 'Client requested a later date',
      workPerformed: '',
      executionNotes: '',
    })
    expect(await screen.findByText('Postponed')).toBeInTheDocument()
    expect(screen.getByText('was 01 Jan 2026')).toBeInTheDocument()
  })

  it('cancels a visit, which then leaves the work list', async () => {
    const api = amcApi(EXECUTION, { visits: [OVERDUE] })
    renderApp('/amc/execution')

    await userEvent.click(await screen.findByRole('button', { name: 'Update Test Hotel One FIRE visit 1' }))
    const dialog = await screen.findByRole('dialog', { name: 'Update visit' })
    await userEvent.selectOptions(within(dialog).getByLabelText(/Status/), 'CANCELLED')

    // A cancelled visit has no planned date to change.
    expect(within(dialog).queryByLabelText(/Planned date/)).not.toBeInTheDocument()
    await userEvent.type(within(dialog).getByLabelText('Reason for cancelling'), 'Site closed')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(api.find('PATCH', '/amc/execution/visits/500')).toHaveLength(1))
    expect(api.find('PATCH', '/amc/execution/visits/500')[0]?.body).toMatchObject({ status: 'CANCELLED', statusReason: 'Site closed' })
    expect(api.find('PATCH', '/amc/execution/visits/500')[0]?.body).not.toHaveProperty('scheduledDate')
    expect(await screen.findByText('No visits are due.')).toBeInTheDocument()
  })

  it('shows a field error from the API on that field and keeps the dialog open', async () => {
    amcApi(EXECUTION, {
      visits: [OVERDUE],
      override: (request) =>
        request.method === 'PATCH'
          ? fail(400, 'VALIDATION_ERROR', 'The completion date cannot be in the future.', [
              { field: 'completedDate', message: 'The completion date cannot be in the future.' },
            ])
          : undefined,
    })
    renderApp('/amc/execution')

    await userEvent.click(await screen.findByRole('button', { name: 'Complete Test Hotel One FIRE visit 1' }))
    const dialog = await screen.findByRole('dialog', { name: 'Complete visit' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark as completed' }))

    expect(await within(dialog).findByText('The completion date cannot be in the future.')).toBeInTheDocument()
    expect(within(dialog).getByLabelText(/Completion date/)).toHaveAttribute('aria-invalid', 'true')
  })
})

describe('completed visits', () => {
  it('lets work notes be corrected but not the status, without approval permission', async () => {
    const api = amcApi(EXECUTION, { visits: [DONE] })
    renderApp('/amc/execution')
    await userEvent.selectOptions(await screen.findByLabelText('Show'), 'completed')

    await userEvent.click(await screen.findByRole('button', { name: 'Update Test Hotel One FIRE visit 3' }))
    const dialog = await screen.findByRole('dialog', { name: 'Update visit' })

    expect(within(dialog).getByLabelText(/Status/)).toBeDisabled()
    expect(dialog).toHaveTextContent('A completed visit can only be reopened by a user with approval permission.')
    // A completed visit is not offered Start or Complete again.
    expect(screen.queryByRole('button', { name: /^(Start|Complete) / })).not.toBeInTheDocument()

    const work = within(dialog).getByLabelText('Work performed')
    await userEvent.clear(work)
    await userEvent.type(work, 'Panel tested and battery replaced')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(api.find('PATCH', '/amc/execution/visits/502')).toHaveLength(1))
    expect(api.find('PATCH', '/amc/execution/visits/502')[0]?.body).toEqual({
      status: 'COMPLETED',
      completedDate: '2026-09-20',
      workPerformed: 'Panel tested and battery replaced',
      executionNotes: '',
    })
  })

  it('lets a user with approval permission reopen a completed visit', async () => {
    const api = amcApi(ADMIN, { visits: [DONE] })
    renderApp('/amc/execution')
    await userEvent.selectOptions(await screen.findByLabelText('Show'), 'completed')

    await userEvent.click(await screen.findByRole('button', { name: 'Update Test Hotel One FIRE visit 3' }))
    const dialog = await screen.findByRole('dialog', { name: 'Update visit' })
    const status = within(dialog).getByLabelText(/Status/)

    expect(status).toBeEnabled()
    await userEvent.selectOptions(status, 'IN_PROGRESS')
    expect(dialog).toHaveTextContent('Reopening removes the completion date')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(api.find('PATCH', '/amc/execution/visits/502')).toHaveLength(1))
    expect(api.find('PATCH', '/amc/execution/visits/502')[0]?.body).toMatchObject({ status: 'IN_PROGRESS' })
    expect(api.find('PATCH', '/amc/execution/visits/502')[0]?.body).not.toHaveProperty('completedDate')
  })

  it('shows the recorded work in a read-only view', async () => {
    amcApi(VIEWER, { visits: [DONE] })
    renderApp('/amc/execution')
    await userEvent.selectOptions(await screen.findByLabelText('Show'), 'completed')

    await userEvent.click(await screen.findByRole('button', { name: 'View Test Hotel One FIRE visit 3' }))
    const dialog = await screen.findByRole('dialog', { name: 'Visit details' })

    expect(within(dialog).getByText('Panel tested')).toBeInTheDocument()
    expect(dialog).toHaveTextContent('20 Sep 2026 · recorded by Esa Execution')
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument()
  })
})

describe('execution permissions', () => {
  it('offers a view-only role no way to start, complete or update a visit', async () => {
    amcApi(VIEWER, { visits: [OVERDUE] })
    renderApp('/amc/execution')

    expect(await screen.findByRole('button', { name: 'View Test Hotel One FIRE visit 1' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^(Start|Complete|Update) / })).not.toBeInTheDocument()
  })

  it('refuses the page to a role without AMC Execution access, without requesting its data', async () => {
    const api = amcApi(ACCOUNTANT, { visits: [OVERDUE] })
    renderApp('/amc/execution')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(api.find('GET', '/amc/execution/visits')).toHaveLength(0)
  })

  it('shows the message from the API when an action is refused', async () => {
    // The screen believes the user may start the visit; the API is the authority and says no.
    amcApi(EXECUTION, {
      visits: [OVERDUE],
      override: (request) => (request.method === 'PATCH' ? fail(403, 'FORBIDDEN', 'You do not have permission to perform this action.') : undefined),
    })
    renderApp('/amc/execution')

    await userEvent.click(await screen.findByRole('button', { name: 'Start Test Hotel One FIRE visit 1' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission to perform this action.')
    expect(screen.getByText('Scheduled')).toBeInTheDocument()
  })
})

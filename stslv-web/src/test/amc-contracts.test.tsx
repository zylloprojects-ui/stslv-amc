import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ACCOUNTANT, ADMIN, fail, renderApp } from './helpers'
import { amcApi, makeContract, makeVisit, VIEWER } from './amc-helpers'

const FIRE = makeContract()
const DRAFT = makeContract({
  id: '101',
  client: { id: '11', name: 'Test Hotel Two', isActive: true },
  systemDescription: 'CCTV',
  status: 'DRAFT',
  contractValue: '9000.000',
  finalCredit: '8000.000',
  schedule: { visitCount: 0, completedCount: 0, openCount: 0, historicalCount: 0, cancelledCount: 0, amountMissingCount: 0, scheduledTotal: '0.000', valueDifference: '9000.000' },
})

async function openAddForm() {
  await userEvent.click(await screen.findByRole('button', { name: 'Add Contract' }))
  const dialog = await screen.findByRole('dialog', { name: 'Add AMC Contract' })
  await within(dialog).findByLabelText(/Client/)

  return dialog
}

describe('contract list', () => {
  it('lists the contracts returned by the API with client, validity, value, progress and status', async () => {
    const api = amcApi(ADMIN, { contracts: [FIRE, DRAFT] })
    renderApp('/amc/contracts')

    const table = await screen.findByRole('table', { name: 'AMC contracts' })
    const rows = within(table).getAllByRole('row').slice(1)

    expect(rows).toHaveLength(2)
    const first = within(rows[0] as HTMLElement)
    expect(first.getByText('Test Hotel One')).toBeInTheDocument()
    expect(first.getByText('FIRE')).toBeInTheDocument()
    expect(first.getByText('01 Jan 2027 – 31 Dec 2027')).toBeInTheDocument()
    expect(first.getByText('Quarterly')).toBeInTheDocument()
    expect(first.getByText('1,620.000')).toBeInTheDocument()
    expect(first.getByText('1 of 4 completed')).toBeInTheDocument()
    expect(first.getByText('Active')).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('9,000.000')).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('Draft')).toBeInTheDocument()
    // It is no longer a placeholder, and the data came from the API.
    expect(screen.queryByText('Module implementation in progress')).not.toBeInTheDocument()
    expect(api.find('GET', '/amc/contracts')).toHaveLength(1)
  })

  it('shows an empty state when there are no contracts', async () => {
    amcApi(ADMIN)
    renderApp('/amc/contracts')

    expect(await screen.findByText('No AMC contracts yet')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('searches and filters through the API', async () => {
    const api = amcApi(ADMIN, { contracts: [FIRE, DRAFT] })
    renderApp('/amc/contracts')
    await screen.findByRole('table', { name: 'AMC contracts' })

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'DRAFT')
    await waitFor(() => expect(screen.queryByText('Test Hotel One', { selector: 'td' })).not.toBeInTheDocument())
    expect(api.find('GET', '/amc/contracts').at(-1)?.query.get('status')).toBe('DRAFT')

    await userEvent.selectOptions(screen.getByLabelText('Client'), '11')
    await userEvent.selectOptions(screen.getByLabelText('Frequency'), 'QUARTERLY')
    await userEvent.type(screen.getByLabelText('Search'), 'cctv')

    await waitFor(() => expect(api.find('GET', '/amc/contracts').at(-1)?.query.get('search')).toBe('cctv'))
    const last = api.find('GET', '/amc/contracts').at(-1)?.query
    expect(last?.get('clientId')).toBe('11')
    expect(last?.get('frequency')).toBe('QUARTERLY')
  })

  it('shows an error with a retry when the list cannot be loaded', async () => {
    let failing = true
    amcApi(ADMIN, {
      contracts: [FIRE],
      override: (request) => (failing && request.path === '/amc/contracts' ? fail(500, 'INTERNAL_ERROR', 'An unexpected error occurred.') : undefined),
    })
    renderApp('/amc/contracts')

    expect(await screen.findByRole('alert')).toHaveTextContent('An unexpected error occurred.')

    failing = false
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByRole('table', { name: 'AMC contracts' })).toBeInTheDocument()
  })
})

describe('add contract', () => {
  it('validates the form before calling the API', async () => {
    const api = amcApi(ADMIN)
    renderApp('/amc/contracts')
    const dialog = await openAddForm()

    await userEvent.type(within(dialog).getByLabelText(/Contract value/), '1620.1234')
    await userEvent.type(within(dialog).getByLabelText('Final credit'), '-5')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add contract' }))

    expect(await within(dialog).findByText('Select a client.')).toBeInTheDocument()
    expect(within(dialog).getByText('System is required.')).toBeInTheDocument()
    expect(within(dialog).getByText('Valid from is required.')).toBeInTheDocument()
    expect(within(dialog).getByText('Select a maintenance frequency.')).toBeInTheDocument()
    expect(within(dialog).getAllByText('Enter an amount of zero or more with at most 3 decimal places.')).toHaveLength(2)
    expect(api.find('POST', '/amc/contracts')).toHaveLength(0)
  })

  it('rejects a validity that ends before it starts', async () => {
    const api = amcApi(ADMIN)
    renderApp('/amc/contracts')
    const dialog = await openAddForm()

    await userEvent.type(within(dialog).getByLabelText(/Valid from/), '2027-06-01')
    await userEvent.type(within(dialog).getByLabelText(/Valid to/), '2027-05-31')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add contract' }))

    expect(await within(dialog).findByText('Valid to must be on or after Valid from.')).toBeInTheDocument()
    expect(api.find('POST', '/amc/contracts')).toHaveLength(0)
  })

  it('saves a new contract for a client from the Client Master, with money sent as text', async () => {
    const api = amcApi(ADMIN, { contracts: [FIRE] })
    renderApp('/amc/contracts')
    const dialog = await openAddForm()

    await userEvent.selectOptions(within(dialog).getByLabelText(/Client/), '11')
    await userEvent.type(within(dialog).getByLabelText(/System/), ' Automation ')
    await userEvent.type(within(dialog).getByLabelText('Responsible engineer'), 'Second Engineer')
    await userEvent.selectOptions(within(dialog).getByLabelText(/Maintenance frequency/), 'HALF_YEARLY')
    await userEvent.type(within(dialog).getByLabelText(/Valid from/), '2027-03-01')
    await userEvent.type(within(dialog).getByLabelText(/Valid to/), '2028-02-29')
    await userEvent.type(within(dialog).getByLabelText(/Contract value/), '9000')
    await userEvent.type(within(dialog).getByLabelText('Default visit amount'), '4500.000')
    await userEvent.type(within(dialog).getByLabelText('Final credit'), '8000.5')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add contract' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('POST', '/amc/contracts')[0]?.body).toEqual({
      clientId: '11',
      systemDescription: 'Automation',
      responsibleEngineer: 'Second Engineer',
      validFrom: '2027-03-01',
      validTo: '2028-02-29',
      maintenanceFrequency: 'HALF_YEARLY',
      contractValue: '9000',
      defaultVisitAmount: '4500.000',
      finalCredit: '8000.5',
      description: '',
      notes: '',
      status: 'ACTIVE',
    })
    expect(screen.getByRole('status')).toHaveTextContent('The contract for Test Hotel Two Automation was added. 4 visit(s) added to the schedule.')
    // The list is read again from the API.
    expect(await screen.findByRole('button', { name: 'View Test Hotel Two Automation' })).toBeInTheDocument()
  })

  it('offers only clients from the Client Master and suggests systems already in use', async () => {
    amcApi(ADMIN, { contracts: [FIRE] })
    renderApp('/amc/contracts')
    const dialog = await openAddForm()

    const options = within(within(dialog).getByLabelText(/Client/)).getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual(['Select a client…', 'Test Hotel One', 'Test Hotel Two'])
    await waitFor(() => expect(dialog.querySelector('datalist option')?.getAttribute('value')).toBe('FIRE'))
    // There is no contract number or client code to fill in.
    expect(within(dialog).queryByLabelText(/number|code/i)).not.toBeInTheDocument()
  })

  it('shows a field error returned by the API on that field', async () => {
    amcApi(ADMIN, {
      override: (request) =>
        request.method === 'POST' && request.path === '/amc/contracts'
          ? fail(400, 'VALIDATION_ERROR', 'The selected client is inactive.', [
              { field: 'clientId', message: 'An inactive client cannot be selected. Reactivate the client first.' },
            ])
          : undefined,
    })
    renderApp('/amc/contracts')
    const dialog = await openAddForm()

    await userEvent.selectOptions(within(dialog).getByLabelText(/Client/), '10')
    await userEvent.type(within(dialog).getByLabelText(/System/), 'FIRE')
    await userEvent.selectOptions(within(dialog).getByLabelText(/Maintenance frequency/), 'MONTHLY')
    await userEvent.type(within(dialog).getByLabelText(/Valid from/), '2027-01-01')
    await userEvent.type(within(dialog).getByLabelText(/Valid to/), '2027-12-31')
    await userEvent.type(within(dialog).getByLabelText(/Contract value/), '100')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add contract' }))

    expect(await within(dialog).findByText('An inactive client cannot be selected. Reactivate the client first.')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Add AMC Contract' })).toBeInTheDocument()
  })
})

describe('contract details', () => {
  it('shows the stored contract, its figures and its dated visits', async () => {
    const api = amcApi(ADMIN, {
      contracts: [makeContract({ finalCredit: '1500.000', schedule: { ...FIRE.schedule, scheduledTotal: '1215.000', valueDifference: '405.000' } })],
      visits: [
        makeVisit({ status: 'COMPLETED', completedDate: '2027-01-04', invoiceEligibility: 'READY_FOR_INVOICE' }),
        makeVisit({ id: '501', sequenceNo: 2, periodStart: '2027-04-01', periodEnd: '2027-06-30', scheduledDate: '2027-04-01', visitAmount: '0.000' }),
      ],
    })
    renderApp('/amc/contracts')

    await userEvent.click(await screen.findByRole('button', { name: 'View Test Hotel One FIRE' }))
    const dialog = await screen.findByRole('dialog', { name: 'AMC contract details' })

    expect(await within(dialog).findByText('01 Jan 2027 to 31 Dec 2027')).toBeInTheDocument()
    expect(within(dialog).getByText('1,620.000')).toBeInTheDocument()
    expect(within(dialog).getByText('1,500.000')).toBeInTheDocument()
    expect(within(dialog).getByText('1,215.000')).toBeInTheDocument()
    expect(within(dialog).getByText(/do not add up to the contract value/)).toBeInTheDocument()

    const table = await within(dialog).findByRole('table', { name: 'Visits of this contract' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    expect(within(rows[0] as HTMLElement).getByText('Completed')).toBeInTheDocument()
    expect(within(rows[0] as HTMLElement).getByText('Ready for invoice')).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('0.000')).toBeInTheDocument()
    expect(api.find('GET', '/amc/contracts/100')).toHaveLength(1)
    expect(api.find('GET', '/amc/visits')[0]?.query.get('contractId')).toBe('100')
  })
})

describe('edit contract', () => {
  it('opens with the current values and saves changes that do not affect the schedule directly', async () => {
    const api = amcApi(ADMIN, { contracts: [FIRE] })
    renderApp('/amc/contracts')

    await userEvent.click(await screen.findByRole('button', { name: 'Edit Test Hotel One FIRE' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit AMC Contract' })
    const value = await within(dialog).findByLabelText(/Contract value/)

    expect(value).toHaveValue('1620.000')
    expect(within(dialog).getByLabelText(/Client/)).toHaveValue('10')
    expect(within(dialog).getByLabelText(/Valid from/)).toHaveValue('2027-01-01')
    // The status is changed from the details view, not here.
    expect(within(dialog).queryByLabelText(/Status/)).not.toBeInTheDocument()

    await userEvent.clear(value)
    await userEvent.type(value, '1800')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('PATCH', '/amc/contracts/100')[0]?.body).toMatchObject({ contractValue: '1800', validFrom: '2027-01-01', validTo: '2027-12-31' })
    expect(api.find('PATCH', '/amc/contracts/100')[0]?.body).not.toHaveProperty('status')
    expect(api.find('GET', '/amc/contracts/100/schedule/preview')).toHaveLength(0)
    expect(await screen.findByText('1,800.000')).toBeInTheDocument()
  })

  it('asks for confirmation, showing the effect on the schedule, before changing the terms of an active contract', async () => {
    const api = amcApi(ADMIN, {
      contracts: [FIRE],
      preview: {
        validFrom: '2027-01-01',
        validTo: '2028-06-30',
        maintenanceFrequency: 'QUARTERLY',
        canApply: true,
        blockedReason: null,
        toCreate: [
          { periodStart: '2028-01-01', periodEnd: '2028-03-31', scheduledDate: '2028-01-01', visitAmount: '405.000' },
          { periodStart: '2028-04-01', periodEnd: '2028-06-30', scheduledDate: '2028-04-01', visitAmount: '405.000' },
        ],
        toRemove: [],
        keptCount: 4,
        blocking: [],
      },
    })
    renderApp('/amc/contracts')

    await userEvent.click(await screen.findByRole('button', { name: 'Edit Test Hotel One FIRE' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit AMC Contract' })
    const validTo = await within(dialog).findByLabelText(/Valid to/)
    await userEvent.clear(validTo)
    await userEvent.type(validTo, '2028-06-30')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    const confirm = await screen.findByRole('dialog', { name: 'Confirm schedule change' })
    expect(confirm).toHaveTextContent('2 visit(s) will be added: 01 Jan 2028, 01 Apr 2028')
    expect(confirm).toHaveTextContent('0 untouched visit(s) will be removed')
    expect(confirm).toHaveTextContent('4 visit(s) will be kept exactly as they are')
    // Nothing has been saved yet.
    expect(api.find('PATCH', '/amc/contracts/100')).toHaveLength(0)
    expect(api.find('GET', '/amc/contracts/100/schedule/preview')[0]?.query.get('validTo')).toBe('2028-06-30')

    await userEvent.click(within(confirm).getByRole('button', { name: 'Save and update schedule' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('PATCH', '/amc/contracts/100')[0]?.body).toMatchObject({ validTo: '2028-06-30' })
    expect(screen.getByRole('status')).toHaveTextContent('2 visit(s) added to the schedule')
  })

  it('returns to the form with the entered values when the confirmation is declined', async () => {
    const api = amcApi(ADMIN, {
      contracts: [FIRE],
      preview: {
        validFrom: '2027-01-01',
        validTo: '2027-06-30',
        maintenanceFrequency: 'QUARTERLY',
        canApply: true,
        blockedReason: null,
        toCreate: [],
        toRemove: [{ id: '503', sequenceNo: 4, periodStart: '2027-10-01', periodEnd: '2027-12-31' }],
        keptCount: 3,
        blocking: [],
      },
    })
    renderApp('/amc/contracts')

    await userEvent.click(await screen.findByRole('button', { name: 'Edit Test Hotel One FIRE' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit AMC Contract' })
    const validTo = await within(dialog).findByLabelText(/Valid to/)
    await userEvent.clear(validTo)
    await userEvent.type(validTo, '2027-06-30')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    const confirm = await screen.findByRole('dialog', { name: 'Confirm schedule change' })
    expect(confirm).toHaveTextContent('1 untouched visit(s) will be removed: 01 Oct 2027')
    await userEvent.click(within(confirm).getByRole('button', { name: 'Back' }))

    const form = await screen.findByRole('dialog', { name: 'Edit AMC Contract' })
    expect(within(form).getByLabelText(/Valid to/)).toHaveValue('2027-06-30')
    expect(api.find('PATCH', '/amc/contracts/100')).toHaveLength(0)
  })

  it('explains why terms cannot be applied, and saves nothing', async () => {
    const api = amcApi(ADMIN, {
      contracts: [FIRE],
      preview: {
        validFrom: '2027-01-01',
        validTo: '2027-06-30',
        maintenanceFrequency: 'QUARTERLY',
        canApply: false,
        blockedReason: '1 visit(s) that have been worked on, edited or rescheduled fall outside the new validity period (2027-10-01).',
        toCreate: [],
        toRemove: [],
        keptCount: 4,
        blocking: [{ id: '503', sequenceNo: 4, periodStart: '2027-10-01', periodEnd: '2027-12-31' }],
      },
    })
    renderApp('/amc/contracts')

    await userEvent.click(await screen.findByRole('button', { name: 'Edit Test Hotel One FIRE' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit AMC Contract' })
    const validTo = await within(dialog).findByLabelText(/Valid to/)
    await userEvent.clear(validTo)
    await userEvent.type(validTo, '2027-06-30')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('fall outside the new validity period (2027-10-01)')
    expect(api.find('PATCH', '/amc/contracts/100')).toHaveLength(0)
  })
})

describe('contract status', () => {
  it('activates a draft from its details', async () => {
    const api = amcApi(ADMIN, { contracts: [DRAFT] })
    renderApp('/amc/contracts')

    await userEvent.click(await screen.findByRole('button', { name: 'View Test Hotel Two CCTV' }))
    const details = await screen.findByRole('dialog', { name: 'AMC contract details' })
    expect(await within(details).findByText(/A draft has no schedule/)).toBeInTheDocument()

    await userEvent.click(within(details).getByRole('button', { name: 'Activate' }))
    const confirm = await screen.findByRole('dialog', { name: 'Activate contract' })
    expect(confirm).toHaveTextContent('The maintenance schedule is generated')
    await userEvent.click(within(confirm).getByRole('button', { name: 'Activate contract' }))

    await waitFor(() => expect(api.find('POST', '/amc/contracts/101/status')).toHaveLength(1))
    expect(api.find('POST', '/amc/contracts/101/status')[0]?.body).toEqual({ status: 'ACTIVE' })
    expect(await screen.findByRole('status')).toHaveTextContent('The contract for Test Hotel Two CCTV is now Active.')
  })

  it('cancels a contract and cancels its open visits only when that is ticked', async () => {
    const api = amcApi(ADMIN, { contracts: [FIRE] })
    renderApp('/amc/contracts')

    await userEvent.click(await screen.findByRole('button', { name: 'View Test Hotel One FIRE' }))
    const details = await screen.findByRole('dialog', { name: 'AMC contract details' })
    await userEvent.click(await within(details).findByRole('button', { name: 'Cancel contract' }))

    const confirm = await screen.findByRole('dialog', { name: 'Cancel contract' })
    expect(confirm).toHaveTextContent('This contract has 3 visit(s) that are not completed.')
    const checkbox = within(confirm).getByLabelText('Also cancel the scheduled and postponed visits of this contract')
    expect(checkbox).not.toBeChecked()

    await userEvent.click(checkbox)
    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel contract' }))

    await waitFor(() => expect(api.find('POST', '/amc/contracts/100/status')).toHaveLength(1))
    expect(api.find('POST', '/amc/contracts/100/status')[0]?.body).toEqual({ status: 'CANCELLED', cancelOpenVisits: true })
    expect(await screen.findByRole('status')).toHaveTextContent('is now Cancelled. 3 visit(s) cancelled.')
  })

  it('goes back to the details without changing anything', async () => {
    const api = amcApi(ADMIN, { contracts: [FIRE] })
    renderApp('/amc/contracts')

    await userEvent.click(await screen.findByRole('button', { name: 'View Test Hotel One FIRE' }))
    const details = await screen.findByRole('dialog', { name: 'AMC contract details' })
    await userEvent.click(await within(details).findByRole('button', { name: 'Mark as expired' }))
    const confirm = await screen.findByRole('dialog', { name: 'Mark contract as expired' })
    await userEvent.click(within(confirm).getByRole('button', { name: 'Back' }))

    expect(await screen.findByRole('dialog', { name: 'AMC contract details' })).toBeInTheDocument()
    expect(api.find('POST', '/amc/contracts/100/status')).toHaveLength(0)
  })
})

describe('contract permissions', () => {
  it('offers a view-only role no way to add, edit or change the status', async () => {
    amcApi(VIEWER, { contracts: [FIRE] })
    renderApp('/amc/contracts')

    expect(await screen.findByRole('button', { name: 'View Test Hotel One FIRE' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add Contract' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'View Test Hotel One FIRE' }))
    const details = await screen.findByRole('dialog', { name: 'AMC contract details' })
    await within(details).findByText('01 Jan 2027 to 31 Dec 2027')
    expect(within(details).getAllByRole('button').map((button) => button.textContent)).toEqual(['', 'Close'])
  })

  it('refuses the page to a role without AMC Contracts access, without requesting its data', async () => {
    const api = amcApi(ACCOUNTANT, { contracts: [FIRE] })
    renderApp('/amc/contracts')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(api.find('GET', '/amc/contracts')).toHaveLength(0)
  })

  it('shows the message from the API when a status change is refused', async () => {
    amcApi(ADMIN, {
      contracts: [FIRE],
      override: (request) =>
        request.path === '/amc/contracts/100/status' ? fail(403, 'FORBIDDEN', 'You do not have permission to perform this action.') : undefined,
    })
    renderApp('/amc/contracts')

    await userEvent.click(await screen.findByRole('button', { name: 'View Test Hotel One FIRE' }))
    const details = await screen.findByRole('dialog', { name: 'AMC contract details' })
    await userEvent.click(await within(details).findByRole('button', { name: 'Mark as expired' }))
    const confirm = await screen.findByRole('dialog', { name: 'Mark contract as expired' })
    await userEvent.click(within(confirm).getByRole('button', { name: 'Mark contract as expired' }))

    expect(await within(confirm).findByRole('alert')).toHaveTextContent('You do not have permission to perform this action.')
  })
})

import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { todayIso } from '../lib/format'
import type { SessionUser } from '../lib/types'
import { ACCOUNTANT, ADMIN, fail, renderApp } from './helpers'
import { makeExpense, makeProcurement, makeProject, projectsApi } from './projectsApi'

// Holds PROJECTS:VIEW and PROCUREMENT:VIEW but not EXPENSES:VIEW, like the seeded Execution role.
const EXECUTION: SessionUser = {
  id: '4',
  email: 'execution@example.com',
  fullName: 'Esha Execution',
  roles: [{ id: '4', code: 'EXECUTION', name: 'Execution' }],
  permissions: ['DASHBOARD:VIEW', 'CLIENTS:VIEW', 'PROJECTS:VIEW', 'PROCUREMENT:VIEW'],
}

const ONE = makeProject({ jobValue: '1234.567', budgetAmount: '900.000' })
const DONE = makeProject({ id: '101', jobNumber: 'GPSA0002', description: 'CCTV upgrade', status: 'COMPLETED', completedDate: '2026-09-20', jobValue: '2000.000' })
const ZERO = makeProject({ id: '102', jobNumber: 'GPSA0003', description: 'Rectification', status: 'COMPLETED', completedDate: '2026-09-21', jobValue: '0.000' })

const figure = (label: string) => {
  const summary = screen.getByLabelText('Financial summary')
  const term = within(summary).getByText(label, { selector: 'dt' })

  return term.parentElement as HTMLElement
}

describe('project list', () => {
  it('lists the projects returned by the API with their status and server-calculated figures', async () => {
    const api = projectsApi(ADMIN, { projects: [ONE, DONE], expenses: [makeExpense({ amount: '250.125' })] })
    renderApp('/projects')

    const table = await screen.findByRole('table', { name: 'Projects' })
    const rows = within(table).getAllByRole('row').slice(1)

    expect(rows).toHaveLength(2)
    const first = within(rows[0] as HTMLElement)
    expect(first.getByRole('link', { name: 'GPSA0001' })).toHaveAttribute('href', '/projects/100')
    expect(first.getByText('Test Client One')).toBeInTheDocument()
    expect(first.getByText('New')).toBeInTheDocument()
    // Job value, VAT, grand value, tracked expenses and margin exactly as the API returned them.
    expect(first.getByText('1,234.567')).toBeInTheDocument()
    expect(first.getByText('61.728')).toBeInTheDocument()
    expect(first.getByText('1,296.295')).toBeInTheDocument()
    expect(first.getByText('250.125')).toBeInTheDocument()
    expect(first.getByText('984.442')).toBeInTheDocument()

    const second = within(rows[1] as HTMLElement)
    expect(second.getByText('Completed')).toBeInTheDocument()
    expect(second.getByText('Ready for invoice')).toBeInTheDocument()
    expect(screen.getByText('Showing 1–2 of 2')).toBeInTheDocument()
    // No status filter is sent by default: every project is listed.
    expect(api.find('GET', '/projects')[0]?.query.get('status')).toBeNull()
  })

  it('shows a loading state, then an empty state when there are no projects', async () => {
    projectsApi(ADMIN)
    renderApp('/projects')

    expect(await screen.findByText(/Loading projects/)).toBeInTheDocument()
    expect(await screen.findByText('No projects yet')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('searches and filters through the API', async () => {
    const api = projectsApi(ADMIN, { projects: [ONE, DONE, ZERO] })
    renderApp('/projects')
    await screen.findByRole('table', { name: 'Projects' })

    await userEvent.type(screen.getByLabelText('Search'), 'cctv')
    await waitFor(() => expect(screen.queryByRole('link', { name: 'GPSA0001' })).not.toBeInTheDocument())
    expect(screen.getByRole('link', { name: 'GPSA0002' })).toBeInTheDocument()
    expect(api.find('GET', '/projects').at(-1)?.query.get('search')).toBe('cctv')

    await userEvent.clear(screen.getByLabelText('Search'))
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'COMPLETED')
    await waitFor(() => expect(api.find('GET', '/projects').at(-1)?.query.get('status')).toBe('COMPLETED'))

    await userEvent.selectOptions(screen.getByLabelText('Invoicing'), 'READY_FOR_INVOICE')
    await waitFor(() => expect(screen.queryByRole('link', { name: 'GPSA0003' })).not.toBeInTheDocument())
    expect(screen.getByRole('link', { name: 'GPSA0002' })).toBeInTheDocument()
    expect(api.find('GET', '/projects').at(-1)?.query.get('invoiceState')).toBe('READY_FOR_INVOICE')
  })

  it('marks a completed zero-value project as needing no invoice', async () => {
    projectsApi(ADMIN, { projects: [ZERO] })
    renderApp('/projects')

    const table = await screen.findByRole('table', { name: 'Projects' })
    expect(within(table).getByText('No invoice required')).toBeInTheDocument()
    expect(within(table).queryByText('Ready for invoice')).not.toBeInTheDocument()
  })

  it('shows an error with a retry when the list cannot be loaded', async () => {
    let failing = true
    projectsApi(ADMIN, { projects: [ONE] }, (request) =>
      failing && request.path === '/projects' ? fail(500, 'INTERNAL_ERROR', 'An unexpected error occurred.') : undefined,
    )
    renderApp('/projects')

    expect(await screen.findByRole('alert')).toHaveTextContent('An unexpected error occurred.')

    failing = false
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByRole('link', { name: 'GPSA0001' })).toBeInTheDocument()
  })

  it('does not show cost columns to a role that may not view expenses', async () => {
    projectsApi(EXECUTION, { projects: [ONE] })
    renderApp('/projects')

    const table = await screen.findByRole('table', { name: 'Projects' })
    expect(within(table).getByRole('columnheader', { name: 'Job value' })).toBeInTheDocument()
    expect(within(table).queryByRole('columnheader', { name: 'Tracked expenses' })).not.toBeInTheDocument()
    expect(within(table).queryByRole('columnheader', { name: 'Operational job margin' })).not.toBeInTheDocument()
  })
})

describe('create project', () => {
  it('validates the form before calling the API', async () => {
    const api = projectsApi(ADMIN)
    renderApp('/projects')

    await userEvent.click(await screen.findByRole('button', { name: 'New Project' }))
    const dialog = await screen.findByRole('dialog', { name: 'New Project' })

    await userEvent.type(await within(dialog).findByLabelText(/^Job value/), '12.3456')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create project' }))

    expect(await within(dialog).findByText('Select a client.')).toBeInTheDocument()
    expect(within(dialog).getByText('Job description is required.')).toBeInTheDocument()
    expect(within(dialog).getByText('Enter a number with at most 3 decimal places, for example 1250.500.')).toBeInTheDocument()
    expect(within(dialog).getByLabelText(/^Client/)).toHaveAttribute('aria-invalid', 'true')
    expect(api.find('POST', '/projects')).toHaveLength(0)
  })

  it('shows the job number that will be assigned and the default VAT rate from the API', async () => {
    projectsApi(ADMIN, { projects: [ONE] })
    renderApp('/projects')

    await userEvent.click(await screen.findByRole('button', { name: 'New Project' }))
    const dialog = await screen.findByRole('dialog', { name: 'New Project' })

    expect(await within(dialog).findByText('GPSA0002')).toBeInTheDocument()
    expect(within(dialog).getByLabelText(/^VAT rate/)).toHaveValue('5.000')
    expect(within(dialog).getByLabelText(/^Job date/)).toHaveValue(todayIso())
  })

  it('previews VAT and grand value to three decimals while typing', async () => {
    projectsApi(ADMIN)
    renderApp('/projects')

    await userEvent.click(await screen.findByRole('button', { name: 'New Project' }))
    const dialog = await screen.findByRole('dialog', { name: 'New Project' })

    await userEvent.type(await within(dialog).findByLabelText(/^Job value/), '1234.567')

    expect(within(dialog).getByTestId('vat-preview')).toHaveTextContent('61.728')
    expect(within(dialog).getByTestId('grand-preview')).toHaveTextContent('1,296.295')

    const rate = within(dialog).getByLabelText(/^VAT rate/)
    await userEvent.clear(rate)
    await userEvent.type(rate, '0')

    expect(within(dialog).getByTestId('vat-preview')).toHaveTextContent('0.000')
    expect(within(dialog).getByTestId('grand-preview')).toHaveTextContent('1,234.567')
  })

  it('saves a new project with money as text and shows it in the list', async () => {
    const api = projectsApi(ADMIN)
    renderApp('/projects')

    await userEvent.click(await screen.findByRole('button', { name: 'New Project' }))
    const dialog = await screen.findByRole('dialog', { name: 'New Project' })

    await userEvent.selectOptions(await within(dialog).findByLabelText(/^Client/), '10')
    await userEvent.type(within(dialog).getByLabelText(/^Job description/), '  Access control upgrade ')
    await userEvent.type(within(dialog).getByLabelText('LPO number'), 'LPO-77')
    await userEvent.type(within(dialog).getByLabelText(/^Job value/), '1234.567')
    await userEvent.type(within(dialog).getByLabelText('Budget'), '900')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create project' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('POST', '/projects')[0]?.body).toEqual({
      clientId: '10',
      description: 'Access control upgrade',
      jobDate: todayIso(),
      lpoNumber: 'LPO-77',
      lpoDate: '',
      jobValue: '1234.567',
      vatRate: '5.000',
      budgetAmount: '900',
      notes: '',
    })
    expect(screen.getByRole('status')).toHaveTextContent('Project GPSA0001 was created.')

    // The list is read again from the API, showing the figures the server calculated.
    const table = await screen.findByRole('table', { name: 'Projects' })
    expect(within(table).getByRole('link', { name: 'GPSA0001' })).toBeInTheDocument()
    expect(within(table).getByText('1,296.295')).toBeInTheDocument()
  })

  it('shows a field error from the API on the field', async () => {
    projectsApi(ADMIN, {}, (request) =>
      request.method === 'POST' && request.path === '/projects'
        ? fail(400, 'VALIDATION_ERROR', 'Some fields are invalid.', [
            { field: 'clientId', message: 'The selected client is inactive. Reactivate it or choose another client.' },
          ])
        : undefined,
    )
    renderApp('/projects')

    await userEvent.click(await screen.findByRole('button', { name: 'New Project' }))
    const dialog = await screen.findByRole('dialog', { name: 'New Project' })
    await userEvent.selectOptions(await within(dialog).findByLabelText(/^Client/), '10')
    await userEvent.type(within(dialog).getByLabelText(/^Job description/), 'Job')
    await userEvent.type(within(dialog).getByLabelText(/^Job value/), '10')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create project' }))

    expect(await within(dialog).findByText(/The selected client is inactive/)).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'New Project' })).toBeInTheDocument()
  })
})

describe('edit project', () => {
  it('opens with the stored values, saves the changes and shows the updated figures', async () => {
    const api = projectsApi(ADMIN, { projects: [ONE] })
    renderApp('/projects')

    await userEvent.click(await screen.findByRole('button', { name: 'Edit GPSA0001' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit Project GPSA0001' })
    const value = await within(dialog).findByLabelText(/^Job value/)

    expect(value).toHaveValue('1234.567')
    expect(within(dialog).getByLabelText(/^Client/)).toHaveValue('10')
    expect(within(dialog).getByLabelText('Budget')).toHaveValue('900.000')

    await userEvent.clear(value)
    await userEvent.type(value, '2000')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('PATCH', '/projects/100')[0]?.body).toMatchObject({ jobValue: '2000', vatRate: '5.000', description: 'Fire alarm panel replacement' })
    expect(await screen.findByText('2,100.000')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Project GPSA0001 was updated.')
  })
})

describe('project page', () => {
  it('shows the stored details and the financial summary returned by the API', async () => {
    const api = projectsApi(ADMIN, {
      projects: [makeProject({ jobValue: '1234.567', budgetAmount: '900.000', lpoNumber: 'LPO-77' })],
      expenses: [makeExpense({ amount: '250.125' }), makeExpense({ id: '301', amount: '99.875', description: 'Site labour' })],
      procurement: [makeProcurement()],
    })
    renderApp('/projects/100')

    expect(await screen.findByRole('heading', { name: 'Project GPSA0001' })).toBeInTheDocument()
    expect(screen.getByText('LPO-77')).toBeInTheDocument()

    expect(figure('Job value')).toHaveTextContent('1,234.567')
    expect(figure('Job value')).toHaveTextContent('Excluding VAT')
    expect(figure('VAT amount')).toHaveTextContent('61.728')
    expect(figure('VAT amount')).toHaveTextContent('VAT rate 5%')
    expect(figure('Grand job value')).toHaveTextContent('1,296.295')
    expect(figure('Tracked expenses')).toHaveTextContent('350.000')
    expect(figure('Operational job margin')).toHaveTextContent('884.567')
    expect(figure('Budget remaining')).toHaveTextContent('550.000')
    expect(screen.getByText(/It is not accounting profit/)).toBeInTheDocument()
    expect(screen.queryByText(/profit/i, { selector: 'dt' })).not.toBeInTheDocument()

    // Procurement and expenses of this project, read from their own endpoints.
    const procurement = await screen.findByRole('table', { name: 'Procurement requests' })
    expect(within(procurement).getByText('Smoke detectors')).toBeInTheDocument()
    const expenses = await screen.findByRole('table', { name: 'Project expenses' })
    expect(within(expenses).getByText('Site labour')).toBeInTheDocument()
    expect(screen.getByText(/Total tracked expenses:/)).toHaveTextContent('350.000')
    expect(api.find('GET', '/procurement')[0]?.query.get('projectId')).toBe('100')
    expect(api.find('GET', '/expenses')[0]?.query.get('projectId')).toBe('100')
  })

  it('shows a negative margin when costs exceed the job value', async () => {
    projectsApi(ADMIN, { projects: [makeProject({ jobValue: '100.000' })], expenses: [makeExpense({ amount: '300.500' })] })
    renderApp('/projects/100')

    await screen.findByRole('heading', { name: 'Project GPSA0001' })
    expect(figure('Operational job margin')).toHaveTextContent('−200.500')
  })

  it('completes a project with a completion date and then shows it as ready for invoice', async () => {
    const api = projectsApi(ADMIN, { projects: [makeProject({ status: 'IN_PROGRESS' })] })
    renderApp('/projects/100')

    await userEvent.click(await screen.findByRole('button', { name: 'Mark completed' }))
    const dialog = await screen.findByRole('dialog', { name: 'Mark completed' })

    expect(dialog).toHaveTextContent('The project will be listed as ready for invoice.')
    fireEvent.change(within(dialog).getByLabelText(/^Completion date/), { target: { value: '2026-10-05' } })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark completed' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('POST', '/projects/100/status')[0]?.body).toEqual({ status: 'COMPLETED', completedDate: '2026-10-05' })
    expect(await screen.findByText('Ready for invoice.')).toBeInTheDocument()
    expect(screen.getByText('Project GPSA0001 is now completed.')).toBeInTheDocument()
    expect(screen.getByText('5 Oct 2026')).toBeInTheDocument()
    // A completed project can only be reopened.
    expect(screen.getByRole('button', { name: 'Reopen project' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mark completed' })).not.toBeInTheDocument()
    // No invoice is created anywhere.
    expect(api.requests.some((request) => request.path.startsWith('/invoices'))).toBe(false)
  })

  it('completes a zero-value project without leaving it waiting for an invoice', async () => {
    projectsApi(ADMIN, { projects: [makeProject({ jobValue: '0.000' })] })
    renderApp('/projects/100')

    await userEvent.click(await screen.findByRole('button', { name: 'Mark completed' }))
    const dialog = await screen.findByRole('dialog', { name: 'Mark completed' })
    expect(dialog).toHaveTextContent('it will be marked as needing no invoice')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark completed' }))

    expect(await screen.findByText('No invoice required.')).toBeInTheDocument()
    expect(screen.queryByText('Ready for invoice.')).not.toBeInTheDocument()
  })

  it('shows the message from the API when a status change is refused', async () => {
    projectsApi(ADMIN, { projects: [makeProject({ jobDate: '2026-09-10' })] }, (request) =>
      request.path === '/projects/100/status'
        ? fail(400, 'VALIDATION_ERROR', 'Some fields are invalid.', [
            { field: 'completedDate', message: 'Completion date cannot be before the job date.' },
          ])
        : undefined,
    )
    renderApp('/projects/100')

    await userEvent.click(await screen.findByRole('button', { name: 'Mark completed' }))
    const dialog = await screen.findByRole('dialog', { name: 'Mark completed' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark completed' }))

    expect(await within(dialog).findByText('Completion date cannot be before the job date.')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Mark completed' })).toBeInTheDocument()
  })

  it('cancels a project after confirmation, after which nothing new can be added', async () => {
    const api = projectsApi(ADMIN, { projects: [ONE] })
    renderApp('/projects/100')

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel project' }))
    const dialog = await screen.findByRole('dialog', { name: 'Cancel project' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel project' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('POST', '/projects/100/status')[0]?.body).toEqual({ status: 'CANCELLED' })
    expect(await screen.findByText('Cancelled')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Record expense' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add procurement request' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reopen project' })).toBeInTheDocument()
  })

  it('records an expense against the project and reads the totals again from the API', async () => {
    const api = projectsApi(ADMIN, { projects: [makeProject({ jobValue: '1000.000' })] })
    renderApp('/projects/100')

    await userEvent.click(await screen.findByRole('button', { name: 'Record expense' }))
    const dialog = await screen.findByRole('dialog', { name: 'Record Expense' })

    // Opened from the project, so the project is already decided.
    expect(await within(dialog).findByText(/GPSA0001 — Test Client One/)).toBeInTheDocument()
    expect(within(dialog).queryByLabelText(/^Project \/ job/)).not.toBeInTheDocument()

    await userEvent.selectOptions(within(dialog).getByLabelText(/^Category/), '2')
    await userEvent.type(within(dialog).getByLabelText(/^Description/), 'Site labour')
    await userEvent.type(within(dialog).getByLabelText(/^Amount/), '120.5')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record expense' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('POST', '/expenses')[0]?.body).toMatchObject({ projectId: '100', categoryId: '2', description: 'Site labour', amount: '120.5' })
    await waitFor(() => expect(figure('Tracked expenses')).toHaveTextContent('120.500'))
    expect(figure('Operational job margin')).toHaveTextContent('879.500')
  })

  it('adds a procurement request against the project', async () => {
    const api = projectsApi(ADMIN, { projects: [ONE] })
    renderApp('/projects/100')

    await userEvent.click(await screen.findByRole('button', { name: 'Add procurement request' }))
    const dialog = await screen.findByRole('dialog', { name: 'New Procurement Request' })
    await userEvent.type(within(dialog).getByLabelText(/^Requirement/), 'Control modules')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add request' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('POST', '/procurement')[0]?.body).toMatchObject({ projectId: '100', description: 'Control modules' })
    const table = await screen.findByRole('table', { name: 'Procurement requests' })
    expect(within(table).getByText('Control modules')).toBeInTheDocument()
  })

  it('shows a not-found message for a project that does not exist', async () => {
    projectsApi(ADMIN)
    renderApp('/projects/555')

    expect(await screen.findByText('Project not found')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '← All projects' })).toHaveAttribute('href', '/projects')
  })
})

describe('project permissions', () => {
  it('offers a view-only role no way to create, edit or change status', async () => {
    projectsApi(ACCOUNTANT, { projects: [ONE] })
    renderApp('/projects')

    expect(await screen.findByRole('link', { name: 'GPSA0001' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New Project' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument()
  })

  it('hides status actions, costs and the expense list from a role without those permissions', async () => {
    const api = projectsApi(EXECUTION, { projects: [ONE], expenses: [makeExpense()], procurement: [makeProcurement()] })
    renderApp('/projects/100')

    await screen.findByRole('heading', { name: 'Project GPSA0001' })
    expect(figure('Job value')).toHaveTextContent('1,234.567')
    expect(within(screen.getByLabelText('Financial summary')).queryByText('Tracked expenses')).not.toBeInTheDocument()
    expect(within(screen.getByLabelText('Financial summary')).queryByText('Operational job margin')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mark completed' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()

    // Procurement may be viewed but not changed; expenses are not even requested.
    const procurement = await screen.findByRole('table', { name: 'Procurement requests' })
    expect(within(procurement).queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add procurement request' })).not.toBeInTheDocument()
    expect(screen.queryByRole('table', { name: 'Project expenses' })).not.toBeInTheDocument()
    expect(api.find('GET', '/expenses')).toHaveLength(0)
  })

  it('refuses the page to a role that may not view projects, without requesting its data', async () => {
    const api = projectsApi({ ...EXECUTION, permissions: ['DASHBOARD:VIEW'] }, { projects: [ONE] })
    renderApp('/projects')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(api.find('GET', '/projects')).toHaveLength(0)
  })
})

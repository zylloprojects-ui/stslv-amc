import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { todayIso } from '../lib/format'
import type { SessionUser } from '../lib/types'
import { ACCOUNTANT, ADMIN, fail, renderApp } from './helpers'
import { makeExpense, makeProject, projectsApi } from './projectsApi'

// Like the seeded Accountant: may record and edit expenses, but not void them.
const BOOKKEEPER: SessionUser = { ...ACCOUNTANT, permissions: [...ACCOUNTANT.permissions, 'EXPENSES:EDIT'] }
const VIEWER: SessionUser = { ...ACCOUNTANT, permissions: ['DASHBOARD:VIEW', 'PROJECTS:VIEW', 'EXPENSES:VIEW'] }

const JOB_ONE = makeProject()
const JOB_TWO = makeProject({ id: '101', jobNumber: 'GPSA0002', description: 'CCTV upgrade' })
const CABLE = makeExpense()
const LABOUR = makeExpense({
  id: '301',
  projectId: '101',
  jobNumber: 'GPSA0002',
  projectDescription: 'CCTV upgrade',
  categoryId: '2',
  categoryCode: 'LABOUR',
  categoryName: 'Labour',
  expenseDate: '2026-09-20',
  description: 'Site labour',
  payeeName: null,
  paymentReference: null,
  amount: '99.875',
})
const VOIDED = makeExpense({ id: '302', description: 'Entered twice', amount: '40.000', isVoided: true, voidedAt: '2026-09-11T08:00:00.000Z', voidReason: 'Duplicate' })

const total = () => screen.getByTestId('expenses-total')

describe('expense list', () => {
  it('lists the expenses returned by the API with the total the API calculated', async () => {
    const api = projectsApi(ADMIN, { projects: [JOB_ONE, JOB_TWO], expenses: [CABLE, LABOUR, VOIDED] })
    renderApp('/expenses')

    const table = await screen.findByRole('table', { name: 'Project expenses' })
    const rows = within(table).getAllByRole('row').slice(1)

    // The voided expense is not listed unless asked for.
    expect(rows).toHaveLength(2)
    const first = within(rows[0] as HTMLElement)
    expect(first.getByRole('link', { name: 'GPSA0001' })).toHaveAttribute('href', '/projects/100')
    expect(first.getByText('Materials')).toBeInTheDocument()
    expect(first.getByText('Cable and conduit')).toBeInTheDocument()
    expect(first.getByText('Test Supplier')).toBeInTheDocument()
    expect(first.getByText('TRF-1')).toBeInTheDocument()
    expect(first.getByText('250.125')).toBeInTheDocument()

    expect(total()).toHaveTextContent('350.000')
    expect(screen.getByText(/Total tracked expenses/)).toBeInTheDocument()
    expect(api.find('GET', '/expenses')[0]?.query.get('includeVoided')).toBeNull()
  })

  it('shows an empty state when there are no expenses', async () => {
    projectsApi(ADMIN, { projects: [JOB_ONE] })
    renderApp('/expenses')

    expect(await screen.findByText('No expenses yet')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('filters by project, category and date through the API, and the total follows', async () => {
    const api = projectsApi(ADMIN, { projects: [JOB_ONE, JOB_TWO], expenses: [CABLE, LABOUR] })
    renderApp('/expenses')
    await screen.findByRole('table', { name: 'Project expenses' })

    await userEvent.selectOptions(await screen.findByLabelText('Project'), '101')
    await waitFor(() => expect(screen.queryByText('Cable and conduit')).not.toBeInTheDocument())
    expect(total()).toHaveTextContent('99.875')
    expect(screen.getByText(/Total of matching expenses/)).toBeInTheDocument()
    expect(api.find('GET', '/expenses').at(-1)?.query.get('projectId')).toBe('101')

    await userEvent.selectOptions(screen.getByLabelText('Project'), '')
    await userEvent.selectOptions(await screen.findByLabelText('Category'), '1')
    await waitFor(() => expect(screen.queryByText('Site labour')).not.toBeInTheDocument())
    expect(total()).toHaveTextContent('250.125')
    expect(api.find('GET', '/expenses').at(-1)?.query.get('categoryId')).toBe('1')

    await userEvent.selectOptions(screen.getByLabelText('Category'), '')
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-15' } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-09-30' } })
    await waitFor(() => expect(screen.queryByText('Cable and conduit')).not.toBeInTheDocument())
    expect(screen.getByText('Site labour')).toBeInTheDocument()
    const last = api.find('GET', '/expenses').at(-1)?.query
    expect(last?.get('dateFrom')).toBe('2026-09-15')
    expect(last?.get('dateTo')).toBe('2026-09-30')
  })

  it('opens already filtered to a project when linked from that project', async () => {
    const api = projectsApi(ADMIN, { projects: [JOB_ONE, JOB_TWO], expenses: [CABLE, LABOUR] })
    renderApp('/expenses?projectId=100')

    expect(await screen.findByText('Cable and conduit')).toBeInTheDocument()
    expect(screen.queryByText('Site labour')).not.toBeInTheDocument()
    expect(total()).toHaveTextContent('250.125')
    expect(api.find('GET', '/expenses')[0]?.query.get('projectId')).toBe('100')
  })

  it('shows voided expenses on request, marked and left out of the total', async () => {
    const api = projectsApi(ADMIN, { projects: [JOB_ONE], expenses: [CABLE, VOIDED] })
    renderApp('/expenses')
    await screen.findByRole('table', { name: 'Project expenses' })

    await userEvent.click(screen.getByLabelText('Show voided'))

    expect(await screen.findByText('Entered twice')).toBeInTheDocument()
    expect(screen.getByText('Voided')).toBeInTheDocument()
    expect(screen.getByText('Duplicate')).toBeInTheDocument()
    expect(total()).toHaveTextContent('250.125')
    expect(api.find('GET', '/expenses').at(-1)?.query.get('includeVoided')).toBe('true')
    // A voided expense can be viewed but not edited or voided again.
    expect(screen.queryByRole('button', { name: 'Edit expense Entered twice' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Void expense Entered twice' })).not.toBeInTheDocument()
  })

  it('shows the stored details of an expense', async () => {
    const api = projectsApi(ADMIN, { projects: [JOB_ONE], expenses: [makeExpense({ notes: 'Paid by transfer' })] })
    renderApp('/expenses')

    await userEvent.click(await screen.findByRole('button', { name: 'View expense Cable and conduit' }))

    const dialog = await screen.findByRole('dialog', { name: 'Expense details' })
    expect(await within(dialog).findByText('Paid by transfer')).toBeInTheDocument()
    expect(within(dialog).getByText('250.125')).toBeInTheDocument()
    expect(within(dialog).getByText(/GPSA0001 — Test Client One/)).toBeInTheDocument()
    expect(api.find('GET', '/expenses/300')).toHaveLength(1)
  })
})

describe('record expense', () => {
  it('validates the form before calling the API', async () => {
    const api = projectsApi(ADMIN, { projects: [JOB_ONE] })
    renderApp('/expenses')

    await userEvent.click(await screen.findByRole('button', { name: 'Record Expense' }))
    const dialog = await screen.findByRole('dialog', { name: 'Record Expense' })

    await userEvent.type(await within(dialog).findByLabelText(/^Amount/), '0')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record expense' }))

    expect(await within(dialog).findByText('Select a project.')).toBeInTheDocument()
    expect(within(dialog).getByText('Select a category.')).toBeInTheDocument()
    expect(within(dialog).getByText('Description is required.')).toBeInTheDocument()
    expect(within(dialog).getByText('Amount must be greater than zero.')).toBeInTheDocument()

    const amount = within(dialog).getByLabelText(/^Amount/)
    await userEvent.clear(amount)
    await userEvent.type(amount, '1.0005')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record expense' }))

    expect(await within(dialog).findByText('Enter a number with at most 3 decimal places, for example 1250.500.')).toBeInTheDocument()
    expect(api.find('POST', '/expenses')).toHaveLength(0)
  })

  it('records an expense against the chosen project with the amount as text', async () => {
    const api = projectsApi(ADMIN, { projects: [JOB_ONE, JOB_TWO], expenses: [CABLE] })
    renderApp('/expenses')

    await userEvent.click(await screen.findByRole('button', { name: 'Record Expense' }))
    const dialog = await screen.findByRole('dialog', { name: 'Record Expense' })

    await userEvent.selectOptions(await within(dialog).findByLabelText(/^Project \/ job/), '101')
    await userEvent.selectOptions(within(dialog).getByLabelText(/^Category/), '2')
    await userEvent.type(within(dialog).getByLabelText(/^Description/), 'Site labour')
    await userEvent.type(within(dialog).getByLabelText('Supplier / payee'), 'Site crew')
    await userEvent.type(within(dialog).getByLabelText(/^Amount/), '1234.567')
    await userEvent.type(within(dialog).getByLabelText('Payment reference'), 'CHQ-5')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record expense' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('POST', '/expenses')[0]?.body).toEqual({
      projectId: '101',
      categoryId: '2',
      expenseDate: todayIso(),
      description: 'Site labour',
      payeeName: 'Site crew',
      amount: '1234.567',
      paymentReference: 'CHQ-5',
      notes: '',
    })
    expect(screen.getByRole('status')).toHaveTextContent('Expense of 1,234.567 recorded against GPSA0002.')

    // The list and its total are read again from the API.
    const table = await screen.findByRole('table', { name: 'Project expenses' })
    expect(await within(table).findByText('Site labour')).toBeInTheDocument()
    await waitFor(() => expect(total()).toHaveTextContent('1,484.692'))
  })

  it('shows a field error from the API on the field', async () => {
    projectsApi(ADMIN, { projects: [JOB_ONE] }, (request) =>
      request.method === 'POST' && request.path === '/expenses'
        ? fail(400, 'VALIDATION_ERROR', 'Some fields are invalid.', [{ field: 'categoryId', message: 'The selected category is no longer in use.' }])
        : undefined,
    )
    renderApp('/expenses')

    await userEvent.click(await screen.findByRole('button', { name: 'Record Expense' }))
    const dialog = await screen.findByRole('dialog', { name: 'Record Expense' })
    await userEvent.selectOptions(await within(dialog).findByLabelText(/^Project \/ job/), '100')
    await userEvent.selectOptions(within(dialog).getByLabelText(/^Category/), '1')
    await userEvent.type(within(dialog).getByLabelText(/^Description/), 'Item')
    await userEvent.type(within(dialog).getByLabelText(/^Amount/), '5')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record expense' }))

    expect(await within(dialog).findByText('The selected category is no longer in use.')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Record Expense' })).toBeInTheDocument()
  })
})

describe('edit expense', () => {
  it('opens with the stored values, saves the changes and can move the expense to another job', async () => {
    const api = projectsApi(ADMIN, { projects: [JOB_ONE, JOB_TWO], expenses: [CABLE] })
    renderApp('/expenses')

    await userEvent.click(await screen.findByRole('button', { name: 'Edit expense Cable and conduit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit Expense' })
    const amount = await within(dialog).findByLabelText(/^Amount/)

    expect(amount).toHaveValue('250.125')
    expect(within(dialog).getByLabelText(/^Project \/ job/)).toHaveValue('100')
    expect(within(dialog).getByLabelText(/^Category/)).toHaveValue('1')

    await userEvent.clear(amount)
    await userEvent.type(amount, '133.333')
    await userEvent.selectOptions(within(dialog).getByLabelText(/^Project \/ job/), '101')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('PATCH', '/expenses/300')[0]?.body).toMatchObject({ projectId: '101', amount: '133.333', categoryId: '1' })
    expect(await screen.findByRole('link', { name: 'GPSA0002' })).toBeInTheDocument()
    await waitFor(() => expect(total()).toHaveTextContent('133.333'))
  })
})

describe('void expense', () => {
  it('requires a reason, then voids the expense and removes it from the list and the total', async () => {
    const api = projectsApi(ADMIN, { projects: [JOB_ONE, JOB_TWO], expenses: [CABLE, LABOUR] })
    renderApp('/expenses')

    await userEvent.click(await screen.findByRole('button', { name: 'Void expense Cable and conduit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Void expense' })

    expect(dialog).toHaveTextContent('250.125')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Void expense' }))
    expect(await within(dialog).findByText('Reason is required.')).toBeInTheDocument()
    expect(api.find('POST', '/expenses/300/void')).toHaveLength(0)

    await userEvent.type(within(dialog).getByLabelText(/^Reason/), 'Entered against the wrong job')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Void expense' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('POST', '/expenses/300/void')[0]?.body).toEqual({ reason: 'Entered against the wrong job' })
    await waitFor(() => expect(screen.queryByText('Cable and conduit')).not.toBeInTheDocument())
    expect(total()).toHaveTextContent('99.875')
    expect(screen.getByRole('status')).toHaveTextContent('Expense of 250.125 on GPSA0001 was voided.')
  })

  it('does nothing when cancelled', async () => {
    const api = projectsApi(ADMIN, { projects: [JOB_ONE], expenses: [CABLE] })
    renderApp('/expenses')

    await userEvent.click(await screen.findByRole('button', { name: 'Void expense Cable and conduit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Void expense' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(api.find('POST', '/expenses/300/void')).toHaveLength(0)
    expect(screen.getByText('Cable and conduit')).toBeInTheDocument()
  })
})

describe('expense permissions', () => {
  it('lets a role that records and edits expenses do so, without offering Void', async () => {
    projectsApi(BOOKKEEPER, { projects: [JOB_ONE], expenses: [CABLE] })
    renderApp('/expenses')

    expect(await screen.findByRole('button', { name: 'Edit expense Cable and conduit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Record Expense' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Void expense/ })).not.toBeInTheDocument()
  })

  it('offers a view-only role no way to record, edit or void', async () => {
    projectsApi(VIEWER, { projects: [JOB_ONE], expenses: [CABLE] })
    renderApp('/expenses')

    expect(await screen.findByRole('button', { name: 'View expense Cable and conduit' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Record Expense' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Edit expense/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Void expense/ })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'View expense Cable and conduit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Expense details' })
    await within(dialog).findByText('TRF-1')
    expect(within(dialog).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
  })

  it('refuses the page to a role that may not view expenses, without requesting its data', async () => {
    const api = projectsApi({ ...VIEWER, permissions: ['DASHBOARD:VIEW', 'PROJECTS:VIEW'] }, { projects: [JOB_ONE], expenses: [CABLE] })
    renderApp('/expenses')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(api.find('GET', '/expenses')).toHaveLength(0)
  })

  it('shows the message from the API when voiding is refused', async () => {
    projectsApi(ADMIN, { projects: [JOB_ONE], expenses: [CABLE] }, (request) =>
      request.path === '/expenses/300/void' ? fail(403, 'FORBIDDEN', 'You do not have permission to perform this action.') : undefined,
    )
    renderApp('/expenses')

    await userEvent.click(await screen.findByRole('button', { name: 'Void expense Cable and conduit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Void expense' })
    await userEvent.type(within(dialog).getByLabelText(/^Reason/), 'Mistake')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Void expense' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('You do not have permission to perform this action.')
    expect(screen.getByText('Cable and conduit')).toBeInTheDocument()
  })
})

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { Client, SessionUser } from '../lib/types'
import { withoutHidden } from '../lib/visibility'
import { amcApi, makeContract } from './amc-helpers'
import { ADMIN, makeClient, mockApi, ok, renderApp, signIn } from './helpers'

// Page visibility, step B (owner rule "Lock it", 2026-11-21): on pages whose edit form saves every field back, a field
// hidden from the role is left out of the table, shown locked in the form ("Hidden for your role") and never sent.
// The API blanks it and keeps the stored value on every save (stslv-api/tests/role-visibility-forms.test.ts).

describe('AMC Contracts', () => {
  it('leaves out a hidden Cost per Visit in the table, and locks hidden fields in the edit form without sending them', async () => {
    const user: SessionUser = { ...ADMIN, hidden: ['amcContracts.column.costPerVisit', 'amcContracts.column.notes'] }
    // As the API answers this role: the hidden values blanked.
    const contract = makeContract({ defaultVisitAmount: null, notes: null, description: 'Visible description' })
    const api = amcApi(user, { contracts: [contract] })
    renderApp('/amc/contracts')

    const table = await screen.findByRole('table', { name: 'AMC contracts' })
    expect(within(table).getByText('1,620.000')).toBeInTheDocument()
    expect(within(table).queryByText(/per visit/)).not.toBeInTheDocument()

    await userEvent.click(await screen.findByRole('button', { name: 'Edit Test Hotel One FIRE' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit AMC Contract' })
    const value = await within(dialog).findByLabelText(/AMC Value \/ Year/)

    const costPerVisit = within(dialog).getByLabelText('Default visit amount')
    expect(costPerVisit).toHaveValue('Hidden for your role')
    expect(costPerVisit).toBeDisabled()
    expect(within(dialog).getByLabelText('Notes')).toHaveValue('Hidden for your role')
    // A visible field stays editable.
    expect(within(dialog).getByLabelText('Description')).toHaveValue('Visible description')

    await userEvent.clear(value)
    await userEvent.type(value, '1800')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(api.find('PATCH', '/amc/contracts/100')).toHaveLength(1))
    const body = api.find('PATCH', '/amc/contracts/100')[0]?.body
    expect(body).toMatchObject({ contractValue: '1800', description: 'Visible description' })
    expect(body).not.toHaveProperty('defaultVisitAmount')
    expect(body).not.toHaveProperty('notes')
  })

  it('shows every field as before when nothing is hidden', async () => {
    amcApi(ADMIN, { contracts: [makeContract({ notes: 'Stored notes' })] })
    renderApp('/amc/contracts')

    const table = await screen.findByRole('table', { name: 'AMC contracts' })
    expect(within(table).getByText('405.000 per visit')).toBeInTheDocument()
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Test Hotel One FIRE' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit AMC Contract' })
    expect(await within(dialog).findByLabelText('Default visit amount')).toHaveValue('405.000')
    expect(within(dialog).getByLabelText('Notes')).toHaveValue('Stored notes')
  })
})

function clientsApi(user: SessionUser, clients: Client[]) {
  signIn()
  return mockApi((request) => {
    if (request.path === '/auth/me') return ok({ user })
    if (request.method === 'GET' && request.path === '/clients/features') return ok({ clientDetails: true })
    if (request.method === 'GET' && request.path === '/clients') return ok({ items: clients, total: clients.length, page: 1, pageSize: 25 })
    if (request.method === 'PATCH' && request.path === '/clients/10') return ok({ ...clients[0], ...(request.body as Partial<Client>) })
    return undefined
  })
}

describe('Clients', () => {
  it('drops a hidden column, locks the hidden fields in the edit form and never sends them', async () => {
    const user: SessionUser = { ...ADMIN, hidden: ['clients.column.phone', 'clients.column.email', 'clients.column.notes'] }
    const api = clientsApi(user, [makeClient({ phone: null, email: null, notes: null, clientType: 'COMPANY', vatNumber: 'OM1' })])
    renderApp('/clients')

    const table = await screen.findByRole('table')
    expect(within(table).queryByRole('columnheader', { name: 'Phone' })).not.toBeInTheDocument()
    // Contact still shows the contact person, which is not hidden.
    expect(within(table).getByRole('columnheader', { name: /Contact/ })).toBeInTheDocument()

    await userEvent.click(await screen.findByRole('button', { name: 'Edit Test Client One' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit Client' })
    expect(within(dialog).getByLabelText('Phone')).toHaveValue('Hidden for your role')
    expect(within(dialog).getByLabelText('Email')).toBeDisabled()
    expect(within(dialog).getByLabelText('Remarks')).toHaveValue('Hidden for your role')
    expect(within(dialog).getByLabelText('Contact person')).toHaveValue('Front Desk')

    await userEvent.type(within(dialog).getByLabelText('Contact person'), ' Two')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(api.find('PATCH', '/clients/10')).toHaveLength(1))
    const body = api.find('PATCH', '/clients/10')[0]?.body
    expect(body).toMatchObject({ contactPerson: 'Front Desk Two', vatNumber: 'OM1' })
    expect(body).not.toHaveProperty('phone')
    expect(body).not.toHaveProperty('email')
    expect(body).not.toHaveProperty('notes')
  })
})

describe('withoutHidden', () => {
  it('leaves exactly the hidden fields out of a save', () => {
    expect(withoutHidden({ a: 1, b: '', c: null }, ['b', 'c'])).toEqual({ a: 1 })
    expect(withoutHidden({ a: 1 }, [])).toEqual({ a: 1 })
  })
})

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { ContractRenewals } from '../pages/amc/ContractRenewalsPanel'
import { ADMIN, fail, ok, renderApp } from './helpers'
import { amcApi, makeContract, VIEWER } from './amc-helpers'

// Renewals on the contract page. Every record here is invented.

const SOURCE = makeContract()
const RENEWAL = makeContract({ id: '150', status: 'DRAFT', validFrom: '2028-01-01', validTo: '2028-12-31' })
const summary = (contract: typeof SOURCE) => ({
  id: contract.id,
  client: { id: contract.client.id, name: contract.client.name },
  systemDescription: contract.systemDescription,
  validFrom: contract.validFrom,
  validTo: contract.validTo,
  status: contract.status,
  createdAt: contract.createdAt,
})

function renewalsApi(user = ADMIN, links: Record<string, ContractRenewals> = {}) {
  return amcApi(user, {
    contracts: [SOURCE, RENEWAL],
    override: (request) => {
      const match = /^\/amc\/contracts\/(\d+)\/renewals$/.exec(request.path)
      if (match && request.method === 'GET') return ok(links[match[1] as string] ?? { renewedFrom: null, renewals: [] })
      if (match && request.method === 'POST') return ok({ ...RENEWAL, id: '160', scheduleChange: null }, 201)
      if (request.path === '/masters/sales-engineers/options') return ok([{ id: '7', name: 'Sara Sales', employeeNo: null }])
      return undefined
    },
  })
}

async function renewalsSection() {
  await userEvent.click(await screen.findByRole('tab', { name: /^Renewals/ }))

  return within(screen.getByRole('tabpanel'))
}

describe('contract renewals', () => {
  it('shows that a contract has no renewal and offers to create one', async () => {
    renewalsApi()
    renderApp('/amc/contracts/100')

    const section = await renewalsSection()
    expect(await section.findByText('No renewal yet')).toBeInTheDocument()
    expect(section.getByText('Not a renewal')).toBeInTheDocument()
    expect(section.getByRole('button', { name: 'Create renewal' })).toBeInTheDocument()
  })

  it('creates a renewal from the contract’s details, as a draft for the same client, without its validity', async () => {
    const api = renewalsApi()
    renderApp('/amc/contracts/100')

    const section = await renewalsSection()
    await userEvent.click(await section.findByRole('button', { name: 'Create renewal' }))
    const dialog = await screen.findByRole('dialog', { name: 'Renew AMC Contract' })

    expect(within(dialog).getByLabelText(/System/)).toHaveValue('FIRE')
    expect(within(dialog).getByLabelText(/Contract value/)).toHaveValue('1620.000')
    expect(within(dialog).getByLabelText(/Valid from/)).toHaveValue('')
    expect(within(dialog).getByLabelText(/^Status/)).toHaveValue('DRAFT')
    expect(await within(dialog).findByText('A renewal is for the same client as the contract it renews.')).toBeInTheDocument()

    await userEvent.type(within(dialog).getByLabelText(/Valid from/), '2028-01-01')
    await userEvent.type(within(dialog).getByLabelText(/Valid to/), '2028-12-31')
    await userEvent.selectOptions(await within(dialog).findByLabelText(/Sales engineer \(master list\)/), '7')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create renewal' }))

    await waitFor(() => expect(api.find('POST', '/amc/contracts/100/renewals')).toHaveLength(1))
    expect(api.find('POST', '/amc/contracts/100/renewals')[0]?.body).toMatchObject({
      clientId: '10',
      systemDescription: 'FIRE',
      validFrom: '2028-01-01',
      validTo: '2028-12-31',
      status: 'DRAFT',
      salesEngineerId: '7',
    })
    expect(api.find('PATCH', '/amc/contracts/100')).toHaveLength(0)
    expect(await screen.findByRole('status')).toHaveTextContent('This contract is unchanged.')
  })

  it('links both ways and does not offer a second renewal while one is open', async () => {
    renewalsApi(ADMIN, { '100': { renewedFrom: null, renewals: [summary(RENEWAL)] } })
    renderApp('/amc/contracts/100')

    const section = await renewalsSection()
    expect(await section.findByRole('link', { name: '01 Jan 2028 to 31 Dec 2028' })).toHaveAttribute('href', '/amc/contracts/150')
    expect(section.queryByRole('button', { name: 'Create renewal' })).not.toBeInTheDocument()
    expect(section.getByText(/already has a renewal/)).toBeInTheDocument()
  })

  it('shows the contract a renewal renews', async () => {
    renewalsApi(ADMIN, { '150': { renewedFrom: summary(SOURCE), renewals: [] } })
    renderApp('/amc/contracts/150')

    const section = await renewalsSection()
    expect(await section.findByRole('link', { name: '01 Jan 2027 to 31 Dec 2027' })).toHaveAttribute('href', '/amc/contracts/100')
  })

  it('offers no renewal to a role that may not create contracts', async () => {
    renewalsApi(VIEWER)
    renderApp('/amc/contracts/100')

    const section = await renewalsSection()
    await section.findByText('No renewal yet')
    expect(section.queryByRole('button', { name: 'Create renewal' })).not.toBeInTheDocument()
  })

  it('explains when the database update is missing', async () => {
    amcApi(ADMIN, {
      contracts: [SOURCE],
      override: (request) => (request.path === '/amc/contracts/100/renewals' ? fail(503, 'FEATURE_UNAVAILABLE', 'Not applied.') : undefined),
    })
    renderApp('/amc/contracts/100')

    const section = await renewalsSection()
    expect(await section.findByText(/migration 0072/)).toBeInTheDocument()
  })
})

describe('renewal form lists', () => {
  const openRenewal = async () => {
    renderApp('/amc/contracts/100')
    const section = await renewalsSection()
    await userEvent.click(await section.findByRole('button', { name: 'Create renewal' }))

    return within(await screen.findByRole('dialog', { name: 'Renew AMC Contract' }))
  }

  it('starts with the renewed contract’s sales engineer and sends that link with the renewal', async () => {
    const api = amcApi(ADMIN, {
      contracts: [SOURCE, RENEWAL],
      override: (request) => {
        if (request.path === '/masters/sales-engineers/options') return ok([{ id: '7', name: 'Sara Sales', employeeNo: 'E7' }, { id: '8', name: 'Omar Other', employeeNo: null }])
        if (request.path === '/amc/contracts/100/masters') return ok({ salesEngineer: { id: '7', name: 'Sara Sales', isActive: true }, systemType: null })
        if (request.path === '/amc/contracts/100/renewals' && request.method === 'GET') return ok({ renewedFrom: null, renewals: [] })
        if (request.path === '/amc/contracts/100/renewals' && request.method === 'POST') return ok({ ...RENEWAL, id: '160', scheduleChange: null }, 201)
        return undefined
      },
    })
    const dialog = await openRenewal()

    await waitFor(() => expect(dialog.getByLabelText(/Sales engineer \(master list\)/)).toHaveValue('7'))
    await userEvent.type(dialog.getByLabelText(/Valid from/), '2028-01-01')
    await userEvent.type(dialog.getByLabelText(/Valid to/), '2028-12-31')
    await userEvent.click(dialog.getByRole('button', { name: 'Create renewal' }))

    await waitFor(() => expect(api.find('POST', '/amc/contracts/100/renewals')).toHaveLength(1))
    expect(api.find('POST', '/amc/contracts/100/renewals')[0]?.body).toMatchObject({ salesEngineerId: '7' })
  })

  // The renewed contract is linked to `linked`; Sara (7) and Omar (8) are the active engineers.
  const engineerApi = (linked: { id: string; name: string; isActive: boolean } | null, post?: () => ReturnType<typeof ok>) =>
    amcApi(ADMIN, {
      contracts: [SOURCE, RENEWAL],
      override: (request) => {
        if (request.path === '/masters/sales-engineers/options') return ok([{ id: '7', name: 'Sara Sales', employeeNo: 'E7' }, { id: '8', name: 'Omar Other', employeeNo: null }])
        if (request.path === '/amc/contracts/100/masters') return ok({ salesEngineer: linked, systemType: null })
        if (request.path === '/amc/contracts/100/renewals' && request.method === 'GET') return ok({ renewedFrom: null, renewals: [] })
        if (request.path === '/amc/contracts/100/renewals' && request.method === 'POST') return post?.() ?? ok({ ...RENEWAL, id: '160', scheduleChange: null }, 201)
        return undefined
      },
    })
  const fillValidity = async (dialog: ReturnType<typeof within>) => {
    await userEvent.type(dialog.getByLabelText(/Valid from/), '2028-01-01')
    await userEvent.type(dialog.getByLabelText(/Valid to/), '2028-12-31')
  }

  it('saves a different engineer chosen in place of the renewed contract’s one', async () => {
    const api = engineerApi({ id: '7', name: 'Sara Sales', isActive: true })
    const dialog = await openRenewal()

    const picker = dialog.getByLabelText(/Sales engineer \(master list\)/)
    await waitFor(() => expect(picker).toHaveValue('7'))
    await userEvent.selectOptions(picker, '8')
    await fillValidity(dialog)
    await userEvent.click(dialog.getByRole('button', { name: 'Create renewal' }))

    await waitFor(() => expect(api.find('POST', '/amc/contracts/100/renewals')).toHaveLength(1))
    expect(api.find('POST', '/amc/contracts/100/renewals')[0]?.body).toMatchObject({ salesEngineerId: '8' })
  })

  it('shows an inactive previous engineer, preselects nobody, and saves only once an active engineer is chosen', async () => {
    const api = engineerApi({ id: '5', name: 'Fatima Former', isActive: false })
    const dialog = await openRenewal()

    const picker = (await dialog.findByLabelText(/Sales engineer \(master list\)/)) as HTMLSelectElement
    expect(picker).toHaveValue('')
    expect(picker).toBeRequired()
    expect(picker.selectedOptions[0]).toHaveTextContent('Select a sales engineer…')
    // The former engineer is shown, but is not one of the choices.
    expect(dialog.getByText('Previously assigned: Fatima Former (inactive). Select an active sales engineer for the renewal.')).toBeInTheDocument()
    expect([...picker.options].map((option) => option.value)).toEqual(['', '7', '8'])

    await fillValidity(dialog)
    await userEvent.click(dialog.getByRole('button', { name: 'Create renewal' }))
    expect(await dialog.findByText('Select an active sales engineer. Fatima Former, the previous engineer, is no longer active.')).toBeInTheDocument()
    expect(api.find('POST', '/amc/contracts/100/renewals')).toHaveLength(0)

    await userEvent.selectOptions(picker, '7')
    expect(dialog.queryByText(/the previous engineer, is no longer active/)).not.toBeInTheDocument()
    await userEvent.click(dialog.getByRole('button', { name: 'Create renewal' }))

    await waitFor(() => expect(api.find('POST', '/amc/contracts/100/renewals')).toHaveLength(1))
    expect(api.find('POST', '/amc/contracts/100/renewals')[0]?.body).toMatchObject({ salesEngineerId: '7' })
  })

  it('requires an active engineer even when the renewed contract had none, and offers no “Not linked”', async () => {
    const api = engineerApi(null)
    const dialog = await openRenewal()

    const picker = (await dialog.findByLabelText(/Sales engineer \(master list\)/)) as HTMLSelectElement
    expect(picker).toHaveValue('')
    expect(picker).toBeRequired()
    expect([...picker.options].map((option) => [option.textContent, option.disabled])).toEqual([
      ['Select a sales engineer…', true],
      ['Sara Sales (E7)', false],
      ['Omar Other', false],
    ])
    expect(dialog.getByText('A renewal needs an active sales engineer.')).toBeInTheDocument()

    await fillValidity(dialog)
    await userEvent.click(dialog.getByRole('button', { name: 'Create renewal' }))
    expect(await dialog.findByText('Select an active sales engineer for the renewal.')).toBeInTheDocument()
    expect(api.find('POST', '/amc/contracts/100/renewals')).toHaveLength(0)

    await userEvent.selectOptions(picker, '8')
    await userEvent.click(dialog.getByRole('button', { name: 'Create renewal' }))
    await waitFor(() => expect(api.find('POST', '/amc/contracts/100/renewals')).toHaveLength(1))
    expect(api.find('POST', '/amc/contracts/100/renewals')[0]?.body).toMatchObject({ salesEngineerId: '8' })
  })

  it('says why a renewal cannot be saved when the role cannot read the sales engineer list', async () => {
    const api = amcApi(ADMIN, {
      contracts: [SOURCE, RENEWAL],
      override: (request) => {
        if (request.path === '/masters/sales-engineers/options') return fail(403, 'FORBIDDEN', 'You do not have permission.')
        if (request.path === '/amc/contracts/100/renewals' && request.method === 'GET') return ok({ renewedFrom: null, renewals: [] })
        return undefined
      },
    })
    const dialog = await openRenewal()

    expect(await dialog.findByText(/your role cannot read the sales engineer list/)).toBeInTheDocument()
    expect(dialog.queryByLabelText(/Sales engineer \(master list\)/)).not.toBeInTheDocument()
    expect(dialog.getByRole('button', { name: 'Create renewal' })).toBeDisabled()
    expect(api.find('POST', '/amc/contracts/100/renewals')).toHaveLength(0)
  })

  it('shows the server’s sales engineer message on the field', async () => {
    engineerApi({ id: '7', name: 'Sara Sales', isActive: true }, () =>
      fail(400, 'VALIDATION_ERROR', 'Select an active sales engineer for the renewal.', [{ field: 'salesEngineerId', message: 'Sara Sales is no longer active. Select an active sales engineer.' }]),
    )
    const dialog = await openRenewal()

    await waitFor(() => expect(dialog.getByLabelText(/Sales engineer \(master list\)/)).toHaveValue('7'))
    await fillValidity(dialog)
    await userEvent.click(dialog.getByRole('button', { name: 'Create renewal' }))

    expect(await dialog.findByText('Sara Sales is no longer active. Select an active sales engineer.')).toBeInTheDocument()
  })

  it('shows a client that has since been deactivated, and says it must be reactivated first', async () => {
    amcApi(ADMIN, {
      contracts: [SOURCE, RENEWAL],
      override: (request) => {
        if (request.method === 'GET' && request.path === '/amc/contracts/client-options') return ok([])
        if (request.path === '/amc/contracts/100/renewals' && request.method === 'GET') return ok({ renewedFrom: null, renewals: [] })
        return undefined
      },
    })
    const dialog = await openRenewal()

    const client = dialog.getByLabelText(/^Client/) as HTMLSelectElement
    expect(client).toHaveValue(SOURCE.client.id)
    expect(client.selectedOptions[0]).toHaveTextContent(`${SOURCE.client.name} (inactive)`)
    expect(dialog.getByText('This client is inactive. Reactivate it in Clients before renewing the contract.')).toBeInTheDocument()
  })
})

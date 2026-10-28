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
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create renewal' }))

    await waitFor(() => expect(api.find('POST', '/amc/contracts/100/renewals')).toHaveLength(1))
    expect(api.find('POST', '/amc/contracts/100/renewals')[0]?.body).toMatchObject({
      clientId: '10',
      systemDescription: 'FIRE',
      validFrom: '2028-01-01',
      validTo: '2028-12-31',
      status: 'DRAFT',
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

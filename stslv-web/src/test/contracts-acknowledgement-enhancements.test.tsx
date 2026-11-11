import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ServiceAcknowledgementIndicator, type ServiceAcknowledgement } from '../pages/invoiceAcknowledgements/ServiceAcknowledgement'
import { ADMIN, mockApi, ok, renderApp, signIn } from './helpers'
import { amcApi, contractPdf, makeContract, typeReference } from './amc-helpers'

// Client-approved enhancements of 2026-11-11 on the web: the new-contract billing basis default, Final credit following
// AMC Value until typed, the per-service value on the register, server-side sorting, and the acknowledgement indicator.

const FIRE = makeContract()
const BASED = makeContract({
  id: '102',
  amcReference: 'AMC-0102',
  client: { id: '11', name: 'Test Hotel Two', isActive: true },
  systemDescription: 'CCTV',
  contractValue: '1200.000',
  defaultVisitAmount: '999.000',
  billingBasis: 'CONTRACT_VALUE',
  schedule: { ...FIRE.schedule, annualAmount: '1200.000', servicesPerCycle: 4, perServiceAmount: '300.000' },
})

async function openAddForm() {
  await userEvent.click(await screen.findByRole('button', { name: 'Add Contract' }))
  const dialog = await screen.findByRole('dialog', { name: 'Add AMC Contract' })
  await within(dialog).findByLabelText(/Client/)
  await waitFor(() => expect(within(dialog).getByLabelText(/^System/)).toBeEnabled())
  await within(dialog).findByLabelText(/Service engineer \(master list\)/)
  return dialog
}

async function fillOthers(dialog: HTMLElement) {
  await typeReference(dialog)
  await userEvent.selectOptions(within(dialog).getByLabelText(/Client/), '10')
  await userEvent.selectOptions(within(dialog).getByLabelText(/^System/), '21')
  await userEvent.selectOptions(within(dialog).getByLabelText(/Service engineer \(master list\)/), '5')
  await userEvent.selectOptions(within(dialog).getByLabelText(/Maintenance frequency/), 'QUARTERLY')
  await userEvent.type(within(dialog).getByLabelText(/Valid from/), '2027-01-01')
  await userEvent.type(within(dialog).getByLabelText(/Valid to/), '2027-12-31')
  await userEvent.upload(dialog.querySelector('input[type="file"]') as HTMLInputElement, contractPdf())
}

describe('A1 — new contracts start on AMC Value / Year', () => {
  it('selects AMC Value / Year by default and sends it', async () => {
    const api = amcApi(ADMIN, { contracts: [FIRE] })
    renderApp('/amc/contracts')
    const dialog = await openAddForm()

    expect(within(dialog).getByLabelText(/Billing basis/)).toHaveValue('CONTRACT_VALUE')
    await fillOthers(dialog)
    await userEvent.type(within(dialog).getByLabelText(/AMC Value \/ Year/), '1200')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add contract' }))

    await waitFor(() => expect(api.find('POST', '/amc/contracts')).toHaveLength(1))
    expect(api.find('POST', '/amc/contracts')[0]?.body).toMatchObject({ billingBasis: 'CONTRACT_VALUE', contractValue: '1200', finalCredit: '1200' })
  })

  it('keeps an explicitly chosen alternative, including Not set', async () => {
    const api = amcApi(ADMIN, { contracts: [FIRE] })
    renderApp('/amc/contracts')
    const dialog = await openAddForm()

    await fillOthers(dialog)
    await userEvent.type(within(dialog).getByLabelText(/AMC Value \/ Year/), '1200')
    await userEvent.selectOptions(within(dialog).getByLabelText(/Billing basis/), 'FINAL_CREDIT')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add contract' }))

    await waitFor(() => expect(api.find('POST', '/amc/contracts')).toHaveLength(1))
    expect(api.find('POST', '/amc/contracts')[0]?.body).toMatchObject({ billingBasis: 'FINAL_CREDIT' })
  })

  it('keeps the stored basis of an existing contract (none) when editing it', async () => {
    amcApi(ADMIN, { contracts: [FIRE] })
    renderApp('/amc/contracts')

    await userEvent.click(await screen.findByRole('button', { name: 'Edit Test Hotel One FIRE' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit AMC Contract' })

    expect(await within(dialog).findByLabelText(/Billing basis/)).toHaveValue('')
  })
})

describe('A2 — Final credit follows AMC Value until it is typed', () => {
  it('fills Final credit with the AMC Value, three decimals as typed', async () => {
    amcApi(ADMIN, { contracts: [FIRE] })
    renderApp('/amc/contracts')
    const dialog = await openAddForm()

    await userEvent.type(within(dialog).getByLabelText(/AMC Value \/ Year/), '1200.000')
    expect(within(dialog).getByLabelText(/Final credit/)).toHaveValue('1200.000')
    expect(within(dialog).getByText(/Filled from AMC Value \/ Year until you change it/)).toBeInTheDocument()
  })

  it('keeps a typed Final credit when AMC Value changes afterwards', async () => {
    const api = amcApi(ADMIN, { contracts: [FIRE] })
    renderApp('/amc/contracts')
    const dialog = await openAddForm()
    const value = within(dialog).getByLabelText(/AMC Value \/ Year/)
    const final = within(dialog).getByLabelText(/Final credit/)

    await userEvent.type(value, '1200')
    await userEvent.clear(final)
    await userEvent.type(final, '1100.000')
    await userEvent.clear(value)
    await userEvent.type(value, '1300')
    expect(final).toHaveValue('1100.000')

    await fillOthers(dialog)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add contract' }))
    await waitFor(() => expect(api.find('POST', '/amc/contracts')).toHaveLength(1))
    expect(api.find('POST', '/amc/contracts')[0]?.body).toMatchObject({ contractValue: '1300', finalCredit: '1100.000' })
  })

  it('starts again for the next new contract', async () => {
    amcApi(ADMIN, { contracts: [FIRE] })
    renderApp('/amc/contracts')
    let dialog = await openAddForm()
    await userEvent.type(within(dialog).getByLabelText(/Final credit/), '5')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    dialog = await openAddForm()
    await userEvent.type(within(dialog).getByLabelText(/AMC Value \/ Year/), '800')
    expect(within(dialog).getByLabelText(/Final credit/)).toHaveValue('800')
  })

  it('never changes Final credit of a saved contract when its AMC Value is edited', async () => {
    amcApi(ADMIN, { contracts: [{ ...FIRE, finalCredit: '1500.000' }] })
    renderApp('/amc/contracts')

    await userEvent.click(await screen.findByRole('button', { name: 'Edit Test Hotel One FIRE' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit AMC Contract' })
    const value = await within(dialog).findByLabelText(/AMC Value \/ Year/)
    await userEvent.clear(value)
    await userEvent.type(value, '1800')

    expect(within(dialog).getByLabelText(/Final credit/)).toHaveValue('1500.000')
  })
})

describe('A3 — the register shows the value of one service', () => {
  it('shows the per-service amount of the billing basis, and the Cost per Visit only without a basis', async () => {
    amcApi(ADMIN, { contracts: [FIRE, BASED] })
    renderApp('/amc/contracts')

    const table = await screen.findByRole('table', { name: 'AMC contracts' })
    const based = within(table).getByText('Test Hotel Two').closest('tr') as HTMLElement
    const manual = within(table).getByText('Test Hotel One').closest('tr') as HTMLElement

    expect(within(based).getByText('300.000 per service')).toBeInTheDocument()
    // The Cost per Visit is not used while a basis is selected, so it is not shown as the service value.
    expect(within(based).queryByText(/999\.000/)).not.toBeInTheDocument()
    expect(within(manual).getByText('405.000 per visit')).toBeInTheDocument()
  })
})

describe('A4 — AMC Contracts sorting', () => {
  const lastQuery = (api: ReturnType<typeof amcApi>) => Object.fromEntries(api.find('GET', '/amc/contracts').at(-1)?.query ?? [])

  it('sorts on the server, ascending then descending, and says so', async () => {
    const api = amcApi(ADMIN, { contracts: [FIRE, BASED] })
    renderApp('/amc/contracts')
    await screen.findByRole('table', { name: 'AMC contracts' })

    // No sort until one is chosen: the usual order.
    expect(lastQuery(api).sort).toBeUndefined()
    await userEvent.click(screen.getByRole('button', { name: 'Contract value: sort ascending' }))
    await waitFor(() => expect(lastQuery(api)).toMatchObject({ sort: 'contractValue', direction: 'asc', page: '1' }))
    expect(screen.getByRole('columnheader', { name: /Contract value/ })).toHaveAttribute('aria-sort', 'ascending')

    await userEvent.click(screen.getByRole('button', { name: 'Contract value: sort descending' }))
    await waitFor(() => expect(lastQuery(api)).toMatchObject({ sort: 'contractValue', direction: 'desc' }))
    expect(screen.getByRole('columnheader', { name: /Contract value/ })).toHaveAttribute('aria-sort', 'descending')
  })

  it('offers every requested column, works from the keyboard, and keeps the filters', async () => {
    const api = amcApi(ADMIN, { contracts: [FIRE, BASED] })
    renderApp('/amc/contracts')
    await screen.findByRole('table', { name: 'AMC contracts' })

    for (const label of ['AMC Reference', 'Client', 'Engineer', 'Start', 'End', 'Contract value', 'Credit', 'Status']) {
      expect(screen.getByRole('button', { name: `${label}: sort ascending` })).toBeInTheDocument()
    }

    await userEvent.type(screen.getByRole('searchbox', { name: /Search/ }), 'hotel')
    await waitFor(() => expect(lastQuery(api).search).toBe('hotel'))
    screen.getByRole('button', { name: 'End: sort ascending' }).focus()
    await userEvent.keyboard('{Enter}')

    await waitFor(() => expect(lastQuery(api)).toMatchObject({ sort: 'validTo', direction: 'asc', search: 'hotel', page: '1' }))
    expect(screen.getByRole('columnheader', { name: /Validity/ })).toHaveAttribute('aria-sort', 'ascending')
  })
})

describe('B — the acknowledgement indicator', () => {
  const ack = (overrides: Partial<ServiceAcknowledgement>): ServiceAcknowledgement => ({
    state: 'PENDING',
    acknowledged: 'NO',
    invoiceId: '7',
    documentAvailable: false,
    acknowledgedAt: null,
    needsReconciliation: false,
    ...overrides,
  })

  it('says Yes, No or Not Applicable in words as well as colour', () => {
    const { container } = render(
      <>
        <ServiceAcknowledgementIndicator acknowledgement={ack({ state: 'ACKNOWLEDGED', acknowledged: 'YES', documentAvailable: true, acknowledgedAt: '2026-11-05T09:00:00.000Z' })} />
        <ServiceAcknowledgementIndicator acknowledgement={ack({})} />
        <ServiceAcknowledgementIndicator acknowledgement={ack({ state: 'AWAITING_CONFIRMATION', documentAvailable: true })} />
        <ServiceAcknowledgementIndicator acknowledgement={ack({ state: 'NOT_APPLICABLE', acknowledged: 'NOT_APPLICABLE', invoiceId: null })} />
      </>,
    )
    const indicators = [...container.querySelectorAll('[data-acknowledged]')]

    expect(indicators.map((node) => node.getAttribute('data-acknowledged'))).toEqual(['YES', 'NO', 'NO', 'NOT_APPLICABLE'])
    expect(indicators[0]?.querySelector('.bg-emerald-100')).not.toBeNull()
    expect(indicators[1]?.querySelector('.bg-red-50')).not.toBeNull()
    expect(indicators[3]?.querySelector('.bg-slate-100')).not.toBeNull()
    expect(screen.getAllByText('Invoice acknowledged:', { exact: false })).toHaveLength(4)
    expect(screen.getByText('Acknowledgement document missing')).toBeInTheDocument()
    expect(screen.getByText('Document uploaded, awaiting confirmation')).toBeInTheDocument()
    expect(screen.getByText('No invoice recorded')).toBeInTheDocument()
  })

  it('downloads the document through the private API, never a stored link', async () => {
    signIn()
    const api = mockApi((request) => (request.path === '/invoice-acknowledgements/7/document' ? ok({}) : undefined))
    render(<ServiceAcknowledgementIndicator acknowledgement={ack({ state: 'ACKNOWLEDGED', acknowledged: 'YES', documentAvailable: true })} />)

    await userEvent.click(screen.getByRole('button', { name: /Download the acknowledgement document/ }))
    await waitFor(() => expect(api.find('GET', '/invoice-acknowledgements/7/document')).toHaveLength(1))
  })

  it('offers no download without a document', () => {
    render(<ServiceAcknowledgementIndicator acknowledgement={ack({})} />)

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})

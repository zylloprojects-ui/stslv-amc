import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { frequencyLabel, visitNumberLabel } from '../pages/amc/types'
import { amcApi, makeContract } from './amc-helpers'
import { ADMIN, ok, renderApp, type MockRequest } from './helpers'

// The AMC contract form with the maintenance frequency master (migration 0076):
// active frequencies from the master, custom months, the fallback to the four
// built-in frequencies, and a contract that keeps a frequency disabled since.
// Every record is invented.

const OPTIONS_PATH = '/masters/maintenance-frequencies/options'

// The dedicated frequency route's shape: with a prefix and the rule.
const option = (code: string, name: string, extra: Record<string, unknown> = {}) => ({ code, name, codePrefix: code.slice(0, 1), isCustom: false, ruleSummary: null, ...extra })
const MASTER_OPTIONS = [
  option('MONTHLY', 'Monthly', { ruleSummary: '12 services · every month' }),
  option('QUARTERLY', 'Quarterly', { ruleSummary: '4 services · every 3 months' }),
  option('BI_MONTHLY', 'Bi-Monthly / Every 2 Months', { codePrefix: 'BM', ruleSummary: '6 services · every 2 months' }),
  option('CUSTOM', 'Custom', { isCustom: true, ruleSummary: 'Months chosen on each contract' }),
]

const withOptions = (items: unknown) => (request: MockRequest) => (request.method === 'GET' && request.path === OPTIONS_PATH ? ok(items) : undefined)

async function openAddForm() {
  await userEvent.click(await screen.findByRole('button', { name: 'Add Contract' }))
  const dialog = await screen.findByRole('dialog', { name: 'Add AMC Contract' })
  await within(dialog).findByLabelText(/Client/)

  return dialog
}

const frequencyChoices = (dialog: HTMLElement) =>
  within(within(dialog).getByLabelText(/Maintenance frequency/))
    .getAllByRole('option')
    .map((item) => item.getAttribute('value'))

async function fillRequired(dialog: HTMLElement) {
  await userEvent.selectOptions(within(dialog).getByLabelText(/Client/), '11')
  await userEvent.type(within(dialog).getByLabelText(/System/), 'CCTV')
  await userEvent.type(within(dialog).getByLabelText(/Valid from/), '2027-01-15')
  await userEvent.type(within(dialog).getByLabelText(/Valid to/), '2028-01-14')
  await userEvent.type(within(dialog).getByLabelText(/Contract value/), '4000')
}

describe('frequency choices', () => {
  it('offers the active frequencies from the frequency master, with their rule', async () => {
    amcApi(ADMIN, { override: withOptions(MASTER_OPTIONS) })
    renderApp('/amc/contracts')
    const dialog = await openAddForm()

    await waitFor(() => expect(frequencyChoices(dialog)).toEqual(['', 'MONTHLY', 'QUARTERLY', 'BI_MONTHLY', 'CUSTOM']))
    expect(within(dialog).getByRole('option', { name: 'Bi-Monthly / Every 2 Months — 6 services · every 2 months' })).toBeInTheDocument()
  })

  it('falls back to the four built-in frequencies when the frequency master is not available', async () => {
    amcApi(ADMIN)
    renderApp('/amc/contracts')
    const dialog = await openAddForm()

    await waitFor(() => expect(frequencyChoices(dialog)).toEqual(['', 'MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'ANNUALLY']))
  })

  it('ignores a list in the older shape (no prefix) and keeps the built-in frequencies', async () => {
    amcApi(ADMIN, { override: withOptions([{ code: 'MONTHLY', name: 'Monthly', label: 'Monthly', intervalMonths: 1 }]) })
    renderApp('/amc/contracts')
    const dialog = await openAddForm()

    await waitFor(() => expect(frequencyChoices(dialog)).toEqual(['', 'MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'ANNUALLY']))
  })
})

describe('custom months', () => {
  it('asks for the months only for a custom frequency, and sends them', async () => {
    const api = amcApi(ADMIN, { override: withOptions(MASTER_OPTIONS) })
    renderApp('/amc/contracts')
    const dialog = await openAddForm()
    await fillRequired(dialog)

    await waitFor(() => expect(frequencyChoices(dialog)).toContain('CUSTOM'))
    expect(within(dialog).queryByRole('group', { name: /Service months/ })).not.toBeInTheDocument()
    await userEvent.selectOptions(within(dialog).getByLabelText(/Maintenance frequency/), 'CUSTOM')
    const months = within(dialog).getByRole('group', { name: /Service months/ })

    await userEvent.click(within(dialog).getByRole('button', { name: 'Add contract' }))
    expect(await within(months).findByText('Select the months in which visits take place.')).toBeInTheDocument()
    expect(api.find('POST', '/amc/contracts')).toHaveLength(0)

    await userEvent.click(within(months).getByRole('checkbox', { name: 'August' }))
    await userEvent.click(within(months).getByRole('checkbox', { name: 'February' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add contract' }))

    await waitFor(() => expect(api.find('POST', '/amc/contracts')).toHaveLength(1))
    expect(api.find('POST', '/amc/contracts')[0]?.body).toMatchObject({ maintenanceFrequency: 'CUSTOM', customMonths: [2, 8] })
  })

  it('does not send months chosen before switching to a fixed frequency', async () => {
    const api = amcApi(ADMIN, { override: withOptions(MASTER_OPTIONS) })
    renderApp('/amc/contracts')
    const dialog = await openAddForm()
    await fillRequired(dialog)

    await waitFor(() => expect(frequencyChoices(dialog)).toContain('CUSTOM'))
    await userEvent.selectOptions(within(dialog).getByLabelText(/Maintenance frequency/), 'CUSTOM')
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'March' }))
    await userEvent.selectOptions(within(dialog).getByLabelText(/Maintenance frequency/), 'BI_MONTHLY')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add contract' }))

    await waitFor(() => expect(api.find('POST', '/amc/contracts')).toHaveLength(1))
    const body = api.find('POST', '/amc/contracts')[0]?.body as Record<string, unknown>
    expect(body.maintenanceFrequency).toBe('BI_MONTHLY')
    expect(body).not.toHaveProperty('customMonths')
  })
})

describe('a contract on a frequency disabled since', () => {
  it('keeps it selected and marked not active when editing', async () => {
    const contract = makeContract({ id: '150', maintenanceFrequency: 'HALF_YEARLY', systemDescription: 'PUMP' })
    amcApi(ADMIN, { contracts: [contract], override: withOptions(MASTER_OPTIONS) })
    renderApp('/amc/contracts/150')

    await userEvent.click(await screen.findByRole('button', { name: /Edit/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit AMC Contract' })
    const select = await within(dialog).findByLabelText(/Maintenance frequency/)

    await waitFor(() => expect(within(select).getByRole('option', { name: 'Half-yearly (not active)' })).toBeInTheDocument())
    expect(select).toHaveValue('HALF_YEARLY')
  })
})

describe('labels', () => {
  it('names every seeded frequency and shows an unknown code as itself', () => {
    expect(frequencyLabel('EVERY_4_MONTHS')).toBe('Every 4 Months')
    expect(frequencyLabel('SEASONAL_ALT')).toBe('SEASONAL_ALT')
  })

  it('shows a visit by its service label, or by its number when it has none', () => {
    expect(visitNumberLabel({ sequenceNo: 7, cycleNo: 2, serviceCode: 'Q3' })).toBe('Year 2 · Q3')
    expect(visitNumberLabel({ sequenceNo: 7, cycleNo: null, serviceCode: null })).toBe('No. 7')
    expect(visitNumberLabel({ sequenceNo: 7 })).toBe('No. 7')
  })
})

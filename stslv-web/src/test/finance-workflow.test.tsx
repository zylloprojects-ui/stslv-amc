import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { COMPLETE_FIRST_NOTE, ManualInvoiceField, PAID_STATUS_NOTE, PaymentBadge } from '../pages/amc/ManualInvoiceField'
import { RegenerateDialog } from '../pages/amc/RegenerateDialog'
import { makeContract } from './amc-helpers'
import { fail, mockApi, ok } from './helpers'

const UPDATED_AT = '2027-01-01T08:00:00.000Z'

function wrap(children: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>)
}

const field = (props: Partial<Parameters<typeof ManualInvoiceField>[0]> = {}) => (
  <ManualInvoiceField visitId="5" invoiceNo={null} updatedAt={UPDATED_AT} canEdit completed label="AMC-0007 Q1" {...props} />
)

describe('manual Invoice No.', () => {
  it('sends only the number and the page’s version when a number is entered: no date, amount or VAT', async () => {
    const api = mockApi((request) => (request.method === 'PATCH' ? ok({ id: '5' }) : undefined))
    wrap(field())

    expect(screen.getByText('Unpaid')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Invoice No. for AMC-0007 Q1'), ' INV-1 ')
    await userEvent.click(screen.getByRole('button', { name: 'Save Invoice No. for AMC-0007 Q1' }))

    await waitFor(() => expect(api.find('PATCH', '/amc/visits/5/manual-invoice')).toHaveLength(1))
    expect(api.find('PATCH', '/amc/visits/5/manual-invoice')[0]?.body).toEqual({ invoiceNo: 'INV-1', expectedUpdatedAt: UPDATED_AT })
  })

  it('clearing the number sends null, for Unpaid', async () => {
    const api = mockApi((request) => (request.method === 'PATCH' ? ok({ id: '5' }) : undefined))
    wrap(field({ invoiceNo: 'INV-1' }))

    expect(screen.getByText('Paid')).toBeInTheDocument()
    await userEvent.clear(screen.getByLabelText('Invoice No. for AMC-0007 Q1'))
    await userEvent.click(screen.getByRole('button', { name: 'Save Invoice No. for AMC-0007 Q1' }))

    await waitFor(() => expect(api.find('PATCH', '/amc/visits/5/manual-invoice')[0]?.body).toEqual({ invoiceNo: null, expectedUpdatedAt: UPDATED_AT }))
  })

  it('offers no save until something changed', () => {
    mockApi(() => undefined)
    wrap(field({ invoiceNo: 'INV-1' }))

    expect(screen.getByRole('button', { name: 'Save Invoice No. for AMC-0007 Q1' })).toBeDisabled()
  })

  it('shows the API’s refusal beside the field and keeps what was typed', async () => {
    mockApi((request) => (request.method === 'PATCH' ? fail(409, 'CONFLICT', 'This service was changed by someone else.') : undefined))
    wrap(field())

    await userEvent.type(screen.getByLabelText('Invoice No. for AMC-0007 Q1'), 'INV-2')
    await userEvent.click(screen.getByRole('button', { name: 'Save Invoice No. for AMC-0007 Q1' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('changed by someone else')
    expect(screen.getByLabelText('Invoice No. for AMC-0007 Q1')).toHaveValue('INV-2')
  })

  it('without the permission shows the number and status, with no field', () => {
    mockApi(() => undefined)
    wrap(field({ invoiceNo: 'INV-3', canEdit: false }))

    expect(screen.getByText('INV-3')).toBeInTheDocument()
    expect(screen.getByText('Paid')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('on a service that is not completed, disables the field and OK and says why', () => {
    mockApi(() => undefined)
    wrap(field({ completed: false }))

    const input = screen.getByLabelText('Invoice No. for AMC-0007 Q1')
    expect(input).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save Invoice No. for AMC-0007 Q1' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: /Clear Invoice No./ })).not.toBeInTheDocument()
    expect(screen.getByText(COMPLETE_FIRST_NOTE)).toBeInTheDocument()
    expect(input).toHaveAccessibleDescription(COMPLETE_FIRST_NOTE)
    expect(COMPLETE_FIRST_NOTE).toBe('Complete the service before entering an invoice number.')
  })

  it('on a service that is not completed, keeps an existing number visible and read-only, and still lets it be cleared', async () => {
    const api = mockApi((request) => (request.method === 'PATCH' ? ok({ id: '5' }) : undefined))
    wrap(field({ completed: false, invoiceNo: 'INV-9' }))

    const input = screen.getByLabelText('Invoice No. for AMC-0007 Q1')
    expect(input).toHaveValue('INV-9')
    expect(input).toHaveAttribute('readonly')
    expect(screen.getByText('Paid')).toBeInTheDocument()
    await userEvent.type(input, 'X')
    expect(input).toHaveValue('INV-9')
    expect(screen.getByRole('button', { name: 'Save Invoice No. for AMC-0007 Q1' })).toBeDisabled()

    await userEvent.click(screen.getByRole('button', { name: 'Clear Invoice No. for AMC-0007 Q1' }))
    await waitFor(() => expect(api.find('PATCH', '/amc/visits/5/manual-invoice')[0]?.body).toEqual({ invoiceNo: null, expectedUpdatedAt: UPDATED_AT }))
    expect(api.find('PATCH', '/amc/visits/5/manual-invoice')).toHaveLength(1)
  })

  it('on a completed service shows no completion note and no separate Clear button', () => {
    mockApi(() => undefined)
    wrap(field({ invoiceNo: 'INV-1' }))

    expect(screen.getByLabelText('Invoice No. for AMC-0007 Q1')).toBeEnabled()
    expect(screen.queryByText(COMPLETE_FIRST_NOTE)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Clear Invoice No./ })).not.toBeInTheDocument()
  })

  it('says on the badge that Paid is a reference status', () => {
    wrap(<PaymentBadge invoiceNo="X" />)

    expect(screen.getByText('Paid')).toHaveAttribute('title', PAID_STATUS_NOTE)
    expect(PAID_STATUS_NOTE).toMatch(/does not verify that money was received/)
  })
})

const PREVIEW = {
  canApply: true,
  blockedReason: null,
  billingBasis: 'CONTRACT_VALUE',
  annualAmount: '500.000',
  servicesPerCycle: 6,
  perServiceAmount: '83.333',
  lastServiceAmount: '83.335',
  toCreate: 0,
  toRemove: 0,
  changes: [{ id: '1', sequenceNo: 2, serviceCode: 'BM2', scheduledDate: '2027-03-01', from: '100.000', to: '83.333' }],
  preserved: [{ id: '2', sequenceNo: 1, serviceCode: 'BM1', scheduledDate: '2027-01-01', amount: '100.000', reason: 'Completed' }],
  unchanged: 3,
}

describe('Regenerate', () => {
  it('shows what would change and what is kept, and needs a reason before it applies', async () => {
    const onClose = vi.fn()
    const api = mockApi((request) => {
      if (request.method === 'GET' && request.path === '/amc/contracts/100/schedule/regenerate') return ok(PREVIEW)
      if (request.method === 'POST' && request.path === '/amc/contracts/100/schedule/regenerate') return ok({ recalculated: 1 })
      return undefined
    })
    wrap(<RegenerateDialog contract={makeContract()} onClose={onClose} />)

    expect(await screen.findByText(/83\.335 for the last service of each complete year/)).toBeInTheDocument()
    expect(screen.getByText('1 visit amount(s) recalculated')).toBeInTheDocument()
    expect(screen.getByText(/BM1 · .* · Completed/)).toBeInTheDocument()
    expect(api.find('POST', '/amc/contracts/100/schedule/regenerate')).toHaveLength(0)

    const apply = screen.getByRole('button', { name: 'Regenerate' })
    expect(apply).toBeDisabled()
    await userEvent.type(screen.getByLabelText(/Reason for regenerating/), 'Annual review')
    await userEvent.click(apply)

    await waitFor(() => expect(api.find('POST', '/amc/contracts/100/schedule/regenerate')[0]?.body).toEqual({ reason: 'Annual review' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('explains a refusal and offers no way to apply', async () => {
    mockApi((request) => (request.method === 'GET' ? ok({ ...PREVIEW, canApply: false, blockedReason: 'Select a Billing Basis first.', annualAmount: null, billingBasis: null, changes: [], preserved: [] }) : undefined))
    wrap(<RegenerateDialog contract={makeContract()} onClose={() => undefined} />)

    expect(await screen.findByText('Select a Billing Basis first.')).toBeInTheDocument()
    expect(screen.queryByLabelText(/Reason for regenerating/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeDisabled()
  })
})

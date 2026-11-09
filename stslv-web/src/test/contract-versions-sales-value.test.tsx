import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '../lib/types'
import type { ServicesSalesItem, ServicesSalesList } from '../pages/servicesSales/servicesSalesTypes'
import { ADMIN, mockApi, ok, renderApp, signIn } from './helpers'
import { makeContract } from './amc-helpers'

// Owner approval 2026-11-09: same visible contract number across renewals, each period with its version (0111), and
// Service Sales AMC Value with a unique-contract total for users who may view AMC Contracts. Invented records only.

beforeEach(() => {
  signIn()
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('AMC Contracts: one number, several versions', () => {
  it('shows the same number for the original and its renewal, marking the renewal’s version', async () => {
    mockApi((request) => {
      if (request.path === '/auth/me') return ok({ user: ADMIN })
      if (request.path === '/amc/contracts/kpis') return ok({ total: 2, contractValue: '0.000', finalCredit: '0.000', finalCreditMissing: 0, expired: 0 })
      if (request.path === '/amc/contracts/filter-options') return ok({ clients: [], systems: [], salesEngineers: [], frequencies: [], years: [] })
      if (request.path === '/amc/contracts') {
        return ok({
          items: [
            makeContract({ id: '100', amcReference: 'STS-AMC-001', contractVersion: 1, versionRootId: '100' }),
            makeContract({ id: '101', amcReference: 'STS-AMC-001', contractVersion: 2, versionRootId: '100', validFrom: '2027-01-01', validTo: '2027-12-31' }),
          ],
          total: 2,
          page: 1,
          pageSize: 25,
          totals: { contractValue: '0.000', finalCredit: '0.000' },
        })
      }
      return undefined
    })
    renderApp('/amc/contracts')

    await waitFor(() => expect(screen.getAllByRole('link', { name: 'STS-AMC-001' })).toHaveLength(2))
    const badge = screen.getByTitle('Version 2 of contract STS-AMC-001 (a renewal)')
    expect(badge).toHaveTextContent('V2')
    expect(screen.queryByText('V1')).not.toBeInTheDocument()
  })
})

function salesItem(overrides: Partial<ServicesSalesItem>): ServicesSalesItem {
  return {
    id: '1',
    reference: 'SV-ALPHA',
    contract: { id: '10', status: 'ACTIVE' },
    client: { id: '5', name: 'Sales Value Client' },
    system: { description: 'FIRE', typeId: null, typeName: null },
    frequency: { code: 'QUARTERLY', label: 'Quarterly' },
    service: { sequenceNo: 1, cycleNo: 1, serviceCode: 'Q1' },
    periodStart: '2026-01-01',
    periodEnd: '2026-03-31',
    scheduledDate: '2026-01-01',
    visitStatus: 'SCHEDULED',
    serviceStatus: 'NOT_COMPLETED',
    salesStatus: 'NOT_COMPLETED',
    completedDate: null,
    serviceReportNo: null,
    salesEngineer: null,
    quotationNo: null,
    quotationUpdatedAt: null,
    quotationUpdatedBy: null,
    quotationBeforeCompletion: false,
    serviceReport: null,
    updatedAt: '2026-01-01T08:00:00.000Z',
    ...overrides,
  }
}

describe('Service Sales: AMC Value and filtered total', () => {
  function salesApi(user: SessionUser, visible: boolean) {
    const items = [
      salesItem({ id: '1', amcValue: visible ? '1200.000' : null }),
      salesItem({ id: '2', service: { sequenceNo: 2, cycleNo: 1, serviceCode: 'Q2' }, amcValue: visible ? '1200.000' : null }),
      salesItem({ id: '3', reference: 'SV-ALPHA (V2)', contract: { id: '11', status: 'ACTIVE' }, amcValue: visible ? '1500.250' : null }),
    ]
    return mockApi((request) => {
      if (request.path === '/auth/me') return ok({ user })
      if (request.path === '/services-sales/options') return ok({ clients: [], salesEngineers: [], systemTypes: [], frequencies: [], years: [2026] })
      if (request.path === '/services-sales') {
        const list: ServicesSalesList = {
          items,
          total: 40,
          page: 1,
          pageSize: 50,
          kpis: { total: 40, notCompleted: 40, quotePending: 0, quoted: 0, quotationBeforeCompletion: 0 },
          serviceReportsAvailable: true,
          amcValueVisible: visible,
          amcValueTotal: visible ? { total: '2700.250', contracts: 2 } : null,
        }
        return ok(list)
      }
      return undefined
    })
  }
  const headers = () => within(screen.getByRole('table')).getAllByRole('columnheader').map((cell) => cell.textContent?.trim())

  it('shows each visit’s contract-period value and the total over unique contract periods, on every page', async () => {
    salesApi(ADMIN, true)
    renderApp('/amc/service-sales')

    await screen.findByText('SV-ALPHA (V2)')
    expect(headers()).toContain('AMC Value (OMR)')
    expect(screen.getAllByText('1,200.000')).toHaveLength(2)
    expect(screen.getByText('1,500.250')).toBeInTheDocument()
    const footer = screen.getByRole('rowheader', { name: /Total AMC Value of matching contracts \(2 unique contract periods, all pages\)/ }).closest('tr') as HTMLElement
    expect(footer).toHaveTextContent('2,700.250')
    expect(footer).toHaveTextContent('Not an invoice value or a payment')
  })

  it('can hide and show the AMC Value column like any other', async () => {
    salesApi(ADMIN, true)
    renderApp('/amc/service-sales')

    await screen.findByText('SV-ALPHA (V2)')
    await userEvent.click(screen.getByRole('button', { name: /^Hide Columns/ }))
    const dialog = within(screen.getByRole('dialog'))
    await userEvent.click(dialog.getByRole('checkbox', { name: 'AMC Value (OMR)' }))
    await userEvent.click(dialog.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(headers()).not.toContain('AMC Value (OMR)'))
    expect(screen.queryByText(/Total AMC Value of matching contracts/)).not.toBeInTheDocument()
  })

  it('offers no AMC Value column or total to a user without AMC Contracts: View', async () => {
    const seller: SessionUser = { ...ADMIN, id: '40', email: 'seller@example.com', roles: [{ id: '9', code: 'SALES', name: 'Sales' }], permissions: ['SERVICES_SALES:VIEW'] }
    salesApi(seller, false)
    renderApp('/amc/service-sales')

    await screen.findByText('SV-ALPHA (V2)')
    expect(headers()).not.toContain('AMC Value (OMR)')
    expect(screen.queryByText(/Total AMC Value/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^Hide Columns/ }))
    expect(within(screen.getByRole('dialog')).queryByRole('checkbox', { name: 'AMC Value (OMR)' })).not.toBeInTheDocument()
  })
})

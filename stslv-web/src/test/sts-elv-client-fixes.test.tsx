import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { todayIso } from '../pages/amc/amcFormat'
import type { ServiceStatusItem, ServiceStatusList } from '../pages/amc/serviceStatusTypes'
import type { AccountsItem } from '../pages/accounts/accountsTypes'
import type { SessionUser } from '../lib/types'
import { ADMIN, mockApi, ok, renderApp, signIn, type MockRequest } from './helpers'
import { makeContract } from './amc-helpers'

// STS-ELV client fixes (2026-11-09): AMC Contracts validity filter and Contract column, Service Status AMC Value and
// Sales Engineer Name, Accounts Service Report viewer and filtered totals. Every record here is invented.

const TODAY = todayIso()

beforeEach(() => {
  signIn()
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('AMC Contracts: validity filter and Contract column', () => {
  function contractsApi() {
    return mockApi((request: MockRequest) => {
      if (request.path === '/auth/me') return ok({ user: ADMIN })
      if (request.path === '/amc/contracts/kpis') return ok({ total: 1, contractValue: '1620.000', finalCredit: '0.000', finalCreditMissing: 0, expired: 1 })
      if (request.path === '/amc/contracts/filter-options') return ok({ clients: [], systems: [], salesEngineers: [], frequencies: [], years: [] })
      if (request.path === '/amc/contracts') {
        return ok({ items: [makeContract({ id: '100', amcReference: 'AMC-0100', validTo: '2020-01-31', isPastValidity: true })], total: 1, page: 1, pageSize: 25, totals: { contractValue: '1620.000', finalCredit: '0.000' } })
      }
      return undefined
    })
  }

  it('sends the Validity filter and keeps the stored-status filter separate', async () => {
    const api = contractsApi()
    renderApp('/amc/contracts')

    await screen.findByText('AMC-0100')
    await userEvent.selectOptions(screen.getByLabelText('Validity'), 'expired')

    await waitFor(() => expect(api.find('GET', '/amc/contracts').some((request) => request.query.get('validity') === 'expired')).toBe(true))
    const last = api.find('GET', '/amc/contracts').at(-1)
    expect(last?.query.get('status')).toBe('all')
  })

  it('opens already filtered from ?validity=due', async () => {
    const api = contractsApi()
    renderApp('/amc/contracts?validity=due')

    await screen.findByText('AMC-0100')
    expect(api.find('GET', '/amc/contracts')[0]?.query.get('validity')).toBe('due')
    expect((screen.getByLabelText('Validity') as HTMLSelectElement).value).toBe('due')
  })

  it('hides and shows a column, remembering the choice, without touching other columns', async () => {
    contractsApi()
    renderApp('/amc/contracts')
    const headers = () => within(screen.getByRole('table')).getAllByRole('columnheader').map((cell) => cell.textContent?.trim())

    await screen.findByText('AMC-0100')
    const before = headers()
    // 2026-11-18: the register has no Contract (Upload Contract) column; Contract Value (ex VAT) stays.
    expect(before.some((header) => header?.replace(/[↕↑↓]/g, '').trim() === 'Contract')).toBe(false)
    expect(before.some((header) => header?.startsWith('Contract Value (ex VAT)'))).toBe(true)

    await userEvent.click(screen.getByRole('button', { name: /Columns/ }))
    expect(screen.queryByRole('checkbox', { name: 'Contract' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('checkbox', { name: 'Visits' }))
    await waitFor(() => expect(headers()).not.toContain('Visits'))
    expect(headers()).toEqual(before.filter((header) => header !== 'Visits'))
    expect(localStorage.getItem('stslev.amc-contracts.hidden-columns')).toBe('["visits"]')

    await userEvent.click(screen.getByRole('checkbox', { name: 'Visits' }))
    await waitFor(() => expect(headers()).toEqual(before))
  })

  it('ignores a remembered choice for the retired Contract column', async () => {
    localStorage.setItem('stslev.amc-contracts.hidden-columns', '["contract"]')
    contractsApi()
    renderApp('/amc/contracts')

    await screen.findByText('AMC-0100')
    expect(screen.getByRole('button', { name: /Columns/ })).toHaveTextContent('9/9')
  })
})

function serviceItem(overrides: Partial<ServiceStatusItem> = {}): ServiceStatusItem {
  return {
    id: '500',
    reference: 'AMC-0100',
    contract: { id: '100', status: 'ACTIVE', validTo: '2099-12-31' },
    client: { id: '10', name: 'Test Hotel One' },
    system: { description: 'FIRE', typeId: '1', typeName: 'Fire Alarm' },
    frequency: { code: 'QUARTERLY', label: 'Quarterly' },
    service: { sequenceNo: 1, cycleNo: 1, serviceCode: 'Q1' },
    periodStart: TODAY,
    periodEnd: TODAY,
    scheduledDate: TODAY,
    visitStatus: 'SCHEDULED',
    serviceStatus: 'NOT_COMPLETED',
    isOverdue: false,
    completedDate: null,
    salesEngineer: { id: '7', name: 'Sara Sales' },
    reportNumber: null,
    salesEngineerName: null,
    amcValue: '1620.000',
    serviceReport: null,
    locked: false,
    updatedAt: '2026-10-01T08:00:00.000Z',
    ...overrides,
  }
}

describe('Service Status: AMC Value and Sales Engineer Name', () => {
  function serviceApi(user: SessionUser, amcValueVisible: boolean, totals: ServiceStatusList['totals'] = null) {
    signIn()
    let item = serviceItem({ amcValue: amcValueVisible ? '1620.000' : null })

    return mockApi((request) => {
      if (request.path === '/auth/me') return ok({ user })
      if (request.path === '/amc/service-status/options') {
        return ok({ clients: [], salesEngineers: [], systemTypes: [], frequencies: [], years: [Number(TODAY.slice(0, 4))], reportNumberAvailable: true, serviceReportsAvailable: true })
      }
      if (request.method === 'GET' && request.path === '/amc/service-status') {
        const list: ServiceStatusList = {
          items: [item],
          total: 1,
          page: 1,
          pageSize: 50,
          kpis: { total: 1, completed: 0, notCompleted: 1, waitingForRenewal: 0 },
          reportNumberAvailable: true,
          serviceReportsAvailable: true,
          serviceReportLimits: { maxMb: 12, allowedTypes: 'PDF, DOC and DOCX' },
          salesEngineerNameAvailable: true,
          amcValueVisible,
          totals,
        }
        return ok(list)
      }
      if (request.method === 'PATCH' && request.path === '/amc/service-status/500') {
        const body = request.body as { salesEngineerName?: string }
        item = { ...item, salesEngineerName: body.salesEngineerName || null, updatedAt: '2026-10-02T08:00:00.000Z' }
        return ok(item)
      }
      return undefined
    })
  }

  const headers = () => within(screen.getByRole('table')).getAllByRole('columnheader').map((cell) => cell.textContent?.trim())

  it('shows the contract AMC Value to users who may view contracts', async () => {
    serviceApi(ADMIN, true)
    renderApp('/amc/service-status')

    await screen.findByRole('table')
    // Client UAT CR-021: "AMC Value (ex VAT)".
    expect(headers()).toContain('AMC Value (ex VAT)')
    expect(screen.getByText('1,620.000')).toBeInTheDocument()
  })

  it('shows the API totals under the value columns: Service Value summed, each contract’s AMC Value once (client UAT CR-028)', async () => {
    serviceApi(ADMIN, true, { services: 6, serviceValue: '2000.000', serviceValueMissing: 1, amcValue: '2000.000', contracts: 2 })
    renderApp('/amc/service-status')

    const footer = (await screen.findByRole('rowheader', { name: /Total Filtered \(6 services, all pages\)/ })).closest('tr') as HTMLElement
    expect(footer.querySelector('[data-total="amcValue"]')).toHaveTextContent('2,000.0002 contracts, each once')
    expect(footer.querySelector('[data-total="serviceValue"]')).toHaveTextContent('2,000.000')
    expect(footer).toHaveTextContent('1 service has no value set and is not included.')
    // The footer spans the table exactly.
    const table = screen.getByRole('table')
    const spanned = [...footer.children].reduce((sum, cell) => sum + (cell as HTMLTableCellElement).colSpan, 0)
    expect(spanned).toBe(within(table).getAllByRole('columnheader').length)
  })

  it('shows no totals row to users who may not view contracts', async () => {
    const executor: SessionUser = { ...ADMIN, id: '31', email: 'ops2@example.com', roles: [{ id: '9', code: 'CF', name: 'Ops' }], permissions: ['SERVICE_STATUS:VIEW', 'AMC_EXECUTION:VIEW'] }
    serviceApi(executor, false)
    renderApp('/amc/service-status')

    await screen.findByRole('table')
    expect(screen.queryByRole('rowheader', { name: /Total Filtered/ })).not.toBeInTheDocument()
  })

  it('does not offer the AMC Value column to users who may not view contracts', async () => {
    const executor: SessionUser = { ...ADMIN, id: '30', email: 'ops@example.com', roles: [{ id: '9', code: 'CF', name: 'Ops' }], permissions: ['SERVICE_STATUS:VIEW', 'AMC_EXECUTION:VIEW', 'AMC_EXECUTION:EDIT'] }
    serviceApi(executor, false)
    renderApp('/amc/service-status')

    await screen.findByRole('table')
    expect(headers()).not.toContain('AMC Value (ex VAT)')
    expect(screen.queryByText('1,620.000')).not.toBeInTheDocument()
  })

  it('saves the typed Service Engineer beside the report number and shows it after the save (client UAT CR-010)', async () => {
    const api = serviceApi(ADMIN, true)
    renderApp('/amc/service-status')

    const input = await screen.findByLabelText(/^Service Engineer of AMC-0100/)
    expect(headers().indexOf('Service Engineer')).toBe(headers().indexOf('Service Report No.') + 1)
    // The contract's engineer is the Sales Engineer, shown read only; "Name" is no longer in any heading.
    expect(headers()).toContain('Sales Engineer')
    expect(headers().some((heading) => heading?.includes('Engineer Name'))).toBe(false)
    expect(screen.queryByRole('textbox', { name: /^Sales Engineer/ })).not.toBeInTheDocument()
    await userEvent.type(input, '  Ahmed Al Balushi ')
    await userEvent.click(screen.getByRole('button', { name: /^Save AMC-0100/ }))

    // Saved through the unchanged API field, against this one service.
    await waitFor(() => expect(api.find('PATCH', '/amc/service-status/500')[0]?.body).toMatchObject({ salesEngineerName: 'Ahmed Al Balushi' }))
    await waitFor(() => expect((screen.getByLabelText(/^Service Engineer of AMC-0100/) as HTMLInputElement).value).toBe('Ahmed Al Balushi'))
  })
})

function accountsItem(overrides: Partial<AccountsItem> = {}): AccountsItem {
  return {
    id: '1',
    reference: 'AMC-0007',
    contract: { id: '7', status: 'ACTIVE' },
    client: { id: '10', name: 'Alpha Towers' },
    system: { description: 'FIRE', typeId: '3', typeName: 'Fire Alarm' },
    frequency: { code: 'QUARTERLY', label: 'Quarterly' },
    service: { sequenceNo: 1, cycleNo: 1, serviceCode: 'Q1' },
    scheduledDate: '2026-10-01',
    visitStatus: 'COMPLETED',
    serviceStatus: 'COMPLETED',
    completedDate: '2026-10-02',
    visitValue: '405.000',
    serviceReportNo: 'SR-1',
    invoiceNumbers: ['ZB-1'],
    invoiceValue: '100.001',
    manualInvoiceNo: null,
    paymentStatus: 'UNPAID',
    paidAt: null,
    updatedAt: '2026-10-01T08:00:00.000Z',
    salesEngineer: null,
    serviceReport: { id: '90', originalName: 'q1-report.pdf', mimeType: 'application/pdf', sizeBytes: 10, uploadedAt: '2026-10-02T08:00:00.000Z' },
    colour: 'BLUE',
    ...overrides,
  }
}

describe('Accounts: Service Report viewer and filtered totals', () => {
  const VIEWER: SessionUser = { ...ADMIN, id: '7', email: 'acc@example.com', roles: [{ id: '2', code: 'ACCOUNTANT', name: 'Accountant' }], permissions: ['ACCOUNTS:VIEW'] }
  const NO_REPORT = accountsItem({ id: '2', reference: 'AMC-0008', serviceReport: null, invoiceNumbers: [], invoiceValue: null, visitValue: null, valueSourceMissing: true })

  function accountsApi() {
    signIn()
    return mockApi((request) => {
      if (request.path === '/auth/me') return ok({ user: VIEWER })
      if (request.path === '/accounts/options') return ok({ clients: [], salesEngineers: [], contracts: [], years: [2026] })
      if (request.path === '/accounts') {
        return ok({
          items: [accountsItem(), NO_REPORT],
          total: 120,
          page: 1,
          pageSize: 50,
          kpis: { rows: 120, completed: 2, notCompleted: 118, invoiceFilled: 0, totalValue: '48600.000', valueMissing: 1, paidValue: '0.000', invoiceValue: '300.003', invoiced: 2, red: 118, blue: 2, green: 0 },
        })
      }
      if (request.path === '/accounts/1/report') return ok('%PDF-1.4')
      return undefined
    })
  }

  it('shows View and Download in a Service Report column after the Service Report No., and "Not uploaded" without a report', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:report'), revokeObjectURL: vi.fn() }))
    const saved: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download)
    })
    const api = accountsApi()
    renderApp('/finance/accounts')

    await screen.findByText('AMC-0007')
    const headers = within(screen.getByRole('table')).getAllByRole('columnheader').map((cell) => cell.textContent?.trim())
    const reportAt = headers.indexOf('Service Report')
    expect(reportAt).toBe(headers.indexOf('Service Report No.') + 1)

    const cellsOf = (reference: string) => [...(screen.getByText(reference).closest('tr') as HTMLElement).querySelectorAll('td')]
    // The report number stands alone, with no icon beneath it.
    const numberCell = cellsOf('AMC-0007')[headers.indexOf('Service Report No.')] as HTMLElement
    expect(within(numberCell).queryByRole('button')).not.toBeInTheDocument()

    const reportCell = within(cellsOf('AMC-0007')[reportAt] as HTMLElement)
    expect(reportCell.getByRole('button', { name: /^View Service Report for AMC-0007/ })).toBeInTheDocument()
    expect(cellsOf('AMC-0008')[reportAt]).toHaveTextContent('Not uploaded')
    expect(within(cellsOf('AMC-0008')[reportAt] as HTMLElement).queryByRole('button')).not.toBeInTheDocument()

    await userEvent.click(reportCell.getByRole('button', { name: /^Download Service Report for AMC-0007/ }))
    await waitFor(() => expect(saved).toEqual(['q1-report.pdf']))
    expect(api.find('GET', '/accounts/1/report')).toHaveLength(1)
  })

  it('opens the report in a read-only viewer with Download inside it', async () => {
    const created = vi.fn(() => 'blob:report')
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const api = accountsApi()
    renderApp('/finance/accounts')

    await screen.findByText('AMC-0007')
    await userEvent.click(screen.getByRole('button', { name: /^View Service Report for AMC-0007/ }))
    const dialog = await screen.findByRole('dialog', { name: /Service Report · AMC-0007/ })
    await waitFor(() => expect(within(dialog).getByTitle(/Service report for AMC-0007/)).toHaveAttribute('src', 'blob:report'))
    expect(api.find('GET', '/accounts/1/report')).toHaveLength(1)

    await userEvent.click(within(dialog).getByRole('button', { name: /^Download service report/ }))
    expect(click).toHaveBeenCalled()
  })

  it('shows the filtered totals over every page, keeping service value and invoice value apart', async () => {
    accountsApi()
    renderApp('/finance/accounts')

    await screen.findByText('AMC-0007')
    // Zoho Invoice Value (and its total) is hidden by default: show it first.
    await userEvent.click(screen.getByRole('button', { name: /Hide Columns/ }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('checkbox', { name: 'Zoho Invoice Value (ex VAT)' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Apply' }))
    const footer = screen.getByRole('rowheader', { name: /Total Filtered \(120 services, all pages\)/ }).closest('tr') as HTMLElement
    expect(footer).toHaveTextContent('Total Filtered Service Value (ex VAT)')
    expect(footer).toHaveTextContent('48,600.000')
    expect(footer).toHaveTextContent('Total Filtered Invoice Value (ex VAT)')
    expect(footer).toHaveTextContent('300.003')
    expect(footer).toHaveTextContent('1 service has no value set')
    expect(screen.getByText('No Billing Basis or Cost per Visit on the contract')).toBeInTheDocument()
  })
})

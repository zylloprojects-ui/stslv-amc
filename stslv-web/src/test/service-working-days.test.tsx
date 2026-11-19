import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { todayIso } from '../pages/amc/amcFormat'
import type { ServiceStatusItem, ServiceStatusList } from '../pages/amc/serviceStatusTypes'
import type { SessionUser } from '../lib/types'
import { ADMIN, mockApi, ok, renderApp, signIn } from './helpers'

// Number of Working Days on Service Status (database update 0121, 2026-11-19): typed by hand per service, never
// calculated from dates. Every record here is invented.

const TODAY = todayIso()

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
    salesEngineer: null,
    reportNumber: null,
    salesEngineerName: null,
    workingDays: null,
    serviceReport: null,
    locked: false,
    updatedAt: '2026-10-01T08:00:00.000Z',
    ...overrides,
  }
}

const VIEW_ONLY: SessionUser = {
  ...ADMIN,
  id: '40',
  email: 'viewer-wd@example.com',
  roles: [{ id: '9', code: 'CF', name: 'Viewer' }],
  permissions: ['SERVICE_STATUS:VIEW', 'AMC_SCHEDULE:VIEW'],
}

function serviceApi(user: SessionUser, start: Partial<ServiceStatusItem> = {}, workingDaysAvailable = true) {
  signIn()
  let item = serviceItem(start)

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
        workingDaysAvailable,
        amcValueVisible: false,
        totals: null,
      }
      return ok(list)
    }
    if (request.method === 'GET' && request.path === '/amc/service-status/500') return ok(item)
    if (request.method === 'PATCH' && request.path === '/amc/service-status/500') {
      const body = request.body as { workingDays?: number | null }
      item = { ...item, ...(body.workingDays !== undefined ? { workingDays: body.workingDays } : {}), updatedAt: '2026-10-02T08:00:00.000Z' }
      return ok(item)
    }
    return undefined
  })
}

const headers = () => within(screen.getByRole('table')).getAllByRole('columnheader').map((cell) => cell.textContent?.trim())
const input = () => screen.findByLabelText(/^Number of Working Days of AMC-0100/) as Promise<HTMLInputElement>
const saveButton = () => screen.getByRole('button', { name: /^Save AMC-0100/ })

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('Service Status: Number of Working Days', () => {
  it('is blank on an existing service and sits after the Service Engineer', async () => {
    serviceApi(ADMIN)
    renderApp('/amc/service-status')

    expect((await input()).value).toBe('')
    expect(headers().indexOf('Number of Working Days')).toBe(headers().indexOf('Service Engineer') + 1)
    expect(saveButton()).toBeDisabled()
  })

  it('saves a whole number against this service and shows it after the save', async () => {
    const api = serviceApi(ADMIN)
    renderApp('/amc/service-status')

    await userEvent.type(await input(), ' 3 ')
    await userEvent.click(saveButton())

    await waitFor(() => expect(api.find('PATCH', '/amc/service-status/500')[0]?.body).toEqual({ workingDays: 3, expectedUpdatedAt: '2026-10-01T08:00:00.000Z' }))
    await waitFor(async () => expect((await input()).value).toBe('3'))
  })

  it('edits a saved value and clears it with an empty box', async () => {
    const api = serviceApi(ADMIN, { workingDays: 4 })
    renderApp('/amc/service-status')

    const box = await input()
    expect(box.value).toBe('4')
    await userEvent.clear(box)
    await userEvent.type(box, '0')
    await userEvent.click(saveButton())
    await waitFor(() => expect(api.find('PATCH', '/amc/service-status/500')[0]?.body).toMatchObject({ workingDays: 0 }))

    await waitFor(async () => expect((await input()).value).toBe('0'))
    await userEvent.clear(await input())
    await userEvent.click(saveButton())
    await waitFor(() => expect(api.find('PATCH', '/amc/service-status/500')[1]?.body).toMatchObject({ workingDays: null }))
  })

  it('takes at most four digits (the API refuses anything above 9999)', async () => {
    serviceApi(ADMIN)
    renderApp('/amc/service-status')

    const box = await input()
    await userEvent.type(box, '10000')
    expect(box.value).toBe('1000')
  })

  it.each(['-1', '1.5', 'abc', '1e3', '+5'])('refuses %s without calling the API', async (typed) => {
    const api = serviceApi(ADMIN)
    renderApp('/amc/service-status')

    await userEvent.type(await input(), typed)
    await userEvent.click(saveButton())

    expect(await screen.findByText('Number of Working Days must be a whole number from 0 to 9999.')).toBeInTheDocument()
    expect(api.find('PATCH', '/amc/service-status/500')).toHaveLength(0)
  })

  it('is read only without the save permission', async () => {
    serviceApi(VIEW_ONLY, { workingDays: 5 })
    renderApp('/amc/service-status')

    await screen.findByRole('table')
    expect(headers()).toContain('Number of Working Days')
    expect(screen.queryByLabelText(/^Number of Working Days of AMC-0100/)).not.toBeInTheDocument()
    expect(within(screen.getByRole('table')).getByText('5')).toBeInTheDocument()
  })

  it('is shown in the View dialog', async () => {
    serviceApi(ADMIN, { workingDays: 6 })
    renderApp('/amc/service-status')

    await screen.findByRole('table')
    await userEvent.click(screen.getByRole('button', { name: /^View AMC-0100/ }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('Number of Working Days')).toBeInTheDocument()
    expect(within(dialog).getByText('6')).toBeInTheDocument()
  })

  it('is not offered by an API without database update 0121', async () => {
    serviceApi(ADMIN, {}, false)
    renderApp('/amc/service-status')

    await screen.findByRole('table')
    expect(headers()).not.toContain('Number of Working Days')
  })
})

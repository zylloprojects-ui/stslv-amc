import type { Contract, ExecutionVisit, SchedulePreview, ScheduleVisit } from '../pages/amc/types'
import type { SessionUser } from '../lib/types'
import { fail, makeClient, mockApi, ok, signIn, type MockReply, type MockRequest } from './helpers'

/** The seeded Execution role: sees contracts and the schedule, updates execution only. */
export const EXECUTION: SessionUser = {
  id: '3',
  email: 'execution@example.com',
  fullName: 'Esa Execution',
  roles: [{ id: '4', code: 'EXECUTION', name: 'Execution' }],
  permissions: ['DASHBOARD:VIEW', 'CLIENTS:VIEW', 'AMC_CONTRACTS:VIEW', 'AMC_SCHEDULE:VIEW', 'AMC_EXECUTION:VIEW', 'AMC_EXECUTION:EDIT'],
}

/** A role that can only look. */
export const VIEWER: SessionUser = {
  id: '4',
  email: 'viewer@example.com',
  fullName: 'Vera Viewer',
  roles: [{ id: '5', code: 'INVOICING', name: 'Invoicing' }],
  permissions: ['DASHBOARD:VIEW', 'CLIENTS:VIEW', 'AMC_CONTRACTS:VIEW', 'AMC_SCHEDULE:VIEW', 'AMC_EXECUTION:VIEW'],
}

export const CLIENTS = [makeClient({ id: '10', name: 'Test Hotel One' }), makeClient({ id: '11', name: 'Test Hotel Two' })]

export function makeContract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: '100',
    client: { id: '10', name: 'Test Hotel One', isActive: true },
    responsibleEngineer: 'Test Engineer',
    validFrom: '2027-01-01',
    validTo: '2027-12-31',
    systemDescription: 'FIRE',
    description: null,
    contractValue: '1620.000',
    finalCredit: null,
    maintenanceFrequency: 'QUARTERLY',
    defaultVisitAmount: '405.000',
    status: 'ACTIVE',
    isPastValidity: false,
    scheduleCutoverDate: null,
    notes: null,
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T08:00:00.000Z',
    schedule: {
      visitCount: 4,
      completedCount: 1,
      openCount: 3,
      historicalCount: 0,
      cancelledCount: 0,
      amountMissingCount: 0,
      scheduledTotal: '1620.000',
      valueDifference: '0.000',
    },
    ...overrides,
  }
}

export function makeVisit(overrides: Partial<ScheduleVisit> = {}): ScheduleVisit {
  return {
    id: '500',
    contract: { id: '100', status: 'ACTIVE', systemDescription: 'FIRE', maintenanceFrequency: 'QUARTERLY' },
    client: { id: '10', name: 'Test Hotel One' },
    sequenceNo: 1,
    periodStart: '2027-01-01',
    periodEnd: '2027-03-31',
    originalScheduledDate: '2027-01-01',
    scheduledDate: '2027-01-01',
    isRescheduled: false,
    isOverdue: false,
    assignedTo: 'Test Engineer',
    assignedToOverride: null,
    status: 'SCHEDULED',
    completedDate: null,
    completedBy: null,
    workPerformed: null,
    executionNotes: null,
    statusReason: null,
    notes: null,
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T08:00:00.000Z',
    visitAmount: '405.000',
    amountIsCustom: false,
    invoiceEligibility: 'NOT_COMPLETED',
    ...overrides,
  }
}

/** What the execution endpoints return: the visit without amount or invoicing state. */
function toExecution(visit: ScheduleVisit): ExecutionVisit {
  const { visitAmount: _amount, amountIsCustom: _custom, invoiceEligibility: _eligibility, ...rest } = visit

  return rest
}

const OUTSTANDING = ['SCHEDULED', 'IN_PROGRESS', 'POSTPONED']

interface AmcApiOptions {
  contracts?: Contract[]
  visits?: ScheduleVisit[]
  preview?: SchedulePreview
  override?: (request: MockRequest) => MockReply | undefined
}

/**
 * A small in-memory stand-in for the AMC API, so that what a test saves is
 * reflected in the lists requested afterwards.
 */
export function amcApi(user: SessionUser, options: AmcApiOptions = {}) {
  const contracts = [...(options.contracts ?? [])]
  const visits = [...(options.visits ?? [])]

  signIn()

  return mockApi((request) => {
    const overridden = options.override?.(request)
    if (overridden) return overridden

    const { method, path, query } = request
    const body = (request.body ?? {}) as Record<string, unknown>

    if (path === '/auth/me') return ok({ user })
    if (method === 'GET' && path === '/clients') return ok({ items: CLIENTS, total: CLIENTS.length, page: 1, pageSize: 100 })
    if (method === 'GET' && path === '/amc/contracts/systems') return ok([...new Set(contracts.map((contract) => contract.systemDescription))])

    // --- Contracts ---
    if (method === 'GET' && path === '/amc/contracts') {
      const status = query.get('status') ?? 'all'
      const search = (query.get('search') ?? '').toLowerCase()
      const items = contracts
        .filter((contract) => status === 'all' || contract.status === status)
        .filter((contract) => `${contract.client.name} ${contract.systemDescription}`.toLowerCase().includes(search))

      return ok({ items, total: items.length, page: 1, pageSize: 25 })
    }
    if (method === 'POST' && path === '/amc/contracts') {
      const client = CLIENTS.find((item) => item.id === body.clientId)
      const created = makeContract({
        ...(body as Partial<Contract>),
        id: '199',
        client: { id: String(body.clientId), name: client?.name ?? 'Unknown', isActive: true },
        responsibleEngineer: (body.responsibleEngineer as string) || null,
        finalCredit: (body.finalCredit as string) || null,
        defaultVisitAmount: (body.defaultVisitAmount as string) || null,
      })
      contracts.push(created)

      return ok({ ...created, scheduleChange: created.status === 'ACTIVE' ? { created: 4, removed: 0, kept: 0 } : null }, 201)
    }

    const contractMatch = /^\/amc\/contracts\/(\d+)(\/.*)?$/.exec(path)

    if (contractMatch) {
      const index = contracts.findIndex((contract) => contract.id === contractMatch[1])
      const contract = contracts[index]
      const rest = contractMatch[2] ?? ''

      if (!contract) return fail(404, 'NOT_FOUND', 'AMC contract not found.')
      if (method === 'GET' && rest === '') return ok(contract)
      if (method === 'GET' && rest === '/schedule/preview') {
        return ok(
          options.preview ?? {
            validFrom: query.get('validFrom'),
            validTo: query.get('validTo'),
            maintenanceFrequency: query.get('maintenanceFrequency'),
            canApply: true,
            blockedReason: null,
            toCreate: [],
            toRemove: [],
            keptCount: 4,
            blocking: [],
          },
        )
      }
      if (method === 'PATCH' && rest === '') {
        contracts[index] = { ...contract, ...(body as Partial<Contract>) }

        return ok({ ...contracts[index], scheduleChange: options.preview ? { created: options.preview.toCreate.length, removed: options.preview.toRemove.length, kept: options.preview.keptCount } : null })
      }
      if (method === 'POST' && rest === '/status') {
        contracts[index] = { ...contract, status: body.status as Contract['status'] }

        return ok({ ...contracts[index], scheduleChange: null, cancelledVisits: body.cancelOpenVisits ? contract.schedule.openCount : 0 })
      }
    }

    // --- Schedule ---
    if (method === 'GET' && path === '/amc/visits') {
      const from = query.get('from')
      const to = query.get('to')
      const items = visits
        .filter((visit) => (!from || visit.scheduledDate >= from) && (!to || visit.scheduledDate <= to))
        .filter((visit) => !query.get('clientId') || visit.client.id === query.get('clientId'))
        .filter((visit) => !query.get('contractId') || visit.contract.id === query.get('contractId'))
        .filter((visit) => !query.get('status') || visit.status === query.get('status'))
        .filter((visit) => !query.get('invoiceEligibility') || visit.invoiceEligibility === query.get('invoiceEligibility'))

      return ok({ items, total: items.length, page: 1, pageSize: 50, totals: { visitAmount: '810.000', amountMissingCount: 0 } })
    }

    const visitMatch = /^\/amc\/(execution\/)?visits\/(\d+)$/.exec(path)

    if (visitMatch) {
      const index = visits.findIndex((visit) => visit.id === visitMatch[2])
      const visit = visits[index]
      const execution = visitMatch[1] !== undefined

      if (!visit) return fail(404, 'NOT_FOUND', 'AMC visit not found.')
      if (method === 'GET') return ok(execution ? toExecution(visit) : visit)
      if (method === 'PATCH' && !execution) {
        visits[index] = {
          ...visit,
          visitAmount: body.visitAmount === '' ? null : ((body.visitAmount as string | undefined) ?? visit.visitAmount),
          scheduledDate: (body.scheduledDate as string | undefined) ?? visit.scheduledDate,
          notes: (body.notes as string) || null,
        }

        return ok(visits[index])
      }
      if (method === 'PATCH' && execution) {
        const status = (body.status as ScheduleVisit['status'] | undefined) ?? visit.status

        visits[index] = {
          ...visit,
          status,
          isOverdue: status === 'SCHEDULED' || status === 'POSTPONED' ? visit.isOverdue : false,
          completedDate: status === 'COMPLETED' ? ((body.completedDate as string | undefined) ?? visit.completedDate) : null,
          scheduledDate: (body.scheduledDate as string | undefined) ?? visit.scheduledDate,
          workPerformed: (body.workPerformed as string) || null,
          executionNotes: (body.executionNotes as string) || null,
          statusReason: (body.statusReason as string) || null,
        }

        const saved = visits[index] as ScheduleVisit
        saved.isRescheduled = saved.scheduledDate !== saved.originalScheduledDate

        return ok(toExecution(saved))
      }
    }

    // --- Execution ---
    if (method === 'GET' && path === '/amc/execution/visits') {
      const scope = query.get('scope') ?? 'due'
      const items = visits
        .filter((visit) => {
          if (scope === 'completed') return visit.status === 'COMPLETED'
          if (scope === 'all') return true
          return OUTSTANDING.includes(visit.status)
        })
        .map(toExecution)

      return ok({ items, total: items.length, page: 1, pageSize: 50 })
    }

    return undefined
  })
}

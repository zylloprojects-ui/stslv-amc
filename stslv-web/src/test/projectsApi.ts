import { previewVat } from '../lib/money'
import type { Expense, ExpenseCategory, InvoiceState, ProcurementRequest, Project, ProjectStatus } from '../lib/projectTypes'
import type { Client, SessionUser } from '../lib/types'
import { fail, makeClient, mockApi, ok, signIn, type MockReply, type MockRequest } from './helpers'

// A small in-memory stand-in for the Projects, Procurement and Expenses API,
// so that what a test creates or changes is reflected in later requests. It
// plays the server's part in tests only: the derived figures it returns are
// what the screens must display, never something the screens work out.

const toThousandths = (value: string): bigint => {
  const negative = value.startsWith('-')
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.')
  const amount = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'))

  return negative ? -amount : amount
}

const fromThousandths = (value: bigint): string => {
  const digits = (value < 0n ? -value : value).toString().padStart(4, '0')

  return `${value < 0n ? '-' : ''}${digits.slice(0, -3)}.${digits.slice(-3)}`
}

const canonical = (value: string) => fromThousandths(toThousandths(value))

const TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  NEW: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: ['IN_PROGRESS'],
  CANCELLED: ['NEW'],
  HISTORICAL: [],
}

export const CATEGORIES: ExpenseCategory[] = [
  { id: '1', code: 'MATERIALS', name: 'Materials', isActive: true },
  { id: '2', code: 'LABOUR', name: 'Labour', isActive: true },
  { id: '3', code: 'OTHER', name: 'Other', isActive: true },
]

export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: '100',
    jobNumber: 'GPSA0001',
    clientId: '10',
    clientName: 'Test Client One',
    description: 'Fire alarm panel replacement',
    jobDate: '2026-09-01',
    jobDatePrecision: 'DAY',
    legacyStatus: null,
    lpoNumber: null,
    lpoDate: null,
    jobValue: '1000.000',
    vatRate: '5.000',
    vatAmount: '50.000',
    grandValue: '1050.000',
    budgetAmount: null,
    status: 'NEW',
    completedDate: null,
    notes: null,
    allowedStatuses: TRANSITIONS.NEW,
    invoiceState: 'NOT_READY',
    readyForInvoice: false,
    trackedExpenses: '0.000',
    operationalJobMargin: '1000.000',
    budgetRemaining: null,
    createdAt: '2026-09-01T08:00:00.000Z',
    updatedAt: '2026-09-01T08:00:00.000Z',
    ...overrides,
  }
}

export function makeProcurement(overrides: Partial<ProcurementRequest> = {}): ProcurementRequest {
  return {
    id: '200',
    projectId: '100',
    jobNumber: 'GPSA0001',
    projectDescription: 'Fire alarm panel replacement',
    clientName: 'Test Client One',
    reference: null,
    description: 'Smoke detectors',
    requestDate: '2026-09-05',
    supplierName: 'Test Supplier',
    quotationReference: 'Q-1',
    quotationDate: null,
    quotationAmount: '412.500',
    poReference: null,
    orderDate: null,
    expectedDeliveryDate: null,
    deliveredDate: null,
    status: 'REQUESTED',
    notes: null,
    createdAt: '2026-09-05T08:00:00.000Z',
    updatedAt: '2026-09-05T08:00:00.000Z',
    ...overrides,
  }
}

export function makeExpense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: '300',
    projectId: '100',
    jobNumber: 'GPSA0001',
    projectDescription: 'Fire alarm panel replacement',
    clientName: 'Test Client One',
    categoryId: '1',
    categoryCode: 'MATERIALS',
    categoryName: 'Materials',
    expenseDate: '2026-09-10',
    description: 'Cable and conduit',
    payeeName: 'Test Supplier',
    amount: '250.125',
    paymentReference: 'TRF-1',
    notes: null,
    isVoided: false,
    voidedAt: null,
    voidReason: null,
    createdAt: '2026-09-10T08:00:00.000Z',
    updatedAt: '2026-09-10T08:00:00.000Z',
    ...overrides,
  }
}

interface Seed {
  projects?: Project[]
  procurement?: ProcurementRequest[]
  expenses?: Expense[]
  clients?: Client[]
}

type Override = (request: MockRequest) => MockReply | undefined

export function projectsApi(user: SessionUser, seed: Seed = {}, override?: Override) {
  const projects = [...(seed.projects ?? [])]
  const procurement = [...(seed.procurement ?? [])]
  const expenses = [...(seed.expenses ?? [])]
  const clients = seed.clients ?? [makeClient()]
  const showCosts = user.permissions.includes('EXPENSES:VIEW')
  let nextId = 900

  const invoiceState = (project: Project): InvoiceState => {
    if (project.status === 'HISTORICAL') return 'HISTORICAL'
    if (project.status === 'CANCELLED') return 'NOT_APPLICABLE'
    if (project.status !== 'COMPLETED') return 'NOT_READY'

    return toThousandths(project.jobValue) === 0n ? 'NO_INVOICE_REQUIRED' : 'READY_FOR_INVOICE'
  }

  // The server's derived figures: VAT from value and rate, costs from the expense rows.
  const derive = (project: Project): Project => {
    const vat = previewVat(project.jobValue, project.vatRate) ?? { vatAmount: '0.000', grandValue: project.jobValue }
    const tracked = expenses
      .filter((expense) => expense.projectId === project.id && !expense.isVoided)
      .reduce((sum, expense) => sum + toThousandths(expense.amount), 0n)
    const state = invoiceState(project)

    return {
      ...project,
      vatAmount: vat.vatAmount,
      grandValue: vat.grandValue,
      allowedStatuses: TRANSITIONS[project.status],
      invoiceState: state,
      readyForInvoice: state === 'READY_FOR_INVOICE',
      trackedExpenses: showCosts ? fromThousandths(tracked) : null,
      operationalJobMargin: showCosts ? fromThousandths(toThousandths(project.jobValue) - tracked) : null,
      budgetRemaining: showCosts && project.budgetAmount !== null ? fromThousandths(toThousandths(project.budgetAmount) - tracked) : null,
    }
  }

  const projectFields = (body: Record<string, string>) => ({
    ...(body.clientId !== undefined
      ? { clientId: body.clientId, clientName: clients.find((client) => client.id === body.clientId)?.name ?? 'Unknown' }
      : {}),
    ...(body.description !== undefined ? { description: body.description } : {}),
    ...(body.jobDate !== undefined ? { jobDate: body.jobDate } : {}),
    ...(body.lpoNumber !== undefined ? { lpoNumber: body.lpoNumber || null } : {}),
    ...(body.lpoDate !== undefined ? { lpoDate: body.lpoDate || null } : {}),
    ...(body.jobValue !== undefined ? { jobValue: canonical(body.jobValue) } : {}),
    ...(body.vatRate !== undefined ? { vatRate: canonical(body.vatRate) } : {}),
    ...(body.budgetAmount !== undefined ? { budgetAmount: body.budgetAmount ? canonical(body.budgetAmount) : null } : {}),
    ...(body.notes !== undefined ? { notes: body.notes || null } : {}),
  })

  const projectOf = (projectId: string) => {
    const project = projects.find((item) => item.id === projectId)

    return { projectId, jobNumber: project?.jobNumber ?? '?', projectDescription: project?.description ?? '?', clientName: project?.clientName ?? '?' }
  }

  const nullable = (body: Record<string, string>, fields: string[]) =>
    Object.fromEntries(fields.filter((field) => body[field] !== undefined).map((field) => [field, body[field] || null]))

  signIn()

  const api = mockApi((request) => {
    const overridden = override?.(request)
    if (overridden) return overridden

    const { method, path, query } = request
    const body = (request.body ?? {}) as Record<string, string>
    const [, resource, id, action] = path.split('/')

    if (path === '/auth/me') return ok({ user })

    if (method === 'GET' && path === '/clients') {
      const items = clients.filter((client) => client.isActive)
      return ok({ items, total: items.length, page: 1, pageSize: 100 })
    }

    if (resource === 'projects') {
      if (method === 'GET' && id === undefined) {
        const search = (query.get('search') ?? '').toLowerCase()
        const items = projects
          .map(derive)
          .filter((project) => !query.get('status') || project.status === query.get('status'))
          .filter((project) => !query.get('invoiceState') || project.invoiceState === query.get('invoiceState'))
          .filter((project) => `${project.jobNumber} ${project.clientName} ${project.description}`.toLowerCase().includes(search))

        return ok({ items, total: items.length, page: 1, pageSize: 25 })
      }
      if (method === 'GET' && id === 'options') {
        return ok(projects.map(({ id: projectId, jobNumber, description, clientName, status }) => ({ id: projectId, jobNumber, description, clientName, status })))
      }
      if (method === 'GET' && id === 'defaults') {
        return ok({ defaultVatRate: '5.000', nextJobNumber: `GPSA${String(projects.length + 1).padStart(4, '0')}` })
      }
      if (method === 'POST' && id === undefined) {
        const created = makeProject({
          id: String((nextId += 1)),
          jobNumber: `GPSA${String(projects.length + 1).padStart(4, '0')}`,
          ...projectFields(body),
        })
        projects.push(created)
        return ok(derive(created), 201)
      }

      const index = projects.findIndex((project) => project.id === id)
      const project = projects[index]

      if (!project) return fail(404, 'NOT_FOUND', 'Project not found.')
      if (method === 'GET') return ok(derive(project))
      if (method === 'PATCH') {
        projects[index] = { ...project, ...projectFields(body) }
        return ok(derive(projects[index]))
      }
      if (method === 'POST' && action === 'status') {
        const status = body.status as ProjectStatus
        projects[index] = { ...project, status, completedDate: status === 'COMPLETED' ? (body.completedDate ?? '2026-10-01') : null }
        return ok(derive(projects[index]))
      }
    }

    if (resource === 'procurement') {
      if (method === 'GET' && id === undefined) {
        const search = (query.get('search') ?? '').toLowerCase()
        const items = procurement
          .filter((item) => !query.get('projectId') || item.projectId === query.get('projectId'))
          .filter((item) => !query.get('status') || item.status === query.get('status'))
          .filter((item) => `${item.description} ${item.supplierName ?? ''} ${item.jobNumber}`.toLowerCase().includes(search))

        return ok({ items, total: items.length, page: 1, pageSize: 25 })
      }

      const optional = ['reference', 'supplierName', 'quotationReference', 'quotationDate', 'poReference', 'orderDate', 'expectedDeliveryDate', 'notes']
      const fields = () => ({
        ...nullable(body, optional),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.requestDate !== undefined ? { requestDate: body.requestDate } : {}),
        ...(body.quotationAmount !== undefined ? { quotationAmount: body.quotationAmount ? canonical(body.quotationAmount) : null } : {}),
      })

      if (method === 'POST' && id === undefined) {
        const created = makeProcurement({
          id: String((nextId += 1)),
          supplierName: null,
          quotationReference: null,
          quotationAmount: null,
          ...projectOf(body.projectId ?? ''),
          ...fields(),
        })
        procurement.push(created)
        return ok(created, 201)
      }

      const index = procurement.findIndex((item) => item.id === id)
      const item = procurement[index]

      if (!item) return fail(404, 'NOT_FOUND', 'Procurement request not found.')
      if (method === 'GET') return ok(item)
      if (method === 'PATCH') {
        procurement[index] = { ...item, ...fields() }
        return ok(procurement[index])
      }
      if (method === 'POST' && action === 'status') {
        procurement[index] = {
          ...item,
          status: body.status as ProcurementRequest['status'],
          deliveredDate: body.status === 'DELIVERED' ? (body.deliveredDate ?? '2026-10-01') : null,
        }
        return ok(procurement[index])
      }
    }

    if (resource === 'expenses') {
      if (method === 'GET' && id === 'categories') return ok(CATEGORIES)
      if (method === 'GET' && id === undefined) {
        const search = (query.get('search') ?? '').toLowerCase()
        const items = expenses
          .filter((item) => query.get('includeVoided') === 'true' || !item.isVoided)
          .filter((item) => !query.get('projectId') || item.projectId === query.get('projectId'))
          .filter((item) => !query.get('categoryId') || item.categoryId === query.get('categoryId'))
          .filter((item) => !query.get('dateFrom') || item.expenseDate >= (query.get('dateFrom') ?? ''))
          .filter((item) => !query.get('dateTo') || item.expenseDate <= (query.get('dateTo') ?? ''))
          .filter((item) => `${item.description} ${item.payeeName ?? ''} ${item.jobNumber}`.toLowerCase().includes(search))
        const total = items.filter((item) => !item.isVoided).reduce((sum, item) => sum + toThousandths(item.amount), 0n)

        return ok({ items, total: items.length, totalAmount: fromThousandths(total), page: 1, pageSize: 25 })
      }

      const fields = () => {
        const category = CATEGORIES.find((item) => item.id === body.categoryId)

        return {
          ...nullable(body, ['payeeName', 'paymentReference', 'notes']),
          ...(body.projectId !== undefined ? projectOf(body.projectId) : {}),
          ...(category ? { categoryId: category.id, categoryCode: category.code, categoryName: category.name } : {}),
          ...(body.expenseDate !== undefined ? { expenseDate: body.expenseDate } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.amount !== undefined ? { amount: canonical(body.amount) } : {}),
        }
      }

      if (method === 'POST' && id === undefined) {
        const created = makeExpense({ id: String((nextId += 1)), payeeName: null, paymentReference: null, ...fields() })
        expenses.push(created)
        return ok(created, 201)
      }

      const index = expenses.findIndex((item) => item.id === id)
      const item = expenses[index]

      if (!item) return fail(404, 'NOT_FOUND', 'Expense not found.')
      if (method === 'GET') return ok(item)
      if (method === 'PATCH') {
        expenses[index] = { ...item, ...fields() }
        return ok(expenses[index])
      }
      if (method === 'POST' && action === 'void') {
        expenses[index] = { ...item, isVoided: true, voidedAt: '2026-10-01T09:00:00.000Z', voidReason: body.reason ?? null }
        return ok(expenses[index])
      }
    }

    return undefined
  })

  return api
}

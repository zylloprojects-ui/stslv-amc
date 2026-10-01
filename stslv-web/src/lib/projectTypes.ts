// Types for Projects, Procurement and Project Expenses, as returned by the API.
// Money and rates are decimal strings with three decimals; dates are YYYY-MM-DD.

// PROVISIONAL status lists: the business has not confirmed them.
export const PROJECT_STATUSES = ['NEW', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  NEW: 'New',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
}

export type InvoiceState = 'NOT_READY' | 'READY_FOR_INVOICE' | 'NO_INVOICE_REQUIRED' | 'NOT_APPLICABLE'

export interface Project {
  id: string
  jobNumber: string
  clientId: string
  clientName: string
  description: string
  jobDate: string
  lpoNumber: string | null
  lpoDate: string | null
  /** Excluding VAT. */
  jobValue: string
  vatRate: string
  vatAmount: string
  grandValue: string
  budgetAmount: string | null
  status: ProjectStatus
  completedDate: string | null
  notes: string | null
  allowedStatuses: ProjectStatus[]
  invoiceState: InvoiceState
  readyForInvoice: boolean
  /** Null when the signed-in user may not view expenses. */
  trackedExpenses: string | null
  operationalJobMargin: string | null
  budgetRemaining: string | null
  createdAt: string
  updatedAt: string
}

export interface ProjectOption {
  id: string
  jobNumber: string
  description: string
  clientName: string
  status: ProjectStatus
}

export interface ProjectDefaults {
  defaultVatRate: string
  nextJobNumber: string
}

export const PROCUREMENT_STATUSES = ['REQUESTED', 'QUOTED', 'ORDERED', 'DELIVERED', 'CANCELLED'] as const
export type ProcurementStatus = (typeof PROCUREMENT_STATUSES)[number]

export const PROCUREMENT_STATUS_LABELS: Record<ProcurementStatus, string> = {
  REQUESTED: 'Requested',
  QUOTED: 'Quoted',
  ORDERED: 'Ordered',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
}

export interface ProcurementRequest {
  id: string
  projectId: string
  jobNumber: string
  projectDescription: string
  clientName: string
  reference: string | null
  description: string
  requestDate: string
  supplierName: string | null
  quotationReference: string | null
  quotationDate: string | null
  quotationAmount: string | null
  poReference: string | null
  orderDate: string | null
  expectedDeliveryDate: string | null
  deliveredDate: string | null
  status: ProcurementStatus
  notes: string | null
  createdAt: string
  updatedAt: string
}

export interface ExpenseCategory {
  id: string
  code: string
  name: string
  isActive: boolean
}

export interface Expense {
  id: string
  projectId: string
  jobNumber: string
  projectDescription: string
  clientName: string
  categoryId: string
  categoryCode: string
  categoryName: string
  expenseDate: string
  description: string
  payeeName: string | null
  amount: string
  paymentReference: string | null
  notes: string | null
  isVoided: boolean
  voidedAt: string | null
  voidReason: string | null
  createdAt: string
  updatedAt: string
}

export interface PagedExpenses {
  items: Expense[]
  total: number
  /** Sum of every matching expense that is not voided, not just the page shown. */
  totalAmount: string
  page: number
  pageSize: number
}

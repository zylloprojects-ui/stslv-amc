// Types for Invoice Tracking, as returned by the API.
// Money is a decimal string with three decimals; dates are YYYY-MM-DD.

import type { InvoiceEligibility } from '../pages/amc/types'
import type { InvoiceState } from './projectTypes'

// PROVISIONAL: payment is not tracked. An invoice is issued or cancelled.
export type InvoiceStatus = 'ISSUED' | 'CANCELLED'

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = { ISSUED: 'Issued', CANCELLED: 'Cancelled' }

export interface InvoiceAllocation {
  id: string
  /** Part of the invoice's amount excluding VAT. */
  amount: string
  /** Exactly one of amcVisit and project is present. */
  amcVisit: {
    id: string
    contractId: string
    systemDescription: string
    sequenceNo: number
    periodStart: string
    periodEnd: string
    completedDate: string | null
  } | null
  project: { id: string; jobNumber: string; description: string } | null
}

export interface Invoice {
  id: string
  invoiceNumber: string
  client: { id: string; name: string }
  invoiceDate: string
  amountExclVat: string
  vatAmount: string
  /** amountExclVat + vatAmount, added by the server. */
  totalAmount: string
  status: InvoiceStatus
  source: 'ZOHO'
  sourceReference: string | null
  notes: string | null
  cancelledAt: string | null
  cancelledBy: { id: string; fullName: string } | null
  cancellationReason: string | null
  createdBy: { id: string; fullName: string }
  createdAt: string
  updatedAt: string
  allocations: InvoiceAllocation[]
}

export interface PagedInvoices {
  items: Invoice[]
  total: number
  page: number
  pageSize: number
  /** Over every invoice that matches the filters; cancelled invoices are never counted. */
  totals: { amountExclVat: string; vatAmount: string; totalAmount: string }
}

export interface BillableVisit {
  id: string
  contractId: string
  client: { id: string; name: string }
  systemDescription: string
  sequenceNo: number
  periodStart: string
  periodEnd: string
  completedDate: string
  /** As entered on the visit. Whether it includes VAT is not confirmed. */
  visitAmount: string
  invoiceEligibility: InvoiceEligibility
  invoicedAmount: string
}

export interface BillableProject {
  id: string
  jobNumber: string
  description: string
  client: { id: string; name: string }
  completedDate: string
  /** Excluding VAT. */
  jobValue: string
  invoiceState: InvoiceState
  invoicedValue: string
  uninvoicedValue: string
}

/** Completed work that can go on an invoice. A section is null when the user may not view that module. */
export interface BillableWork {
  amcVisits: { items: BillableVisit[]; pendingCount: number; pendingAmount: string } | null
  projects: { items: BillableProject[]; pendingCount: number; pendingValue: string } | null
}

export const visitLabel = (visit: { systemDescription: string; sequenceNo: number; periodStart: string; periodEnd: string }, format: (value: string) => string) =>
  `${visit.systemDescription} · visit ${visit.sequenceNo} (${format(visit.periodStart)} to ${format(visit.periodEnd)})`

/** A short text for what one allocation covers. */
export function allocationLabel(allocation: InvoiceAllocation, format: (value: string) => string): string {
  if (allocation.amcVisit) {
    return `AMC ${visitLabel(allocation.amcVisit, format)}`
  }

  return allocation.project ? `${allocation.project.jobNumber} — ${allocation.project.description}` : '—'
}

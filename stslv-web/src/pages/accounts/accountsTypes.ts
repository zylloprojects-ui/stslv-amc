import type { ServiceStatus } from '../amc/serviceStatusTypes'

// The Accounts API (/api/accounts): a billing reconciliation with one
// row per scheduled AMC visit, its service report number, its manual Invoice No.
// (entered = Paid, cleared = Unpaid: a reference status, editable on the page) and the Zoho invoices of Invoice Tracking.

/**
 * Derived by the API, first rule that applies:
 * Red service not completed · Blue completed, Unpaid · Green completed, Paid.
 * Separate from Master AMC Status's four colours.
 */
export const ACCOUNTS_COLOURS = ['RED', 'BLUE', 'GREEN'] as const
export type AccountsColour = (typeof ACCOUNTS_COLOURS)[number]

export const ACCOUNTS_COLOUR_LABELS: Record<AccountsColour, string> = {
  RED: 'Red · Service not completed',
  BLUE: 'Blue · Completed, Unpaid',
  GREEN: 'Green · Completed, Paid',
}

export const SERVICE_FILTERS = [
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'NOT_COMPLETED', label: 'Not Completed' },
] as const

/** Whether a manual Invoice No. is entered: the reference Paid / Unpaid status. */
export const INVOICE_FILTERS = [
  { value: 'RECORDED', label: 'Paid' },
  { value: 'NOT_RECORDED', label: 'Unpaid' },
] as const

export interface AccountsItem {
  id: string
  reference: string
  contract: { id: string; status: string }
  client: { id: string; name: string }
  system: { description: string; typeId: string | null; typeName: string | null }
  frequency: { code: string; label: string }
  service: { sequenceNo: number; cycleNo: number | null; serviceCode: string | null }
  scheduledDate: string
  visitStatus: string
  serviceStatus: ServiceStatus
  completedDate: string | null
  /** The visit amount as a decimal string, OMR excluding VAT; null when none is set. */
  visitValue: string | null
  serviceReportNo: string | null
  manualInvoiceNo: string | null
  paymentStatus: 'PAID' | 'UNPAID'
  paidAt: string | null
  updatedAt: string
  /** Every active Zoho invoice in Invoice Tracking covering the visit; empty when none. */
  invoiceNumbers: string[]
  /** Zoho invoice amounts allocated to the visit in Invoice Tracking (OMR, ex VAT); null when none. Absent from an older API. */
  invoiceValue?: string | null
  /** No value because the contract has neither a Billing Basis nor a Cost per Visit: nothing is invented. */
  valueSourceMissing?: boolean
  /** The Service Report uploaded on Service Status, or null when none. Absent from an older API. */
  serviceReport?: { id: string; originalName: string; mimeType: string; sizeBytes: number; uploadedAt: string } | null
  salesEngineer: { id: string; name: string } | null
  /** Read-only, from Invoice Acknowledgements; null when no Invoice No. or the user may not view that page. */
  acknowledgementStatus?: 'PENDING' | 'ACKNOWLEDGED' | null
  colour: AccountsColour
}

export interface AccountsKpis {
  rows: number
  completed: number
  notCompleted: number
  invoiceFilled: number
  totalValue: string
  valueMissing: number
  /** Value of the filtered services with an Invoice No. entered (Paid reference status). Absent from an older API. */
  paidValue?: string
  /** Zoho invoice amounts allocated to the filtered services (Invoice Tracking). Absent from an older API. */
  invoiceValue?: string
  /** Filtered services covered by at least one active Zoho invoice. */
  invoiced?: number
  red: number
  blue: number
  green: number
}

export interface AccountsList {
  items: AccountsItem[]
  total: number
  page: number
  pageSize: number
  kpis: AccountsKpis
}

export interface AccountsOptions {
  clients: { id: string; name: string }[]
  salesEngineers: { id: string; name: string }[]
  /** The contracts with visits on the page. */
  contracts: { id: string; reference: string; client: string; system: string }[]
  years: number[]
}

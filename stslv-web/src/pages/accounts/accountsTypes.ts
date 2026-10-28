import type { ServiceStatus } from '../amc/serviceStatusTypes'

// The Accounts API (/api/accounts): a read-only billing reconciliation with one
// row per scheduled AMC visit, its service report number and the invoices
// recorded in Invoice Tracking. Payment is not recorded in STSLV AMC.

/**
 * Derived by the API, first rule that applies:
 * Red service not completed · Blue completed, no invoice number · Green completed, invoice number recorded.
 * Separate from Master AMC Status's four colours.
 */
export const ACCOUNTS_COLOURS = ['RED', 'BLUE', 'GREEN'] as const
export type AccountsColour = (typeof ACCOUNTS_COLOURS)[number]

export const ACCOUNTS_COLOUR_LABELS: Record<AccountsColour, string> = {
  RED: 'Red · Service not completed',
  BLUE: 'Blue · Completed, no invoice number',
  GREEN: 'Green · Completed, invoice number recorded',
}

export const SERVICE_FILTERS = [
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'NOT_COMPLETED', label: 'Not Completed' },
] as const

/** Whether an invoice is recorded: the most precise invoice status there is. Never paid / unpaid. */
export const INVOICE_FILTERS = [
  { value: 'RECORDED', label: 'Invoice recorded' },
  { value: 'NOT_RECORDED', label: 'No invoice recorded' },
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
  /** The visit amount as a decimal string; null when none is set. Whether it includes VAT is not confirmed. */
  visitValue: string | null
  serviceReportNo: string | null
  /** Every active invoice covering the visit; empty when none. */
  invoiceNumbers: string[]
  /** Always NOT_AVAILABLE: payment is not recorded. */
  paymentStatus: 'NOT_AVAILABLE'
  salesEngineer: { id: string; name: string } | null
  colour: AccountsColour
}

export interface AccountsKpis {
  rows: number
  completed: number
  notCompleted: number
  invoiceFilled: number
  totalValue: string
  valueMissing: number
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
  years: number[]
}

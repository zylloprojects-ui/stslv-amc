// The Master AMC Status API (/api/amc/master-status): a read-only overview with
// one row per scheduled AMC visit, its invoice numbers and its quotation number.

export const SERVICE_STATUSES = ['NOT_COMPLETED', 'COMPLETED', 'WAITING_FOR_RENEWAL'] as const
export type ServiceStatus = (typeof SERVICE_STATUSES)[number]

export const SERVICE_STATUS_LABELS: Record<ServiceStatus, string> = {
  NOT_COMPLETED: 'Not Completed',
  COMPLETED: 'Completed',
  WAITING_FOR_RENEWAL: 'Waiting for Renewal',
}

/**
 * Derived by the API, first rule that applies:
 * Red not completed · Yellow completed, Unpaid · Blue Paid, no quotation · Green Paid and quoted.
 */
export const ROW_COLOURS = ['RED', 'YELLOW', 'BLUE', 'GREEN'] as const
export type RowColour = (typeof ROW_COLOURS)[number]

export const ROW_COLOUR_LABELS: Record<RowColour, string> = {
  RED: 'Red · Not completed',
  YELLOW: 'Yellow · Invoice pending (Unpaid)',
  BLUE: 'Blue · Quote pending',
  GREEN: 'Green · Paid and quoted',
}

export interface MasterStatusItem {
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
  /** The manual Invoice No.: entered = Paid, cleared = Unpaid (reference status). */
  manualInvoiceNo: string | null
  paymentStatus: 'PAID' | 'UNPAID'
  /** Every active Zoho invoice in Invoice Tracking covering the visit; empty when none. */
  invoiceNumbers: string[]
  quotationNo: string | null
  salesEngineer: { id: string; name: string } | null
  colour: RowColour
}

export interface MasterStatusKpis {
  total: number
  green: number
  blue: number
  yellow: number
  red: number
  totalValue: string
  valueMissing: number
}

export interface MasterStatusList {
  items: MasterStatusItem[]
  total: number
  page: number
  pageSize: number
  kpis: MasterStatusKpis
}

export interface MasterStatusOptions {
  clients: { id: string; name: string }[]
  salesEngineers: { id: string; name: string }[]
  years: number[]
}

/** The Service column: the service code of migration 0076 ("Q3"), or the visit number of an older visit. */
export const INVOICE_STATUS_FILTERS = [
  { value: 'RECORDED', label: 'Paid' },
  { value: 'NOT_RECORDED', label: 'Unpaid' },
] as const

export const QUOTATION_STATUS_FILTERS = [
  { value: 'RECORDED', label: 'Quote recorded' },
  { value: 'NOT_RECORDED', label: 'No quote recorded' },
] as const

export function serviceCodeLabel(service: MasterStatusItem['service']): string {
  return service.serviceCode ?? `No. ${service.sequenceNo}`
}

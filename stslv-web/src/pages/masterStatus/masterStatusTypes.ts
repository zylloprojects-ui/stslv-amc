// The Master AMC Status API (/api/amc/master-status): a read-only overview with
// one row per scheduled AMC visit, its invoice numbers and its quotation number.

import type { ServiceAcknowledgement } from '../invoiceAcknowledgements/ServiceAcknowledgement'

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
  /** Zoho invoice amounts allocated to the visit in Invoice Tracking (OMR, ex VAT); null when none. Absent from an older API. */
  invoiceValue?: string | null
  /** No value because the contract has neither a Billing Basis nor a Cost per Visit (nothing is invented). */
  valueSourceMissing?: boolean
  /** The contract's AMC Value / Year; null unless the user may see contract values (AMC Contracts: View). */
  amcValue?: string | null
  /** Invoice Acknowledged of this service's invoice; null without Invoice Acknowledgements: View, absent from an older API. */
  acknowledgement?: ServiceAcknowledgement | null
}

export interface MasterStatusKpis {
  total: number
  green: number
  blue: number
  yellow: number
  red: number
  totalValue: string
  valueMissing: number
  /** Value of the filtered services with an Invoice No. entered (Paid reference status). */
  paidValue?: string
  /** Zoho invoice amounts allocated to the filtered services (Invoice Tracking). */
  invoiceValue?: string
}

export interface MasterStatusList {
  items: MasterStatusItem[]
  total: number
  page: number
  pageSize: number
  kpis: MasterStatusKpis
  /** The Invoice Acknowledged column is offered (Invoice Acknowledgements: View). Absent from an older API. */
  acknowledgementsVisible?: boolean
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

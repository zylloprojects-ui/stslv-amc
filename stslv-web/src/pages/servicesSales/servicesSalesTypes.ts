// The Services Sales API (/api/services-sales): one row per scheduled AMC visit,
// the same visit records as Service Status, with the visit's quotation number.

export const SERVICE_STATUSES = ['NOT_COMPLETED', 'COMPLETED'] as const
export type ServiceStatus = (typeof SERVICE_STATUSES)[number]

export const SERVICE_STATUS_LABELS: Record<ServiceStatus, string> = {
  NOT_COMPLETED: 'Not Completed',
  COMPLETED: 'Completed',
}

/** Derived by the API: completed with a quotation number is Quoted; completed without one is Quote Pending. */
export type SalesStatus = 'NOT_COMPLETED' | 'QUOTE_PENDING' | 'QUOTED'

/** Submitted: a quotation number is recorded, whatever the visit's status. See docs/SERVICES_SALES.md. */
export const QUOTE_SUBMISSION_FILTERS = [
  { value: 'SUBMITTED', label: 'Quote Submitted' },
  { value: 'NOT_SUBMITTED', label: 'Not Submitted' },
] as const

export const SALES_STATUS_LABELS: Record<SalesStatus, string> = {
  NOT_COMPLETED: 'Not Completed',
  QUOTE_PENDING: 'Completed / Quote Pending',
  QUOTED: 'Completed with Quote No.',
}

export interface ServicesSalesItem {
  id: string
  reference: string
  contract: { id: string; status: string }
  client: { id: string; name: string }
  system: { description: string; typeId: string | null; typeName: string | null }
  frequency: { code: string; label: string }
  service: { sequenceNo: number; cycleNo: number | null; serviceCode: string | null }
  periodStart: string
  periodEnd: string
  scheduledDate: string
  visitStatus: string
  serviceStatus: ServiceStatus
  salesStatus: SalesStatus
  completedDate: string | null
  /** Entered on Service Status; read only here. */
  serviceReportNo: string | null
  salesEngineer: { id: string; name: string } | null
  quotationNo: string | null
  quotationUpdatedAt: string | null
  quotationUpdatedBy: string | null
  /** A quotation number is recorded but the visit is not completed (reopened after quoting). */
  quotationBeforeCompletion: boolean
  /** The Service Report uploaded on Service Status for this visit, or null. Read only here: View and Download. */
  serviceReport: ServicesSalesReport | null
  updatedAt: string
}

/** Metadata of a visit's current Service Report. The file is fetched by the visit id from /services-sales/:id/report. */
export interface ServicesSalesReport {
  id: string
  originalName: string
  mimeType: string
  sizeBytes: number
  uploadedAt: string
}

/** Browsers show these in a tab; anything else (Word) is downloaded instead. */
export function isBrowserViewable(mimeType: string): boolean {
  return mimeType === 'application/pdf' || mimeType === 'image/png' || mimeType === 'image/jpeg'
}

export interface ServicesSalesKpis {
  total: number
  notCompleted: number
  quotePending: number
  quoted: number
  quotationBeforeCompletion: number
}

export interface ServicesSalesList {
  items: ServicesSalesItem[]
  total: number
  page: number
  pageSize: number
  kpis: ServicesSalesKpis
  /** False until the database has service reports (migration 0104); every row then shows Not uploaded. */
  serviceReportsAvailable?: boolean
}

export interface ServicesSalesOptions {
  clients: { id: string; name: string }[]
  salesEngineers: { id: string; name: string }[]
  systemTypes: { id: string; name: string }[]
  frequencies: { code: string; label: string }[]
  years: number[]
}

export const QUOTATION_MAX_LENGTH = 50

/** The Service column: the service code of migration 0076 ("Q3"), or the visit number of an older visit. */
export function serviceCodeLabel(service: ServicesSalesItem['service']): string {
  return service.serviceCode ?? `No. ${service.sequenceNo}`
}

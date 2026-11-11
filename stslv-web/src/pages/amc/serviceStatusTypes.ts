import type { ServiceAcknowledgement } from '../invoiceAcknowledgements/ServiceAcknowledgement'
import type { ContractStatus, VisitStatus } from './types'

// Shapes returned by /api/amc/service-status. One item is one scheduled visit.

/**
 * Derived by the API from the visit and its contract, never stored:
 * COMPLETED: the visit is completed. WAITING_FOR_RENEWAL: not completed, and the
 * contract has expired or ended without a renewal. NOT_COMPLETED: every other
 * scheduled, in-progress or postponed visit. Cancelled visits are not listed.
 */
export const SERVICE_STATUSES = ['NOT_COMPLETED', 'COMPLETED', 'WAITING_FOR_RENEWAL'] as const
export type ServiceStatus = (typeof SERVICE_STATUSES)[number]

export const SERVICE_STATUS_LABELS: Record<ServiceStatus, string> = {
  NOT_COMPLETED: 'Not Completed',
  COMPLETED: 'Completed',
  WAITING_FOR_RENEWAL: 'Waiting for Renewal',
}

export interface ServiceStatusItem {
  id: string
  /** "AMC-0007": derived from the contract id, never stored. */
  reference: string
  contract: { id: string; status: ContractStatus; validTo: string }
  client: { id: string; name: string }
  system: { description: string; typeId: string | null; typeName: string | null }
  frequency: { code: string; label: string }
  service: { sequenceNo: number; cycleNo: number | null; serviceCode: string | null }
  periodStart: string
  periodEnd: string
  scheduledDate: string
  visitStatus: VisitStatus
  serviceStatus: ServiceStatus
  isOverdue: boolean
  completedDate: string | null
  salesEngineer: { id: string; name: string } | null
  reportNumber: string | null
  /** The Sales Engineer Name typed on this service (database update 0110). Not the contract's Sales Engineer link. */
  salesEngineerName?: string | null
  /** The contract's AMC Value / Year (OMR, excluding VAT); null when this user may not see contract values. */
  amcValue?: string | null
  /** This service's own value (OMR, excluding VAT); same access as amcValue; null when none is recorded. Absent from an older API. */
  serviceValue?: string | null
  /** No service value, and the contract has neither a Billing Basis nor a Cost per Visit. Absent from an older API. */
  valueSourceMissing?: boolean
  /** The service's invoice acknowledgement; null without Invoice Acknowledgements: View. Absent from an older API. */
  acknowledgement?: ServiceAcknowledgement | null
  /** The uploaded Service Report document (database update 0104), or null. */
  serviceReport: ServiceReport | null
  /** Completed and saved: the status and completion date can no longer change. */
  locked: boolean
  /** Paid (manual Invoice No. entered): a reference status that does not verify payment. Absent from an older API. */
  paid?: boolean
  /**
   * The Service Report No. is locked: the lock is switched on and the service is Paid. Only an administrator may
   * change it, with a reason recorded in the Audit Log. Absent (unlocked) from an older API.
   */
  reportNumberLocked?: boolean
  updatedAt: string
}

/** The current Service Report document of one service. */
export interface ServiceReport {
  id: string
  documentId: string
  version: number
  originalName: string
  mimeType: string
  sizeBytes: number
  uploadedBy: { id: string; fullName: string }
  uploadedAt: string
}

export interface ServiceStatusKpis {
  total: number
  completed: number
  notCompleted: number
  waitingForRenewal: number
}

export interface ServiceStatusList {
  items: ServiceStatusItem[]
  total: number
  page: number
  pageSize: number
  /** Every service matching the filters other than the service status. */
  kpis: ServiceStatusKpis
  /** False until database update 0077 adds the report number. */
  reportNumberAvailable: boolean
  /** False until database update 0104: reports cannot be uploaded, so services cannot be completed. */
  serviceReportsAvailable: boolean
  serviceReportLimits: { maxMb: number; allowedTypes: string }
  /** Whether the Service Report No. lock after Paid is switched on (proposed rule, off until approved). */
  reportNumberLockEnabled?: boolean
  /** Database update 0110: the manual Sales Engineer Name is stored. Absent from an older API. */
  salesEngineerNameAvailable?: boolean
  /** The signed-in user may see contract values (AMC Contracts: View), so the AMC Value column is offered. */
  amcValueVisible?: boolean
  /** The Invoice Acknowledgement column is offered (Invoice Acknowledgements: View). Absent from an older API. */
  acknowledgementsVisible?: boolean
}

export interface ServiceStatusOptions {
  clients: { id: string; name: string }[]
  /** Null when the database has no master links yet: the filter is not offered. */
  salesEngineers: { id: string; name: string }[] | null
  systemTypes: { id: string; name: string }[] | null
  frequencies: { code: string; label: string }[]
  years: number[]
  reportNumberAvailable: boolean
  serviceReportsAvailable: boolean
}

/** "Year 2 · Q3" for a visit labelled at generation, otherwise "Visit 7". */
export function serviceLabel(service: ServiceStatusItem['service']): string {
  return service.serviceCode && service.cycleNo ? `Year ${service.cycleNo} · ${service.serviceCode}` : `Visit ${service.sequenceNo}`
}

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** The message shown when Completed is chosen without a report. The API refuses with the same words. */
export const SERVICE_REPORT_REQUIRED_MESSAGE = 'Please upload service report.'

/** The report files accepted (checked again, by content, on the server). */
export const SERVICE_REPORT_EXTENSIONS = ['pdf', 'doc', 'docx'] as const
export const SERVICE_REPORT_ACCEPT = '.pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const SERVICE_REPORT_MIME_TYPES = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']

/** Why a chosen file cannot be a service report, or null. An empty browser-stated type is allowed: the server checks the content. */
export function serviceReportFileProblem(file: File, maxMb: number): string | null {
  const extension = file.name.includes('.') ? (file.name.split('.').pop() ?? '').toLowerCase() : ''

  if (!(SERVICE_REPORT_EXTENSIONS as readonly string[]).includes(extension)) return 'Only PDF, DOC and DOCX files can be uploaded as a service report.'
  if (file.type !== '' && !SERVICE_REPORT_MIME_TYPES.includes(file.type)) return 'This file type is not accepted. Choose a PDF, DOC or DOCX file.'
  if (file.size === 0) return 'The chosen file is empty. Choose another file.'
  if (file.size > maxMb * 1024 * 1024) return `Service reports can be at most ${maxMb} MB.`
  return null
}

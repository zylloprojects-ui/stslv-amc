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
  updatedAt: string
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
}

export interface ServiceStatusOptions {
  clients: { id: string; name: string }[]
  /** Null when the database has no master links yet: the filter is not offered. */
  salesEngineers: { id: string; name: string }[] | null
  systemTypes: { id: string; name: string }[] | null
  frequencies: { code: string; label: string }[]
  years: number[]
  reportNumberAvailable: boolean
}

/** "Year 2 · Q3" for a visit labelled at generation, otherwise "Visit 7". */
export function serviceLabel(service: ServiceStatusItem['service']): string {
  return service.serviceCode && service.cycleNo ? `Year ${service.cycleNo} · ${service.serviceCode}` : `Visit ${service.sequenceNo}`
}

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

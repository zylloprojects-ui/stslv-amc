// Master lists (migrations 0070 and 0075), as returned by /api/masters.

import { ApiError } from '../../lib/api'

export interface Department {
  id: string
  code: string
  name: string
  description: string | null
  engineerCount: number
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface SystemType {
  id: string
  code: string
  name: string
  description: string | null
  sortOrder: number
  contractCount: number
  isActive: boolean
  createdAt: string
  updatedAt: string
}

/** One of the four fixed scheduling frequencies (migration 0075). Only the label and the active flag change. */
export interface MaintenanceFrequency {
  id: string
  code: string
  label: string
  name: string
  /** Months between visits, as used by the schedule generator. */
  intervalMonths: number | null
  sortOrder: number
  contractCount: number
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface SalesEngineer {
  id: string
  name: string
  employeeNo: string | null
  email: string | null
  phone: string | null
  department: { id: string; code: string; name: string } | null
  user: { id: string; fullName: string; email: string } | null
  notes: string | null
  contractCount: number
  isActive: boolean
  createdAt: string
  updatedAt: string
}

/** A sales engineer as the Sales Engineers pages read it, with the fields those pages add. */
export interface EngineerRecord extends SalesEngineer {
  /** "SE-0042": derived from the id, never stored, so it never changes. */
  code: string
  /** Active AMC contracts linked to the engineer: the assignments a disable warns about. */
  activeContractCount: number
}

/** The stored active flag in words. Archived needs a database update (not built). */
export const ENGINEER_STATUS_LABELS = { active: 'Active', inactive: 'Disabled' } as const

/** GET /api/masters/sales-engineers/:id/summary. A section is null when the viewer's role cannot see its module. */
export interface EngineerSummary {
  asOf: string
  contracts: { total: number; active: number; draft: number; expired: number; cancelled: number; activeValue: string } | null
  visits: { upcoming: number; overdue: number; nextVisitDate: string | null } | null
  upcoming: {
    total: number
    items: { id: string; scheduledDate: string; sequenceNo: number; status: string; assignedTo: string | null; contract: { id: string; systemDescription: string; clientName: string } }[]
  } | null
}

/** An account the engineer form may link to (GET /api/masters/sales-engineers/user-options). */
export interface EngineerUserOption {
  id: string
  fullName: string
  email: string
}

export interface MasterList<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export type MasterCategoryKey = 'clients' | 'sales-engineers' | 'system-types' | 'maintenance-frequencies' | 'departments'

/** GET /api/masters/summary: one entry per category the user may read. activeCount is null until the category's database update is applied. */
export interface MasterSummary {
  categories: { key: MasterCategoryKey; available: boolean; activeCount: number | null }[]
}

export interface ContractMasters {
  salesEngineer: { id: string; name: string; employeeNo: string | null; isActive: boolean } | null
  systemType: { id: string; code: string; name: string; isActive: boolean } | null
}

/** True when the API says the feature's database update has not been applied yet. */
export function isFeatureUnavailable(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'FEATURE_UNAVAILABLE'
}

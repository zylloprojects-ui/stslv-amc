// Master lists (migration 0070), as returned by /api/masters.

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

export interface MasterList<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export interface ContractMasters {
  salesEngineer: { id: string; name: string; employeeNo: string | null; isActive: boolean } | null
  systemType: { id: string; code: string; name: string; isActive: boolean } | null
}

/** True when the API says the feature's database update has not been applied yet. */
export function isFeatureUnavailable(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'FEATURE_UNAVAILABLE'
}

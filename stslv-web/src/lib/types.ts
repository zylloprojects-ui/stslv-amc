export const MODULES = [
  'DASHBOARD',
  'CLIENTS',
  'AMC_CONTRACTS',
  'AMC_SCHEDULE',
  'AMC_EXECUTION',
  'PROJECTS',
  'PROCUREMENT',
  'EXPENSES',
  'INVOICES',
  'REPORTS',
  'USERS',
  'SETTINGS',
] as const

export const ACTIONS = ['VIEW', 'CREATE', 'EDIT', 'DELETE', 'APPROVE', 'EXPORT'] as const

export type Module = (typeof MODULES)[number]
export type Action = (typeof ACTIONS)[number]

export const MODULE_LABELS: Record<Module, string> = {
  DASHBOARD: 'Dashboard',
  CLIENTS: 'Clients',
  AMC_CONTRACTS: 'AMC Contracts',
  AMC_SCHEDULE: 'AMC Schedule',
  AMC_EXECUTION: 'AMC Execution',
  PROJECTS: 'Projects',
  PROCUREMENT: 'Procurement',
  EXPENSES: 'Expenses',
  INVOICES: 'Invoice Tracking',
  REPORTS: 'Reports',
  USERS: 'Users & Access',
  SETTINGS: 'Settings',
}

export const ACTION_LABELS: Record<Action, string> = {
  VIEW: 'View',
  CREATE: 'Create',
  EDIT: 'Edit',
  DELETE: 'Delete',
  APPROVE: 'Approve',
  EXPORT: 'Export',
}

export interface RoleSummary {
  id: string
  code: string
  name: string
}

export interface SessionUser {
  id: string
  email: string
  fullName: string
  roles: RoleSummary[]
  /** "MODULE:ACTION" strings, for example "CLIENTS:EDIT". */
  permissions: string[]
}

export interface Client {
  id: string
  name: string
  contactPerson: string | null
  email: string | null
  phone: string | null
  address: string | null
  notes: string | null
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface Paged<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export interface User {
  id: string
  email: string
  fullName: string
  isActive: boolean
  lastLoginAt: string | null
  createdAt: string
  roles: RoleSummary[]
}

export interface Permission {
  module: Module
  action: Action
}

export interface Role {
  id: string
  code: string
  name: string
  description: string | null
  isActive: boolean
  userCount: number
  permissions: Permission[]
  permissionsEditable: boolean
}

export interface RolesResponse {
  roles: Role[]
  modules: Module[]
  actions: Action[]
}

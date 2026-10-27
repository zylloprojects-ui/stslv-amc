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
  'HISTORICAL_DATA',
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
  HISTORICAL_DATA: 'Historical Data',
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
  /** The client code, "CL-00042", derived by the API from the id. */
  code: string
  name: string
  contactPerson: string | null
  email: string | null
  phone: string | null
  address: string | null
  notes: string | null
  /** Migration 0074: null when not set, or on a database without it. Optional in older test data. */
  clientType?: ClientType | null
  vatNumber?: string | null
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export type ClientType = 'COMPANY' | 'INDIVIDUAL'

export const CLIENT_TYPE_LABELS: Record<ClientType, string> = { COMPANY: 'Company', INDIVIDUAL: 'Individual' }

/** The stored active flag in words. An inactive client is shown as Disabled. */
export const CLIENT_STATUS_LABELS = { active: 'Active', inactive: 'Disabled' } as const

/** Client 360 figures (GET /clients/:id/summary). A section is null when the role cannot see that module. */
export interface ClientSummary {
  asOf: string
  contracts: {
    total: number
    active: number
    draft: number
    expired: number
    cancelled: number
    activeValue: string
    nonCancelledValue: string
    finalCreditTotal: string
    finalCreditRecorded: number
  } | null
  renewals: {
    windowDays: number
    total: number
    items: { id: string; systemDescription: string; validFrom: string; validTo: string; daysLeft: number; contractValue: string }[]
  } | null
  visits: { upcoming: number; overdue: number; completed: number; readyForInvoice: number; nextVisitDate: string | null } | null
  invoices: { issued: number; cancelled: number; issuedExclVat: string; issuedTotal: string; lastInvoiceDate: string | null } | null
  /** Payments are not recorded, so paid and unpaid cannot be told apart. */
  paymentTracking: false
}

/** What the client pages can offer on this database (GET /clients/features). */
export interface ClientFeatures {
  clientDetails: boolean
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
  /**
   * PENDING: requested from the Sign up page and not yet decided by an administrator.
   * REJECTED: the request was refused; the account cannot sign in and holds no role.
   */
  approvalStatus: 'PENDING' | 'APPROVED' | 'REJECTED'
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

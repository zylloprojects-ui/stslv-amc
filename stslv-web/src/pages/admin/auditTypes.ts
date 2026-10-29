// Types and labels for Login History and the Audit Log, as returned by /api/audit.

export interface LoginRecord {
  id: string
  outcome: 'SUCCESS' | 'FAILED'
  /** Null when the email did not belong to an account. */
  user: { id: string; fullName: string; email: string } | null
  ip: string | null
  reason: string | null
  createdAt: string
}

export interface LoginList {
  items: LoginRecord[]
  total: number
  failedTotal: number
  page: number
  pageSize: number
}

export interface ActivityRecord {
  id: string
  action: string
  module: string
  entityType: string
  entityId: string | null
  description: string | null
  user: { id: string; fullName: string } | null
  changes: Record<string, { from: unknown; to: unknown }> | null
  reason: string | null
  createdAt: string
}

export interface ActivityList {
  items: ActivityRecord[]
  total: number
  page: number
  pageSize: number
}

export interface ActivityOptions {
  modules: string[]
  entityTypes: string[]
  users: { id: string; fullName: string }[]
}

export const FAILURE_REASON_LABELS: Record<string, string> = {
  unknown_account: 'No account with this email',
  wrong_password: 'Wrong password',
  inactive_account: 'Account inactive or awaiting approval',
  temporary_password_expired: 'Temporary password expired',
}

const MODULE_LABELS: Record<string, string> = {
  AUTH: 'Sign-in and accounts',
  DASHBOARD: 'Dashboard',
  CLIENTS: 'Clients',
  AMC_CONTRACTS: 'AMC contracts',
  AMC_SCHEDULE: 'AMC schedule',
  AMC_EXECUTION: 'AMC execution',
  PROJECTS: 'Projects',
  PROCUREMENT: 'Procurement',
  EXPENSES: 'Expenses',
  INVOICES: 'Invoice tracking',
  REPORTS: 'Reports',
  USERS: 'Users and roles',
  SETTINGS: 'Settings',
  HISTORICAL_DATA: 'Historical data',
  SERVICES_SALES: 'Services sales',
}

function sentence(text: string): string {
  const words = text.replace(/[._]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase()

  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '—'
}

/** A module code in words. An unknown code is spelled out rather than shown raw. */
export const moduleLabel = (code: string) => MODULE_LABELS[code] ?? sentence(code)

/** "amc_contract.status_changed" -> "Amc contract status changed". */
export const actionLabel = (action: string) => sentence(action)

/** "amc_contracts" -> "Amc contracts"; "contractValue" -> "Contract value". */
export const fieldLabel = (name: string) => sentence(name)

export function changeValue(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '—'
  }

  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value)
}

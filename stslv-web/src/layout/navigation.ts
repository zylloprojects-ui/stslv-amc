import type { Module } from '../lib/types'

export interface NavItem {
  label: string
  path: string
  /** The item is shown only to users who hold VIEW on this module. */
  module: Module
  /** The module is in the navigation but its page is not built yet: it opens a placeholder. */
  pending?: true
  /** Shown only to the built-in Admin role, whatever else the user is granted. */
  adminOnly?: true
  /** Further modules the user must also hold VIEW on, for a page that shows data of several modules. */
  alsoRequires?: Module[]
}

/** Whether a navigation item is offered to the user. A convenience only: the API enforces every permission. */
export function navItemVisible(item: NavItem, can: (module: Module, action: 'VIEW') => boolean, isAdmin: boolean): boolean {
  return can(item.module, 'VIEW') && (item.alsoRequires ?? []).every((module) => can(module, 'VIEW')) && (!item.adminOnly || isAdmin)
}

export interface NavSection {
  /** Null for the ungrouped items at the top. */
  title: string | null
  /** A landing page for the group: its heading links there. Shown when any of its items is. */
  path?: string
  items: NavItem[]
}

export const NAVIGATION: NavSection[] = [
  { title: null, items: [{ label: 'Dashboard', path: '/dashboard', module: 'DASHBOARD' }] },
  {
    title: 'Master Data Center',
    path: '/master-data',
    items: [
      { label: 'Clients', path: '/clients', module: 'CLIENTS' },
      { label: 'Sales Engineers', path: '/master-data/sales-engineers', module: 'SETTINGS' },
      { label: 'System Types', path: '/master-data/system-types', module: 'SETTINGS' },
      { label: 'Maintenance Frequencies', path: '/master-data/maintenance-frequencies', module: 'SETTINGS' },
      { label: 'Departments', path: '/master-data/departments', module: 'SETTINGS' },
    ],
  },
  {
    title: 'Operations',
    items: [
      { label: 'AMC Management', path: '/amc/management', module: 'AMC_CONTRACTS' },
      { label: 'AMC Contracts', path: '/amc/contracts', module: 'AMC_CONTRACTS' },
      { label: 'AMC Schedule', path: '/amc/schedule', module: 'AMC_SCHEDULE' },
      { label: 'AMC Calendar', path: '/amc/calendar', module: 'AMC_SCHEDULE' },
      { label: 'Service Status', path: '/amc/service-status', module: 'AMC_SCHEDULE' },
      { label: 'Services Sales', path: '/amc/services-sales', module: 'SERVICES_SALES' },
      // Shows invoice and quotation numbers, so it needs view on those modules too (the API checks the same three).
      { label: 'Master AMC Status', path: '/amc/master-status', module: 'AMC_SCHEDULE', alsoRequires: ['INVOICES', 'SERVICES_SALES'] },
    ],
  },
  {
    title: 'Finance',
    items: [
      { label: 'Expenses', path: '/expenses', module: 'EXPENSES' },
      { label: 'Invoice Tracking', path: '/invoices', module: 'INVOICES' },
    ],
  },
  {
    title: 'Administration',
    items: [
      { label: 'Users & Access', path: '/admin/users', module: 'USERS' },
      { label: 'Roles & Permissions', path: '/admin/roles', module: 'USERS' },
      { label: 'Login History', path: '/admin/login-history', module: 'USERS' },
      { label: 'Audit Log', path: '/admin/audit-log', module: 'USERS', adminOnly: true },
      { label: 'Settings', path: '/settings', module: 'SETTINGS' },
    ],
  },
]

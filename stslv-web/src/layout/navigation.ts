import type { Module } from '../lib/types'

export interface NavItem {
  label: string
  path: string
  /** The item is shown only to users who hold VIEW on this module. */
  module: Module
  /** The module is in the navigation but its page is not built yet: it opens a placeholder. */
  pending?: true
  /** Shown only to administrators (Super Admin and Admin), whatever else the user is granted. */
  adminOnly?: true
  /** Further modules the user must also hold VIEW on, for a page that shows data of several modules. */
  alsoRequires?: Module[]
  /** Modules whose data the page shows: View or data-only Read is enough, and their own pages are not opened. */
  alsoReads?: Module[]
  /** Opened from Settings, not the sidebar. Still offered by the page search and checked like any other item. */
  settingsArea?: true
  /** Icon of a top-level (ungrouped) link in the sidebar. Grouped items show no icon. */
  icon?: 'dashboard' | 'status' | 'contracts' | 'reports'
}

/** Whether a navigation item is offered to the user. A convenience only: the API enforces every permission. */
export function navItemVisible(
  item: NavItem,
  can: (module: Module, action: 'VIEW') => boolean,
  isAdmin: boolean,
  canRead: (module: Module) => boolean = (module) => can(module, 'VIEW'),
): boolean {
  return (
    can(item.module, 'VIEW') &&
    (item.alsoRequires ?? []).every((module) => can(module, 'VIEW')) &&
    (item.alsoReads ?? []).every(canRead) &&
    (!item.adminOnly || isAdmin)
  )
}

export interface NavSection {
  /** Null for the ungrouped items at the top. */
  title: string | null
  /** A landing page for the group: its heading links there. Shown when any of its items is. */
  path?: string
  items: NavItem[]
}

/**
 * The sidebar, in the order approved by the client (2026-11-10):
 *   Dashboard · Master AMC Status · AMC Contracts · AMC Execution ▸ · Accounts ▸ · AMC Sales ▸ · Master Data Center ·
 *   Reports · Administration ▸
 * Ungrouped sections (title null) are plain top-level links, in place. Routes, modules and visibility rules are
 * unchanged; only grouping and labels moved. Kept where they belong although not in the client's picture: AMC
 * Schedule (AMC Execution), Invoice Tracking (Accounts), Security Center and Backup & Restore (Settings), My
 * Suggestions (account menu). AMC Management shows the same Dashboard (2026-11-09), so it is not listed twice; its
 * address still works.
 */
export const NAVIGATION: NavSection[] = [
  {
    title: null,
    items: [
      { label: 'Dashboard', path: '/dashboard', module: 'DASHBOARD', icon: 'dashboard' },
      { label: 'Master AMC Status', path: '/amc/master-status', module: 'MASTER_AMC_STATUS', icon: 'status' },
      { label: 'AMC Contracts', path: '/amc/contracts', module: 'AMC_CONTRACTS', icon: 'contracts' },
    ],
  },
  {
    title: 'AMC Execution',
    items: [
      { label: 'Service Status', path: '/amc/service-status', module: 'SERVICE_STATUS' },
      { label: 'Monthly Calendar', path: '/amc/calendar', module: 'MONTHLY_CALENDAR' },
      { label: 'AMC Schedule', path: '/amc/schedule', module: 'AMC_SCHEDULE' },
    ],
  },
  {
    title: 'Accounts',
    items: [
      // The Accounts page (invoice numbers of every service), labelled as the client asked.
      { label: 'Invoices', path: '/finance/accounts', module: 'ACCOUNTS' },
      { label: 'Invoice Ack', path: '/finance/invoice-acknowledgements', module: 'INVOICE_ACKNOWLEDGEMENTS' },
      { label: 'Invoice Tracking', path: '/invoices', module: 'INVOICES' },
    ],
  },
  {
    title: 'AMC Sales',
    items: [
      { label: 'Service Sales', path: '/amc/service-sales', module: 'SERVICES_SALES' },
      { label: 'AMC Renewals', path: '/amc/renewal', module: 'AMC_RENEWAL' },
    ],
  },
  {
    title: 'Master Data Center',
    path: '/master-data',
    items: [
      { label: 'Clients', path: '/clients', module: 'CLIENTS' },
      { label: 'Sales Engineers', path: '/master-data/sales-engineers', module: 'SALES_ENGINEERS' },
      { label: 'System Types', path: '/master-data/system-types', module: 'SYSTEM_TYPES' },
      { label: 'Maintenance Frequencies', path: '/master-data/maintenance-frequencies', module: 'MAINTENANCE_FREQUENCIES' },
      { label: 'Departments', path: '/master-data/departments', module: 'DEPARTMENTS' },
    ],
  },
  { title: null, items: [{ label: 'Reports', path: '/reports', module: 'REPORTS', icon: 'reports' }] },
  {
    title: 'Administration',
    items: [
      { label: 'Users & Access', path: '/admin/users', module: 'USERS' },
      { label: 'Roles & Permissions', path: '/admin/roles', module: 'USERS' },
      { label: 'Login History', path: '/admin/login-history', module: 'USERS' },
      { label: 'Audit Log', path: '/admin/audit-log', module: 'USERS', adminOnly: true },
      { label: 'Recycle Bin', path: '/admin/deletion-log', module: 'USERS', adminOnly: true },
      { label: 'Suggestions Review', path: '/admin/suggestions', module: 'SUGGESTIONS_REVIEW' },
      { label: 'Settings', path: '/settings', module: 'SETTINGS' },
      { label: 'Security Center', path: '/settings/security', module: 'USERS', adminOnly: true, settingsArea: true },
      { label: 'Backup & Restore', path: '/settings/backups', module: 'USERS', adminOnly: true, settingsArea: true },
    ],
  },
]

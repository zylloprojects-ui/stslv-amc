import type { Module } from '../lib/types'

export interface NavItem {
  label: string
  path: string
  /** The item is shown only to users who hold VIEW on this module. */
  module: Module
}

export interface NavSection {
  /** Null for the ungrouped items at the top. */
  title: string | null
  items: NavItem[]
}

export const NAVIGATION: NavSection[] = [
  { title: null, items: [{ label: 'Dashboard', path: '/dashboard', module: 'DASHBOARD' }] },
  {
    title: 'Operations',
    items: [
      { label: 'Clients', path: '/clients', module: 'CLIENTS' },
      { label: 'AMC Contracts', path: '/amc/contracts', module: 'AMC_CONTRACTS' },
      { label: 'AMC Schedule', path: '/amc/schedule', module: 'AMC_SCHEDULE' },
      { label: 'AMC Execution', path: '/amc/execution', module: 'AMC_EXECUTION' },
      { label: 'Projects', path: '/projects', module: 'PROJECTS' },
      { label: 'Procurement', path: '/procurement', module: 'PROCUREMENT' },
    ],
  },
  {
    title: 'Finance',
    items: [
      { label: 'Expenses', path: '/expenses', module: 'EXPENSES' },
      { label: 'Invoice Tracking', path: '/invoices', module: 'INVOICES' },
    ],
  },
  { title: 'Reporting', items: [{ label: 'Reports', path: '/reports', module: 'REPORTS' }] },
  {
    title: 'Administration',
    items: [
      { label: 'Users & Access', path: '/admin/users', module: 'USERS' },
      { label: 'Settings', path: '/settings', module: 'SETTINGS' },
    ],
  },
]

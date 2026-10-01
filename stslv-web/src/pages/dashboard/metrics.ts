import { formatCount } from '../../lib/format'
import type { Module } from '../../lib/types'

/**
 * What GET /api/dashboard/summary returns today. Only client figures exist.
 *
 * When a business module adds its figures to the summary, extend this type to
 * match what the API actually returns, then give the matching metric below a
 * `read` function. Nothing else on the dashboard needs to change.
 */
export interface DashboardSummary {
  clients: { active: number; inactive: number }
}

/** A figure ready to show. Values are already formatted text, so money never passes through a JavaScript number here. */
export interface MetricReading {
  value: string
  /** A short line under the value, for example a related count. */
  detail?: string
}

export interface MetricDefinition {
  id: string
  label: string
  /** The metric is shown only to users who hold VIEW on this module. */
  module: Module
  /** Where the figure comes from. Shown while the metric is not connected. */
  source: string
  /** A page of the same module to open from the card, once the metric shows a figure. */
  link?: { to: string; label: string }
  /** Marks work waiting for an invoice, which the business must not lose sight of. */
  attention?: boolean
  /**
   * Reads the figure from the summary. A metric without `read` has no data
   * source yet and is shown as "Not yet available" — never as a number.
   */
  read?: (summary: DashboardSummary) => MetricReading
}

export interface MetricGroup {
  id: string
  title: string
  metrics: MetricDefinition[]
}

// The module each metric is tied to follows the navigation: a user sees a figure
// only where they can also open the module it belongs to. The ready-for-invoice
// figures are tied to Invoice Tracking, the module that acts on them. This choice
// is provisional, like the rest of the permission matrix, and the API must apply
// the same check before it returns a figure.
export const METRIC_GROUPS: MetricGroup[] = [
  {
    id: 'clients',
    title: 'Clients',
    metrics: [
      {
        id: 'clients.active',
        label: 'Active Clients',
        module: 'CLIENTS',
        source: 'Clients',
        link: { to: '/clients', label: 'View clients' },
        read: (summary) => ({
          value: formatCount(summary.clients.active),
          detail: `${formatCount(summary.clients.inactive)} inactive`,
        }),
      },
    ],
  },
  {
    id: 'amc',
    title: 'AMC',
    metrics: [
      { id: 'amc.activeContracts', label: 'Active Contracts', module: 'AMC_CONTRACTS', source: 'AMC Contracts' },
      { id: 'amc.visitsDue', label: 'Visits Due', module: 'AMC_SCHEDULE', source: 'AMC Schedule' },
      { id: 'amc.readyForInvoice', label: 'Ready for Invoice', module: 'INVOICES', source: 'AMC Execution and Invoice Tracking', attention: true },
    ],
  },
  {
    id: 'projects',
    title: 'Projects',
    metrics: [
      { id: 'projects.active', label: 'Active Projects', module: 'PROJECTS', source: 'Projects' },
      { id: 'projects.readyForInvoice', label: 'Projects Ready for Invoice', module: 'INVOICES', source: 'Projects and Invoice Tracking', attention: true },
    ],
  },
  {
    id: 'finance',
    title: 'Finance',
    metrics: [
      { id: 'finance.trackedExpenses', label: 'Tracked Expenses', module: 'EXPENSES', source: 'Expenses' },
      { id: 'finance.readyForInvoiceValue', label: 'Ready-for-Invoice Value', module: 'INVOICES', source: 'Invoice Tracking', attention: true },
    ],
  },
]

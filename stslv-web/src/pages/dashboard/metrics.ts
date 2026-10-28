import { formatCount } from '../../lib/format'
import { formatMoney, isZeroAmount } from '../../lib/money'
import type { Module } from '../../lib/types'

/**
 * What GET /api/dashboard/summary returns, as far as the dashboard reads it.
 * The API puts the figures of each module side by side and leaves out (null)
 * whatever the signed-in user may not see. Amounts are decimal strings.
 */
export interface DashboardSummary {
  clients?: { active: number; inactive: number } | null
  /** The AMC module's own summary. */
  amc?: {
    contracts: { active: number; activePastValidity: number; draft?: number; expired?: number; cancelled?: number } | null
    visits: { due: number; overdue: number; dueThisMonth?: number; inProgress?: number; completedThisMonth?: number } | null
    invoicing: { readyForInvoice: { count: number; amount: string }; amountRequired: { count: number } } | null
  } | null
  /** The Projects module's own summary. */
  projects?: {
    counts: { active: number; new: number; inProgress: number; readyForInvoice: number }
    values: { readyForInvoiceValue: string }
    costs: { trackedExpenses: string; trackedExpensesOnCancelledProjects: string; trackedExpensesOnHistoricalProjects?: string } | null
  } | null
  /** The Invoice Tracking module's own summary. */
  invoices?: {
    issued: { count: number; amountExclVat: string; vatAmount: string; totalAmount: string }
    cancelled: { count: number }
    projects: { partlyInvoiced: { count: number } } | null
  } | null
}

/** One of several amounts shown side by side in a card, each on its own stated basis. They are never added together. */
export interface MetricPart {
  label: string
  /** What the amount includes, for example "Excl. VAT". */
  basis: string
  value: string
}

/** A figure ready to show. Values are already formatted text, so money never passes through a JavaScript number here. */
export type MetricReading =
  | {
      value: string
      /** A short line under the value, for example a related count. */
      detail?: string
    }
  | { parts: MetricPart[]; note: string }

export interface MetricLink {
  to: string
  label: string
  /** The link is offered only to users who may open this module. */
  module: Module
}

export interface MetricDefinition {
  id: string
  label: string
  /**
   * Whether the user's role includes the figure, given what they may view. It
   * mirrors the check the API makes, so the right cards show while loading. The
   * API decides: a figure it leaves out is not shown whatever this says.
   */
  visible: (canView: (module: Module) => boolean) => boolean
  /** Where the figure comes from. Shown while the metric is not connected. */
  source: string
  /** Pages to open from the card. The first one the user may open is offered. */
  links?: MetricLink[]
  /** Marks work waiting for an invoice, which the business must not lose sight of. */
  attention?: boolean
  /**
   * Reads the figure from the summary, or returns null when the API left it out.
   * A metric without `read` has no data source yet and is shown as
   * "Not yet available" — never as a number.
   */
  read?: (summary: DashboardSummary, canView: (module: Module) => boolean) => MetricReading | null
}

export interface MetricGroup {
  id: string
  title: string
  metrics: MetricDefinition[]
}

const plural = (count: number, one: string, many: string) => `${formatCount(count)} ${count === 1 ? one : many}`

// Each metric belongs to the module that owns its data, and is shown under the
// same permission that module's own pages and summary require. The Projects
// pages are retired from the web application, so no card links to them; the
// project amount still waiting for an invoice stays visible beside the AMC one.
// Active contracts are the Active AMC KPI and are not repeated here.
export const METRIC_GROUPS: MetricGroup[] = [
  {
    id: 'clients',
    title: 'Clients',
    metrics: [
      {
        id: 'clients.active',
        label: 'Active Clients',
        visible: (canView) => canView('CLIENTS'),
        source: 'Clients',
        links: [{ to: '/clients', label: 'View clients', module: 'CLIENTS' }],
        read: ({ clients }) =>
          clients ? { value: formatCount(clients.active), detail: `${formatCount(clients.inactive)} inactive` } : null,
      },
    ],
  },
  {
    id: 'amc',
    title: 'AMC',
    metrics: [
      {
        id: 'amc.visitsDue',
        label: 'Visits Due',
        visible: (canView) => canView('AMC_SCHEDULE') || canView('AMC_EXECUTION'),
        source: 'AMC Schedule',
        links: [{ to: '/amc/schedule', label: 'View schedule', module: 'AMC_SCHEDULE' }],
        read: ({ amc }) => {
          const visits = amc?.visits

          return visits ? { value: formatCount(visits.due), detail: `${formatCount(visits.overdue)} overdue` } : null
        },
      },
      {
        id: 'amc.readyForInvoice',
        label: 'Ready for Invoice',
        visible: (canView) => canView('AMC_SCHEDULE'),
        source: 'AMC Execution',
        links: [
          { to: '/invoices', label: 'Record invoices', module: 'INVOICES' },
          { to: '/amc/schedule', label: 'View schedule', module: 'AMC_SCHEDULE' },
        ],
        attention: true,
        read: ({ amc }) => {
          const invoicing = amc?.invoicing

          if (!invoicing) {
            return null
          }

          return {
            value: formatCount(invoicing.readyForInvoice.count),
            detail:
              invoicing.amountRequired.count > 0
                ? `${plural(invoicing.readyForInvoice.count, 'visit', 'visits')} · ${plural(invoicing.amountRequired.count, 'completed visit needs', 'completed visits need')} an amount`
                : plural(invoicing.readyForInvoice.count, 'completed visit', 'completed visits'),
          }
        },
      },
    ],
  },
  {
    id: 'finance',
    title: 'Finance',
    metrics: [
      {
        id: 'finance.trackedExpenses',
        label: 'Tracked Expenses',
        // The Projects summary gives its cost figures only to a user who holds both.
        visible: (canView) => canView('PROJECTS') && canView('EXPENSES'),
        source: 'Expenses',
        read: ({ projects }) => {
          const costs = projects?.costs

          if (!costs) {
            return null
          }

          // Expenses on cancelled and on historical projects are not in the figure. Whatever
          // was recorded against them is stated beside it, so it is never lost from view.
          const apart = [
            ...(isZeroAmount(costs.trackedExpensesOnCancelledProjects)
              ? []
              : [`${formatMoney(costs.trackedExpensesOnCancelledProjects)} on cancelled projects`]),
            ...(costs.trackedExpensesOnHistoricalProjects === undefined || isZeroAmount(costs.trackedExpensesOnHistoricalProjects)
              ? []
              : [`${formatMoney(costs.trackedExpensesOnHistoricalProjects)} on historical projects`]),
          ]

          return {
            value: formatMoney(costs.trackedExpenses),
            detail: apart.length > 0 ? `Plus ${apart.join(' and ')}` : 'Cancelled projects left out',
          }
        },
      },
      {
        id: 'finance.invoicesRecorded',
        label: 'Invoices Recorded',
        visible: (canView) => canView('INVOICES'),
        source: 'Invoice Tracking',
        links: [{ to: '/invoices', label: 'View invoices', module: 'INVOICES' }],
        read: ({ invoices }) =>
          invoices
            ? {
                value: formatCount(invoices.issued.count),
                detail:
                  `${formatMoney(invoices.issued.amountExclVat)} excl. VAT` +
                  (invoices.cancelled.count > 0 ? ` · ${formatCount(invoices.cancelled.count)} cancelled, not counted` : ''),
              }
            : null,
      },
      {
        id: 'finance.readyForInvoiceValue',
        label: 'Ready-for-Invoice Value',
        visible: (canView) => canView('AMC_SCHEDULE') || canView('PROJECTS'),
        source: 'AMC Execution and Projects',
        attention: true,
        // Two amounts on two different bases. The AMC visit amount has no
        // confirmed VAT basis and the project job value excludes VAT, so they
        // are shown side by side and are not added together.
        read: ({ amc, projects }, canView) => {
          const parts: MetricPart[] = []

          if (canView('AMC_SCHEDULE') && amc?.invoicing) {
            parts.push({ label: 'AMC', basis: 'As entered', value: formatMoney(amc.invoicing.readyForInvoice.amount) })
          }
          if (canView('PROJECTS') && projects) {
            parts.push({ label: 'Projects', basis: 'Excl. VAT', value: formatMoney(projects.values.readyForInvoiceValue) })
          }

          return parts.length > 0 ? { parts, note: 'Shown separately. The two amounts are not added together.' } : null
        },
      },
    ],
  },
]

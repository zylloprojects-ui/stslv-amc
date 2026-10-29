import { formatCount } from '../../lib/format'
import { formatMoney } from '../../lib/money'
import type { Module } from '../../lib/types'
import type { OperationsDashboard } from './operationsTypes'

// The seven KPI cards of the AMC Operations Dashboard. Each reads one figure the
// API returned; none is calculated here.

/** What a KPI card shows once the figures have arrived. */
export type KpiReading = { kind: 'value'; value: string; detail: string; /** The full wording, shown on hover; the card itself carries a short line. */ hint?: string } | { kind: 'unavailable'; reason: string }

export interface KpiDefinition {
  id: string
  /** Short tag shown on the card. */
  code: string
  label: string
  /** Mirrors the API's permission check, so the right cards show while loading. The API decides. */
  visible: (canView: (module: Module) => boolean) => boolean
  /** Null when the API left the section out: the card is then not shown. */
  read: (data: OperationsDashboard) => KpiReading | null
  link?: { to: string; label: string; module: Module }
}

const plural = (count: number, one: string, many: string) => `${formatCount(count)} ${count === 1 ? one : many}`

export const KPIS: KpiDefinition[] = [
  {
    id: 'active',
    code: 'AMC',
    label: 'Active AMC',
    visible: (canView) => canView('AMC_CONTRACTS'),
    link: { to: '/amc/contracts', label: 'View contracts', module: 'AMC_CONTRACTS' },
    read: ({ kpis: { contracts } }) =>
      contracts && {
        kind: 'value',
        value: formatCount(contracts.active),
        detail:
          'Contracts with status Active' +
          (contracts.activePastValidity > 0 ? ` · ${formatCount(contracts.activePastValidity)} past validity` : ''),
      },
  },
  {
    id: 'value',
    code: 'VAL',
    label: 'Active AMC Value',
    visible: (canView) => canView('AMC_CONTRACTS'),
    link: { to: '/amc/contracts', label: 'View contracts', module: 'AMC_CONTRACTS' },
    // The stored contract value, summed. Contracts run for different periods, so it is not an annual figure.
    read: ({ kpis: { contracts } }) =>
      contracts && {
        kind: 'value',
        value: formatMoney(contracts.activeValue),
        detail: 'Sum of active contract values',
        hint: 'Sum of contract values of active contracts · not annualised',
      },
  },
  {
    id: 'credit',
    code: 'CRD',
    label: 'Total Final Credit',
    visible: (canView) => canView('AMC_CONTRACTS'),
    link: { to: '/amc/contracts', label: 'View contracts', module: 'AMC_CONTRACTS' },
    // The meaning of Final Credit is not confirmed (Q1). It is summed as entered and never called revenue or collected.
    read: ({ kpis: { contracts } }) =>
      contracts && {
        kind: 'value',
        value: formatMoney(contracts.finalCreditTotal),
        detail: 'Final credit as entered',
        hint: `As entered on ${formatCount(contracts.finalCreditRecorded)} of ${plural(contracts.active, 'active contract', 'active contracts')} · meaning not yet confirmed, not revenue`,
      },
  },
  {
    id: 'services',
    code: 'SVC',
    label: 'Services This Month',
    visible: (canView) => canView('AMC_SCHEDULE') || canView('AMC_EXECUTION'),
    link: { to: '/amc/calendar', label: 'Open calendar', module: 'MONTHLY_CALENDAR' },
    read: ({ kpis: { services } }) =>
      services && {
        kind: 'value',
        value: formatCount(services.thisMonth),
        detail: `Planned maintenance visits · ${formatCount(services.completedThisMonth)} completed, ${formatCount(services.openThisMonth)} open`,
      },
  },
  {
    id: 'unpaid',
    code: 'DUE',
    label: 'Unpaid Invoices',
    visible: (canView) => canView('INVOICES'),
    link: { to: '/invoices', label: 'Invoice Tracking', module: 'INVOICES' },
    read: ({ kpis: { unpaidInvoices } }) => unpaidInvoices && { kind: 'unavailable', reason: unpaidInvoices.reason },
  },
  {
    id: 'paid',
    code: 'INV',
    label: 'Paid This Month',
    visible: (canView) => canView('INVOICES'),
    link: { to: '/invoices', label: 'Invoice Tracking', module: 'INVOICES' },
    read: ({ kpis: { paidThisMonth } }) => paidThisMonth && { kind: 'unavailable', reason: paidThisMonth.reason },
  },
  {
    id: 'expiring',
    code: 'EXP',
    label: 'Expiring ≤45 Days',
    visible: (canView) => canView('AMC_CONTRACTS'),
    link: { to: '/amc/contracts', label: 'View contracts', module: 'AMC_CONTRACTS' },
    read: ({ kpis: { contracts } }) =>
      contracts && {
        kind: 'value',
        value: formatCount(contracts.expiringSoon),
        detail:
          `Active contracts ending within ${contracts.expiringSoonDays} days` +
          (contracts.expiringSoonWithRenewal ? ` · ${formatCount(contracts.expiringSoonWithRenewal)} with a renewal` : ''),
      },
  },
]

export const DEFAULT_KPI_ORDER = KPIS.map((kpi) => kpi.id)


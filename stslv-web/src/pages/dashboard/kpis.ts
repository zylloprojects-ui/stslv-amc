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

const PAYMENT_HINT = 'Counts the same services as Accounts. Paid means a manual Invoice No. is entered: a reference status that does not verify money was received.'

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
    label: 'Annual AMC Value (OMR)',
    visible: (canView) => canView('AMC_CONTRACTS'),
    link: { to: '/amc/contracts', label: 'View contracts', module: 'AMC_CONTRACTS' },
    // AMC Value / Year as entered, summed. Values entered before that rule are not reinterpreted: see the Contract Value Review report.
    read: ({ kpis: { contracts } }) =>
      contracts && {
        kind: 'value',
        value: formatMoney(contracts.activeValue),
        detail: 'OMR active portfolio, excluding VAT',
        hint: 'Sum of AMC Value / Year of active contracts, as entered. Older multi-year values may be whole-term amounts: see the Contract Value Review report.',
      },
  },
  {
    id: 'credit',
    code: 'CRD',
    label: 'Total Credit (OMR)',
    visible: (canView) => canView('AMC_CONTRACTS'),
    link: { to: '/amc/contracts', label: 'View contracts', module: 'AMC_CONTRACTS' },
    // Final Credit Value, an annual Billing Basis option, summed as entered.
    read: ({ kpis: { contracts } }) =>
      contracts && {
        kind: 'value',
        value: formatMoney(contracts.finalCreditTotal),
        detail: 'OMR active portfolio credit',
        hint: `Final Credit Value as entered on ${formatCount(contracts.finalCreditRecorded)} of ${plural(contracts.active, 'active contract', 'active contracts')}`,
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
    link: { to: '/finance/accounts', label: 'Accounts', module: 'ACCOUNTS' },
    read: ({ kpis: { payments } }) =>
      payments && { kind: 'value', value: formatCount(payments.unpaid), detail: `OMR ${formatMoney(payments.unpaidValue)} scheduled value`, hint: PAYMENT_HINT },
  },
  {
    id: 'paid',
    code: 'INV',
    label: 'Paid This Month',
    visible: (canView) => canView('INVOICES'),
    link: { to: '/finance/accounts', label: 'Accounts', module: 'ACCOUNTS' },
    read: ({ kpis: { payments } }) =>
      payments && { kind: 'value', value: formatCount(payments.paidThisMonth), detail: `OMR ${formatMoney(payments.paidThisMonthValue)} · reference status`, hint: PAYMENT_HINT },
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


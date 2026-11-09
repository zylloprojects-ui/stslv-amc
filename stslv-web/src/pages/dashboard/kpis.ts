import { formatCount } from '../../lib/format'
import { formatMoney } from '../../lib/money'
import type { Module } from '../../lib/types'
import type { IconName } from './icons'
import type { OperationsDashboard } from './operationsTypes'

// The twelve KPI cards of the AMC Operations Dashboard, in three fixed rows of
// four (the client's meeting reference). Each card reads one figure the API
// returned; none is calculated here. The order is fixed: there is no arranging.

/**
 * A KPI card reading as the AMC Management page shares it (it imports this type). Unchanged by the
 * 12-card dashboard, which uses DashboardReading below.
 */
export type KpiReading = { kind: 'value'; value: string; detail: string; /** The full wording, shown on hover; the card itself carries a short line. */ hint?: string } | { kind: 'unavailable'; reason: string }

/** What a dashboard KPI card shows once the figures have arrived. */
export interface DashboardReading {
  value: string
  /** Shown small before the figure, for amounts ("OMR"). */
  unit?: string
  detail: string
  /** The full wording, shown on hover; the card itself carries a short line. */
  hint?: string
}

export type KpiRowId = 'portfolio' | 'month' | 'overall'

export interface KpiDefinition {
  /** Unique across all twelve cards: rows 2 and 3 share labels, never ids. */
  id: string
  row: KpiRowId
  label: string
  icon: IconName
  /** Mirrors the API's permission check, so the right cards show while loading. The API decides. */
  visible: (canView: (module: Module) => boolean) => boolean
  /** Null when the API left the section out: the card is then not shown. */
  read: (data: OperationsDashboard) => DashboardReading | null
}

export interface KpiRow {
  id: KpiRowId
  title: string
  /** A short line beside the title; for the month row it names the month. */
  subtitle: (data: OperationsDashboard | undefined) => string
}

const INVOICE_HINT =
  'An invoice counts as generated when its manual Invoice No. is entered on the service (shown as Paid in Accounts). That is a reference status: it does not verify that money was received. Amounts are service values excluding VAT.'

const plural = (count: number, one: string, many: string) => `${formatCount(count)} ${count === 1 ? one : many}`

/** "November 2026" for "2026-11-03", read as a calendar date (no time-zone shift). */
export function monthName(asOf: string): string {
  const [year, month] = asOf.split('-').map(Number)
  if (!year || !month) return 'this month'

  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

export const KPI_ROWS: KpiRow[] = [
  { id: 'portfolio', title: 'AMC Portfolio', subtitle: () => 'Active contracts' },
  { id: 'month', title: 'Current Month', subtitle: (data) => (data ? `Services scheduled in ${monthName(data.asOf)}` : 'Services scheduled this month') },
  { id: 'overall', title: 'Overall', subtitle: () => 'All service records, earlier years and visits ahead' },
]

const contractsVisible = (canView: (module: Module) => boolean) => canView('AMC_CONTRACTS')
const servicesVisible = (canView: (module: Module) => boolean) => canView('AMC_SCHEDULE') || canView('AMC_EXECUTION')
const invoicesVisible = (canView: (module: Module) => boolean) => canView('INVOICES')

export const KPIS: KpiDefinition[] = [
  // Row 1 — AMC Portfolio.
  {
    id: 'active',
    row: 'portfolio',
    label: 'Active AMCs',
    icon: 'contract',
    visible: contractsVisible,
    read: ({ kpis: { contracts } }) =>
      contracts && {
        value: formatCount(contracts.active),
        detail:
          'Active and within validity' +
          (contracts.activePastValidity > 0 ? ` · ${formatCount(contracts.activePastValidity)} past validity not counted` : '') +
          ((contracts.activeAwaitingPredecessor ?? 0) > 0 ? ` · ${formatCount(contracts.activeAwaitingPredecessor ?? 0)} renewal${contracts.activeAwaitingPredecessor === 1 ? '' : 's'} starting later` : ''),
        hint:
          'Each contract counts once: status Active with its Valid To today or later (Oman time). An Active contract past its Valid To is expired by the approved rule and is not counted; a renewal is counted from when the period it renews ends.',
      },
  },
  {
    id: 'value',
    row: 'portfolio',
    label: 'Annual AMC Value (Ex VAT)',
    icon: 'wallet',
    visible: contractsVisible,
    // AMC Value / Year as entered, summed. Values entered before that rule are not reinterpreted: see the Contract Value Review report.
    read: ({ kpis: { contracts } }) =>
      contracts && {
        value: formatMoney(contracts.activeValue),
        unit: 'OMR',
        detail: 'Contracts counted in Active AMCs, excluding VAT',
        hint: 'Sum of AMC Value / Year of the contracts counted in Active AMCs (each contract once), as entered. Older multi-year values may be whole-term amounts: see the Contract Value Review report.',
      },
  },
  {
    id: 'credit',
    row: 'portfolio',
    label: 'Final Credit (Ex VAT)',
    icon: 'chart',
    visible: contractsVisible,
    // Final Credit Value, an annual Billing Basis option, summed as entered.
    read: ({ kpis: { contracts } }) =>
      contracts && {
        value: formatMoney(contracts.finalCreditTotal),
        unit: 'OMR',
        detail: `Entered on ${formatCount(contracts.finalCreditRecorded)} of ${plural(contracts.active, 'active contract', 'active contracts')}`,
        hint: 'Sum of Final Credit Value of the contracts counted in Active AMCs (each contract once), as entered, excluding VAT. A contract without Final Credit adds nothing; none is invented.',
      },
  },
  {
    id: 'expiring',
    row: 'portfolio',
    label: 'Expiring ≤45 Days',
    icon: 'shield',
    visible: contractsVisible,
    read: ({ kpis: { contracts } }) =>
      contracts && {
        value: formatCount(contracts.expiringSoon),
        detail:
          `Active contracts ending within ${contracts.expiringSoonDays} days` +
          (contracts.expiringSoonWithRenewal ? ` · ${formatCount(contracts.expiringSoonWithRenewal)} with a renewal` : ''),
      },
  },

  // Row 2 — Current Month: services scheduled in this calendar month.
  {
    id: 'month-services',
    row: 'month',
    label: 'Services This Month',
    icon: 'calendar',
    visible: servicesVisible,
    read: ({ kpis: { services } }) =>
      services && {
        value: formatCount(services.thisMonth),
        detail: `${formatCount(services.completedThisMonth)} completed`,
        hint: 'Planned maintenance visits this month. Cancelled visits and cancelled contracts are not counted.',
      },
  },
  {
    id: 'month-pending',
    row: 'month',
    label: 'Services Pending',
    icon: 'execution',
    visible: servicesVisible,
    read: ({ kpis: { services } }) =>
      services && {
        value: formatCount(services.openThisMonth),
        detail: 'Scheduled, in progress or postponed',
      },
  },
  {
    id: 'month-invoiced',
    row: 'month',
    label: 'Invoices Generated',
    icon: 'invoice',
    visible: invoicesVisible,
    read: ({ kpis: { payments } }) =>
      payments && {
        value: formatCount(payments.scheduledThisMonth.withInvoiceNo),
        detail: `OMR ${formatMoney(payments.scheduledThisMonth.withInvoiceNoValue)} · Invoice No. entered`,
        hint: INVOICE_HINT,
      },
  },
  {
    id: 'month-not-invoiced',
    row: 'month',
    label: 'Invoices Not Generated',
    icon: 'pulse',
    visible: invoicesVisible,
    read: ({ kpis: { payments } }) =>
      payments && {
        value: formatCount(payments.scheduledThisMonth.withoutInvoiceNo),
        detail: `OMR ${formatMoney(payments.scheduledThisMonth.withoutInvoiceNoValue)} · no Invoice No.`,
        hint: INVOICE_HINT,
      },
  },

  // Row 3 — Overall: every service record, whatever its date.
  {
    id: 'overall-services',
    row: 'overall',
    label: 'Services Overall',
    icon: 'calendar',
    visible: servicesVisible,
    read: ({ kpis: { services } }) =>
      services && {
        value: formatCount(services.overall),
        detail: 'Every dated service record',
        hint: 'Every planned maintenance visit, past and ahead. Cancelled visits and cancelled contracts are not counted.',
      },
  },
  {
    id: 'overall-pending',
    row: 'overall',
    label: 'Services Pending',
    icon: 'execution',
    visible: servicesVisible,
    read: ({ kpis: { services } }) =>
      services && {
        value: formatCount(services.openOverall),
        detail: 'Not yet completed, including visits ahead',
      },
  },
  {
    id: 'overall-invoiced',
    row: 'overall',
    label: 'Invoices Generated',
    icon: 'invoice',
    visible: invoicesVisible,
    read: ({ kpis: { payments } }) =>
      payments && {
        value: formatCount(payments.paid),
        detail: `OMR ${formatMoney(payments.paidValue)} · Invoice No. entered`,
        hint: INVOICE_HINT,
      },
  },
  {
    id: 'overall-not-invoiced',
    row: 'overall',
    label: 'Invoices Not Generated',
    icon: 'pulse',
    visible: invoicesVisible,
    read: ({ kpis: { payments } }) =>
      payments && {
        value: formatCount(payments.unpaid),
        detail: `OMR ${formatMoney(payments.unpaidValue)} · no Invoice No.`,
        hint: INVOICE_HINT,
      },
  },
]

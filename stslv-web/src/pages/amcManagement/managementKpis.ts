import { formatCount } from '../../lib/format'
import { formatMoney } from '../../lib/money'
import type { Module } from '../../lib/types'
import type { IconName } from '../dashboard/icons'
import { invoiceAmountText, kpiById, kpiColumn, SHARED_WITH_MANAGEMENT, type KpiReading } from '../dashboard/kpis'
import type { AmcManagementSummary } from './managementTypes'

// The three KPI groups of AMC Management. Each card reads one figure the API
// returned; none is calculated here. A card whose figure the API left out (no
// permission) is not shown.
//
// Two kinds of card (client correction, 2026-11-10):
//   * shared with the Dashboard: Active AMCs, Annual AMC Value, Final Credit, Expiring ≤45 Days, Services This Month,
//     Invoices Generated and Invoices Not Generated. They ARE the Dashboard's card definitions (pages/dashboard/kpis.ts):
//     the same label, icon, colour, wording and permission, read from `kpis`, which the API fills from the Dashboard's
//     own calculation. Their name cannot be changed here, so the two pages always agree.
//   * page-specific: Schedule Pending Billing, Current Scheduled Value, Schedule Engine Status, Paid Invoice Total and
//     Invoice Module Status. Only AMC Management shows them.

export interface ManagementKpi<T = AmcManagementSummary> {
  id: string
  /** The standard name. A user may show a different name; the meaning stays this one. */
  label: string
  icon: IconName
  /** Mirrors the API's permission check, so the right cards show while loading. The API decides. */
  visible: (canView: (module: Module) => boolean) => boolean
  read: (data: T) => KpiReading | null
  /** Optional link under the figure. AMC Management's cards have none: they are informational only. */
  link?: { to: string; label: string; module: Module }
  /** A card shared with the Dashboard: always shown under its standard name (no renaming). */
  fixedName?: true
  /** A fixed colour column (the Dashboard's), instead of the card's place in the group. */
  accent?: number
}

/** A group of KPI cards. T is the API answer its cards read; AMC Management's by default. */
export interface KpiGroupDefinition<T = AmcManagementSummary> {
  /** Also names the group's saved names and order in the browser. */
  id: string
  title: string
  description: string
  visible: (canView: (module: Module) => boolean) => boolean
  kpis: ManagementKpi<T>[]
}

const plural = (count: number, one: string, many: string) => `${formatCount(count)} ${count === 1 ? one : many}`

const canVisits = (canView: (module: Module) => boolean) => canView('AMC_SCHEDULE') || canView('AMC_EXECUTION')

/** The Dashboard's card, under the id AMC Management has always used for that figure. */
function shared(managementId: keyof typeof SHARED_WITH_MANAGEMENT): ManagementKpi {
  const kpi = kpiById(SHARED_WITH_MANAGEMENT[managementId] as string)

  return {
    id: managementId,
    label: kpi.label,
    icon: kpi.icon,
    visible: kpi.visible,
    read: (data) => {
      const reading = kpi.read(data)

      return reading && { kind: 'value', ...reading }
    },
    fixedName: true,
    accent: kpiColumn(kpi),
  }
}

export const CONTRACT_KPIS: KpiGroupDefinition = {
  id: 'contracts',
  title: 'Contract KPIs',
  description: 'From the AMC contract register. The same four cards as the Dashboard’s AMC Portfolio row.',
  visible: (canView) => canView('AMC_CONTRACTS'),
  kpis: [shared('active'), shared('value'), shared('credit'), shared('expiring')],
}

export const SCHEDULE_KPIS: KpiGroupDefinition = {
  id: 'schedule',
  title: 'Schedule KPIs',
  description: 'From the visit schedule generated from each contract.',
  visible: canVisits,
  kpis: [
    shared('services'),
    {
      id: 'pendingBilling',
      label: 'Schedule Pending Billing',
      icon: 'invoice',
      visible: (canView) => canView('AMC_SCHEDULE'),
      // Completed visits ready for invoice only: a future visit is never pending billing.
      read: ({ schedule }) =>
        schedule?.pendingBilling
          ? {
              kind: 'value',
              value: formatCount(schedule.pendingBilling.count),
              detail:
                `Completed visits ready for invoice · ${formatMoney(schedule.pendingBilling.amount)}` +
                (schedule.pendingBilling.amountRequired > 0 ? ` · ${formatCount(schedule.pendingBilling.amountRequired)} need an amount` : ''),
              hint: 'Completed visits with an amount above zero and no active invoice. Visits not yet completed are never counted.',
            }
          : null,
    },
    {
      id: 'scheduledValue',
      label: 'Current Scheduled Value',
      icon: 'wallet',
      visible: (canView) => canView('AMC_SCHEDULE'),
      read: ({ schedule }) =>
        schedule?.currentScheduledValue
          ? {
              kind: 'value',
              value: formatMoney(schedule.currentScheduledValue.amount),
              unit: 'OMR',
              detail:
                `Visit amounts planned this month · ${plural(schedule.currentScheduledValue.visits, 'visit', 'visits')}` +
                (schedule.currentScheduledValue.amountMissing > 0 ? `, ${formatCount(schedule.currentScheduledValue.amountMissing)} without an amount` : ''),
              hint: 'Sum of the visit amounts of the visits planned this calendar month. A planned amount: not invoiced and not collected.',
            }
          : null,
    },
    {
      id: 'engine',
      label: 'Schedule Engine Status',
      icon: 'settings',
      visible: canVisits,
      read: ({ schedule }) =>
        schedule && {
          kind: 'value',
          value: schedule.engine.withoutSchedule === 0 ? 'In sync' : 'Attention',
          detail:
            schedule.engine.withoutSchedule === 0
              ? `Every active contract (${formatCount(schedule.engine.activeContracts)}) has scheduled visits`
              : `${formatCount(schedule.engine.withoutSchedule)} of ${plural(schedule.engine.activeContracts, 'active contract has', 'active contracts have')} no scheduled visits`,
          hint: 'Visits are generated when a contract is saved or its schedule is generated from the contract page. There is no background job.',
        },
    },
  ],
}

export const INVOICE_KPIS: KpiGroupDefinition = {
  id: 'invoices',
  title: 'Invoice KPIs',
  description: 'Invoices Generated and Not Generated follow the manual Invoice No. of each service (Paid / Unpaid on Accounts): a reference status, not verified payment.',
  visible: (canView) => canView('INVOICES'),
  kpis: [
    shared('paid'),
    shared('unpaid'),
    {
      id: 'paidTotal',
      label: 'Paid Invoice Total',
      icon: 'wallet',
      visible: (canView) => canView('INVOICES'),
      // The same total as the amount on Invoices Generated: services whose value was never recorded are not a real 0.000.
      read: ({ invoices }) => {
        if (!invoices) return null
        const missing = invoices.paidTotal.amountMissing ?? 0

        return invoices.paid.count > 0 && missing >= invoices.paid.count
          ? { kind: 'value', value: 'Not recorded', detail: `No value recorded on the ${plural(invoices.paid.count, 'Paid service', 'Paid services')}` }
          : {
              kind: 'value',
              value: formatMoney(invoices.paidTotal.amount),
              unit: 'OMR',
              detail: `Value of Paid services, excluding VAT` + (missing > 0 ? ` · ${formatCount(missing)} without amount` : ''),
              hint: `${invoiceAmountText(invoices.paid.count, invoices.paidTotal.amount, missing)}. The sum of the service values of the services with an Invoice No., as on Accounts; the Invoice No. itself carries no amount.`,
            }
      },
    },
    {
      id: 'module',
      label: 'Invoice Module Status',
      icon: 'pulse',
      visible: (canView) => canView('INVOICES'),
      read: ({ invoices }) =>
        invoices && {
          kind: 'value',
          value: 'Tracking',
          detail: `${plural(invoices.module.issued, 'issued invoice', 'issued invoices')} · ${formatCount(invoices.module.cancelled)} cancelled · Zoho records`,
          hint: 'Invoice Tracking records invoices raised in Zoho as Issued or Cancelled. They do not decide Paid or Unpaid: those follow the manual Invoice No. entered on Accounts, shown on the cards beside this one.',
        },
    },
  ],
}

export const KPI_GROUPS: KpiGroupDefinition[] = [CONTRACT_KPIS, SCHEDULE_KPIS, INVOICE_KPIS]

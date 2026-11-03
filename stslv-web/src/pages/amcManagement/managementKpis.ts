import { formatCount } from '../../lib/format'
import { formatMoney } from '../../lib/money'
import type { Module } from '../../lib/types'
import type { IconName } from '../dashboard/icons'
import type { KpiReading } from '../dashboard/kpis'
import type { AmcManagementSummary } from './managementTypes'

// The three KPI groups of AMC Management. Each card reads one figure the API
// returned; none is calculated here. A card whose figure the API left out (no
// permission) is not shown.

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

export const CONTRACT_KPIS: KpiGroupDefinition = {
  id: 'contracts',
  title: 'Contract KPIs',
  description: 'From the AMC contract register.',
  visible: (canView) => canView('AMC_CONTRACTS'),
  kpis: [
    {
      id: 'active',
      label: 'Active AMC',
      icon: 'contract',
      visible: (canView) => canView('AMC_CONTRACTS'),
      read: ({ contracts }) => ({
        kind: 'value',
        value: formatCount(contracts.active),
        detail: 'Contracts with status Active' + (contracts.activePastValidity > 0 ? ` · ${formatCount(contracts.activePastValidity)} past validity` : ''),
      }),
    },
    {
      id: 'value',
      label: 'Total AMC Value',
      icon: 'wallet',
      visible: (canView) => canView('AMC_CONTRACTS'),
      // AMC Value / Year of Active contracts, as entered. Values entered before that rule are not reinterpreted.
      read: ({ contracts }) => ({
        kind: 'value',
        value: formatMoney(contracts.activeValue),
        detail: 'Sum of AMC Value / Year, excluding VAT',
        hint: 'Sum of AMC Value / Year of every Active contract, as entered. Older multi-year values may be whole-term amounts: see the Contract Value Review report.',
      }),
    },
    {
      id: 'credit',
      label: 'Total Final Credit',
      icon: 'chart',
      visible: (canView) => canView('AMC_CONTRACTS'),
      // Final Credit Value, an annual Billing Basis option, summed as entered.
      read: ({ contracts }) => ({
        kind: 'value',
        value: formatMoney(contracts.finalCreditTotal),
        detail: 'Final Credit Value as entered',
        hint: `Sum of Final Credit Value as entered on ${formatCount(contracts.finalCreditRecorded)} of ${plural(contracts.active, 'active contract', 'active contracts')}.`,
      }),
    },
    {
      id: 'expiring',
      label: 'Expiring within 45 days',
      icon: 'shield',
      visible: (canView) => canView('AMC_CONTRACTS'),
      read: ({ contracts }) => ({
        kind: 'value',
        value: formatCount(contracts.expiringSoon),
        detail:
          `Active contracts ending within ${contracts.expiringSoonDays} days` +
          (contracts.expiringSoonWithRenewal ? ` · ${formatCount(contracts.expiringSoonWithRenewal)} with a renewal` : ''),
      }),
    },
  ],
}

export const SCHEDULE_KPIS: KpiGroupDefinition = {
  id: 'schedule',
  title: 'Schedule KPIs',
  description: 'From the visit schedule generated from each contract.',
  visible: canVisits,
  kpis: [
    {
      id: 'services',
      label: 'Services This Month',
      icon: 'calendar',
      visible: canVisits,
      read: ({ schedule }) =>
        schedule && {
          kind: 'value',
          value: formatCount(schedule.servicesThisMonth.planned),
          detail: `Planned visits · ${formatCount(schedule.servicesThisMonth.completed)} completed, ${formatCount(schedule.servicesThisMonth.open)} open`,
        },
    },
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
  description: 'Paid and Unpaid follow the manual Invoice No. of each service: a reference status, not verified payment.',
  visible: (canView) => canView('INVOICES'),
  kpis: [
    {
      id: 'paid',
      label: 'Paid Invoices',
      icon: 'invoice',
      visible: (canView) => canView('INVOICES'),
      read: ({ invoices }) => invoices && { kind: 'value', value: formatCount(invoices.paid.count), detail: 'Services with a manual Invoice No.' },
    },
    {
      id: 'unpaid',
      label: 'Unpaid Invoices',
      icon: 'invoice',
      visible: (canView) => canView('INVOICES'),
      read: ({ invoices }) => invoices && { kind: 'value', value: formatCount(invoices.unpaid.count), detail: `Services without one · ${formatMoney(invoices.unpaid.amount)}` },
    },
    {
      id: 'paidTotal',
      label: 'Paid Invoice Total',
      icon: 'wallet',
      visible: (canView) => canView('INVOICES'),
      read: ({ invoices }) => invoices && { kind: 'value', value: formatMoney(invoices.paidTotal.amount), detail: 'Value of Paid services, OMR excluding VAT' },
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

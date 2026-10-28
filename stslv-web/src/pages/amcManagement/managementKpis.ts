import { formatCount } from '../../lib/format'
import { formatMoney } from '../../lib/money'
import type { Module } from '../../lib/types'
import type { IconName } from '../dashboard/icons'
import type { KpiReading } from '../dashboard/kpis'
import type { AmcManagementSummary } from './managementTypes'

// The three KPI groups of AMC Management. Each card reads one figure the API
// returned; none is calculated here. A card whose figure the API left out (no
// permission) is not shown.

export interface ManagementKpi {
  id: string
  /** The standard name. A user may show a different name; the meaning stays this one. */
  label: string
  icon: IconName
  /** Mirrors the API's permission check, so the right cards show while loading. The API decides. */
  visible: (canView: (module: Module) => boolean) => boolean
  read: (data: AmcManagementSummary) => KpiReading | null
  link?: { to: string; label: string; module: Module }
}

export interface KpiGroupDefinition {
  id: 'contracts' | 'schedule' | 'invoices'
  title: string
  description: string
  visible: (canView: (module: Module) => boolean) => boolean
  kpis: ManagementKpi[]
}

const plural = (count: number, one: string, many: string) => `${formatCount(count)} ${count === 1 ? one : many}`

const CONTRACTS_LINK = { to: '/amc/contracts', label: 'View contracts', module: 'AMC_CONTRACTS' as Module }
const SCHEDULE_LINK = { to: '/amc/schedule', label: 'AMC Schedule', module: 'AMC_SCHEDULE' as Module }
const INVOICES_LINK = { to: '/invoices', label: 'Invoice Tracking', module: 'INVOICES' as Module }

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
      link: CONTRACTS_LINK,
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
      link: CONTRACTS_LINK,
      // The stored contract value of Active contracts, summed. Contracts run for different periods, so it is not annual.
      read: ({ contracts }) => ({
        kind: 'value',
        value: formatMoney(contracts.activeValue),
        detail: 'Sum of active contract values',
        hint: 'Sum of the contract value of every Active contract · not annualised, not invoiced, not collected',
      }),
    },
    {
      id: 'credit',
      label: 'Total Final Credit',
      icon: 'chart',
      visible: (canView) => canView('AMC_CONTRACTS'),
      link: CONTRACTS_LINK,
      // The meaning of Final Credit is not confirmed. It is summed as entered and never called revenue or collected.
      read: ({ contracts }) => ({
        kind: 'value',
        value: formatMoney(contracts.finalCreditTotal),
        detail: 'Final credit as entered · meaning not confirmed',
        hint: `Sum of the Final credit field as entered on ${formatCount(contracts.finalCreditRecorded)} of ${plural(contracts.active, 'active contract', 'active contracts')}. Its meaning is not yet confirmed by the client; it is not revenue.`,
      }),
    },
    {
      id: 'expiring',
      label: 'Expiring within 45 days',
      icon: 'shield',
      visible: (canView) => canView('AMC_CONTRACTS'),
      link: CONTRACTS_LINK,
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
      link: SCHEDULE_LINK,
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
      link: INVOICES_LINK,
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
      link: SCHEDULE_LINK,
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
      link: SCHEDULE_LINK,
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
  description: 'From Invoice Tracking (invoices raised in Zoho).',
  visible: (canView) => canView('INVOICES'),
  kpis: [
    {
      id: 'paid',
      label: 'Paid Invoices',
      icon: 'invoice',
      visible: (canView) => canView('INVOICES'),
      link: INVOICES_LINK,
      read: ({ invoices }) => invoices && { kind: 'unavailable', reason: invoices.paid.reason },
    },
    {
      id: 'unpaid',
      label: 'Unpaid Invoices',
      icon: 'invoice',
      visible: (canView) => canView('INVOICES'),
      link: INVOICES_LINK,
      read: ({ invoices }) => invoices && { kind: 'unavailable', reason: invoices.unpaid.reason },
    },
    {
      id: 'paidTotal',
      label: 'Paid Invoice Total',
      icon: 'wallet',
      visible: (canView) => canView('INVOICES'),
      link: INVOICES_LINK,
      read: ({ invoices }) => invoices && { kind: 'unavailable', reason: invoices.paidTotal.reason },
    },
    {
      id: 'module',
      label: 'Invoice Module Status',
      icon: 'pulse',
      visible: (canView) => canView('INVOICES'),
      link: INVOICES_LINK,
      read: ({ invoices }) =>
        invoices && {
          kind: 'value',
          value: 'Tracking',
          detail: `${plural(invoices.module.issued, 'issued invoice', 'issued invoices')} · ${formatCount(invoices.module.cancelled)} cancelled · payment not recorded`,
          hint: 'Invoice Tracking records invoices raised in Zoho as Issued or Cancelled. Payment status is not recorded, so paid and unpaid figures are unavailable.',
        },
    },
  ],
}

export const KPI_GROUPS: KpiGroupDefinition[] = [CONTRACT_KPIS, SCHEDULE_KPIS, INVOICE_KPIS]

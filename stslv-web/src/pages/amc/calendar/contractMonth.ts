import type { ScheduleVisit, VisitStatus } from '../types'

// Month view "By contract": the month's visits (the same GET /amc/visits result the grid
// shows) consolidated into one entry per AMC contract. Only counts are derived here;
// no amount is added up in the browser.

export interface ContractMonth {
  contractId: string
  reference: string
  client: string
  system: string
  engineer: string | null
  visits: ScheduleVisit[]
  counts: Record<VisitStatus, number>
  overdue: number
  paid: number
  unpaid: number
}

export const STATUS_ORDER: VisitStatus[] = ['SCHEDULED', 'IN_PROGRESS', 'POSTPONED', 'COMPLETED', 'CANCELLED', 'HISTORICAL']

export const STATUS_PILL: Record<VisitStatus, string> = {
  SCHEDULED: 'bg-sky-50 text-sky-900 ring-sky-200',
  IN_PROGRESS: 'bg-amber-50 text-amber-900 ring-amber-200',
  POSTPONED: 'bg-violet-50 text-violet-900 ring-violet-200',
  COMPLETED: 'bg-emerald-50 text-emerald-900 ring-emerald-200',
  CANCELLED: 'bg-slate-100 text-slate-600 ring-slate-200',
  HISTORICAL: 'bg-slate-100 text-slate-600 ring-slate-200',
}

/** One entry per contract, in the order of each contract's first visit of the month, then client and reference. */
export function groupByContract(visits: ScheduleVisit[]): ContractMonth[] {
  const groups = new Map<string, ContractMonth>()

  for (const visit of visits) {
    let group = groups.get(visit.contract.id)

    if (!group) {
      group = {
        contractId: visit.contract.id,
        reference: visit.contract.reference,
        client: visit.client.name,
        system: visit.contract.systemDescription,
        engineer: visit.assignedTo,
        visits: [],
        counts: { SCHEDULED: 0, IN_PROGRESS: 0, POSTPONED: 0, COMPLETED: 0, CANCELLED: 0, HISTORICAL: 0 },
        overdue: 0,
        paid: 0,
        unpaid: 0,
      }
      groups.set(visit.contract.id, group)
    }

    group.visits.push(visit)
    group.counts[visit.status] += 1
    if (visit.isOverdue) group.overdue += 1
    // Paid / Unpaid follow the manual Invoice No., as on the month grid; a cancelled visit counts in neither.
    if (visit.status !== 'CANCELLED') {
      if (visit.manualInvoiceNo) group.paid += 1
      else group.unpaid += 1
    }
  }

  for (const group of groups.values()) {
    group.visits.sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate) || a.sequenceNo - b.sequenceNo)
  }

  return [...groups.values()].sort(
    (a, b) => (a.visits[0]?.scheduledDate ?? '').localeCompare(b.visits[0]?.scheduledDate ?? '') || a.client.localeCompare(b.client) || a.reference.localeCompare(b.reference),
  )
}

/** The contract's state this month, in words, so colour is never the only signal. */
export function contractMonthStatus(group: ContractMonth): { label: string; className: string } {
  const active = group.visits.length - group.counts.CANCELLED
  if (active === 0) return { label: 'Cancelled', className: STATUS_PILL.CANCELLED }
  if (group.overdue > 0) return { label: 'Overdue', className: 'bg-red-50 text-red-800 ring-red-200' }
  if (group.counts.COMPLETED === active) return { label: 'All completed', className: STATUS_PILL.COMPLETED }
  if (group.counts.COMPLETED > 0) return { label: 'Partly completed', className: STATUS_PILL.IN_PROGRESS }
  return { label: 'Open', className: STATUS_PILL.SCHEDULED }
}

import { ContractLink } from '../../../components/ContractLink'
import { cx } from '../../../lib/format'
import { formatDate } from '../amcFormat'
import { VISIT_STATUS_LABELS, type ScheduleVisit } from '../types'
import { contractMonthStatus, groupByContract, STATUS_ORDER, STATUS_PILL as PILL } from './contractMonth'

const servicesText = (count: number) => `${count} ${count === 1 ? 'service' : 'services'}`

interface ContractMonthViewProps {
  visits: ScheduleVisit[]
  monthName: string
  onOpenVisit: (id: string) => void
}

export function ContractMonthView({ visits, monthName, onOpenVisit }: ContractMonthViewProps) {
  const groups = groupByContract(visits)

  if (groups.length === 0) return null

  return (
    <ol aria-label={`Contracts with visits in ${monthName}`} className="divide-y divide-slate-200">
      {groups.map((group) => {
        const state = contractMonthStatus(group)
        const active = group.visits.length - group.counts.CANCELLED

        return (
          <li key={group.contractId} className="px-4 py-4 sm:px-5">
            <article aria-label={`${group.client}, ${group.system}, ${servicesText(active)}`} className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <ContractLink id={group.contractId} className="font-mono text-xs font-semibold text-blue-700 hover:underline" hideWithoutAccess>
                    {group.reference}
                  </ContractLink>
                  <span className={cx('rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset', state.className)}>{state.label}</span>
                </div>
                <h3 className="mt-1 break-words text-sm font-bold text-slate-900">
                  {group.client} <span className="font-semibold text-slate-600">— {group.system}</span>
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">Engineer: {group.engineer ?? '—'}</p>

                <ul aria-label="Services this month" className="mt-2 flex flex-wrap gap-1.5">
                  {group.visits.map((visit) => (
                    <li key={visit.id}>
                      <button
                        type="button"
                        onClick={() => onOpenVisit(visit.id)}
                        aria-label={`${visit.serviceCode ?? `Visit ${visit.sequenceNo}`}, ${formatDate(visit.scheduledDate)}, ${VISIT_STATUS_LABELS[visit.status]}${visit.isOverdue ? ', overdue' : ''}, ${visit.manualInvoiceNo ? 'Paid' : 'Unpaid'}`}
                        className={cx(
                          'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold ring-1 ring-inset hover:ring-2 hover:ring-[#1479BD] focus-visible:outline-2 focus-visible:outline-[#1479BD]',
                          PILL[visit.status],
                          visit.status === 'CANCELLED' && 'line-through',
                        )}
                      >
                        <span className={cx('inline-block h-2 w-2 rounded-sm', visit.manualInvoiceNo ? 'bg-emerald-600' : 'bg-[#1479BD]')} aria-hidden="true" />
                        {visit.serviceCode ?? `#${visit.sequenceNo}`} · {formatDate(visit.scheduledDate)}
                        {visit.isOverdue && <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden="true" />}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>

              <dl className="grid shrink-0 grid-cols-3 gap-2 text-center sm:w-auto lg:w-72">
                <div className="rounded-lg bg-slate-50 px-2 py-1.5 ring-1 ring-inset ring-slate-200">
                  <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Services</dt>
                  <dd className="text-lg font-extrabold tabular-nums text-[#0b3b66]">{active}</dd>
                </div>
                <div className="rounded-lg bg-emerald-50 px-2 py-1.5 ring-1 ring-inset ring-emerald-200">
                  <dt className="text-[10px] font-semibold uppercase tracking-wider text-emerald-800">Paid</dt>
                  <dd className="text-lg font-extrabold tabular-nums text-emerald-800">{group.paid}</dd>
                </div>
                <div className="rounded-lg bg-sky-50 px-2 py-1.5 ring-1 ring-inset ring-sky-200">
                  <dt className="text-[10px] font-semibold uppercase tracking-wider text-[#1479BD]">Unpaid</dt>
                  <dd className="text-lg font-extrabold tabular-nums text-[#1479BD]">{group.unpaid}</dd>
                </div>
                <div className="col-span-3 flex flex-wrap justify-center gap-1">
                  {STATUS_ORDER.filter((status) => group.counts[status] > 0).map((status) => (
                    <span key={status} className={cx('rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset', PILL[status])}>
                      <span className="tabular-nums">{group.counts[status]}</span> {VISIT_STATUS_LABELS[status].toLowerCase()}
                    </span>
                  ))}
                  {group.overdue > 0 && (
                    <span className="rounded bg-red-50 px-1.5 py-0.5 text-[11px] font-medium text-red-800 ring-1 ring-inset ring-red-200">
                      <span className="tabular-nums">{group.overdue}</span> overdue
                    </span>
                  )}
                </div>
              </dl>
            </article>
          </li>
        )
      })}
    </ol>
  )
}

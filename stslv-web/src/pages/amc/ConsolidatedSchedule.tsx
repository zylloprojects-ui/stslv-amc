import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useAuth } from '../../auth/context'
import { ExportButtons } from '../../components/ExportButtons'
import { TABLE } from '../../components/table'
import { Alert, Card, EmptyState, Spinner } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { cx } from '../../lib/format'
import { queryString } from './amcApi'
import { currentMonth, formatDate, formatMoney, monthLabel } from './amcFormat'
import { Filter, Pager } from './components'
import { VISIT_STATUS_LABELS, type VisitStatus } from './types'

interface MonthlyService {
  id: string
  serviceCode: string | null
  sequenceNo: number
  scheduledDate: string
  status: VisitStatus
  visitValue: string | null
  invoiceNumbers: string[]
}

interface MonthlyRow {
  id: string
  reference: string
  client: { id: string; name: string }
  systemDescription: string
  frequency: string
  salesEngineer: string | null
  services: MonthlyService[]
  totalValue: string
}

interface MonthlyList {
  items: MonthlyRow[]
  total: number
  page: number
  pageSize: number
  totals: { contracts: number; services: number; completed: number; totalValue: string }
}

const PAGE_SIZE = 50
const TONE: Partial<Record<VisitStatus, string>> = {
  COMPLETED: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
  IN_PROGRESS: 'bg-amber-100 text-amber-900 ring-amber-200',
  POSTPONED: 'bg-violet-100 text-violet-900 ring-violet-200',
}

/** One row per AMC with its services of the month. The detailed visits stay in the Visits view. */
export function ConsolidatedSchedule() {
  const auth = useAuth()
  const [month, setMonth] = useState(currentMonth)
  const [search, setSearch] = useState('')
  const [applied, setApplied] = useState('')
  const [page, setPage] = useState(1)
  const [exportError, setExportError] = useState<string | null>(null)

  const list = useQuery({
    queryKey: ['amc', 'visits', 'monthly', { month, applied, page }],
    queryFn: () => api.get<MonthlyList>(`/amc/visits/monthly-consolidated${queryString({ month, search: applied, page, pageSize: PAGE_SIZE })}`),
    placeholderData: keepPreviousData,
    enabled: month !== '',
  })
  const data = list.data

  return (
    <Card>
      <div className="border-b border-slate-200 p-4 sm:px-5">
        <form
          className="grid items-end gap-4 sm:grid-cols-2 lg:grid-cols-4"
          aria-label="Consolidated filters"
          onSubmit={(event) => {
            event.preventDefault()
            setApplied(search.trim())
            setPage(1)
          }}
        >
          <Filter label="Month">
            {(id, className) => (
              <input
                id={id}
                type="month"
                value={month}
                onChange={(event) => {
                  setMonth(event.target.value)
                  setPage(1)
                }}
                className={className}
              />
            )}
          </Filter>
          <Filter label="Search">{(id, className) => <input id={id} type="search" value={search} onChange={(event) => setSearch(event.target.value)} onBlur={() => setApplied(search.trim())} placeholder="AMC reference, client or system" className={className} />}</Filter>
          {auth.can('AMC_SCHEDULE', 'EXPORT') && month !== '' && (
            <div className="lg:col-span-2 lg:justify-self-end">
              <ExportButtons what="consolidated schedule" fileStem={`amc-monthly-schedule-${month}`} path={(format) => `/amc/visits/monthly-consolidated/export${queryString({ month, search: applied, format })}`} onError={setExportError} />
            </div>
          )}
        </form>
        {data && (
          <p className="mt-3 text-sm text-slate-600" aria-live="polite">
            {monthLabel(month)}: <span className="font-semibold text-slate-900">{data.totals.contracts}</span> AMC contracts, <span className="font-semibold text-slate-900">{data.totals.services}</span> services, <span className="font-semibold text-slate-900">{data.totals.completed}</span> completed, visit value <span className="font-semibold text-slate-900">{formatMoney(data.totals.totalValue)}</span>
          </p>
        )}
      </div>

      {exportError && (
        <div className="p-4">
          <Alert onDismiss={() => setExportError(null)}>{exportError}</Alert>
        </div>
      )}
      {month === '' && <EmptyState title="Select a month" />}
      {month !== '' && list.isPending && <Spinner label="Loading schedule" />}
      {list.isError && (
        <div className="p-4">
          <Alert>{errorMessage(list.error)}</Alert>
        </div>
      )}
      {data && data.items.length === 0 && <EmptyState title="No services this month" description="Try another month or clear the search." />}
      {data && data.items.length > 0 && (
        <>
          <div className={TABLE.wrapper}>
            <table className={TABLE.table}>
              <caption className="sr-only">Consolidated monthly schedule</caption>
              <thead>
                <tr>
                  {['AMC Reference', 'Client', 'System', 'Frequency', 'Sales Engineer', 'Services', 'Visit Value'].map((heading) => (
                    <th key={heading} scope="col" className={cx(TABLE.th, heading === 'Visit Value' && 'text-right')}>
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.items.map((row) => (
                  <tr key={row.id} className={TABLE.row}>
                    <td className={cx(TABLE.td, 'whitespace-nowrap font-mono text-sm font-semibold text-[#0b3b66]')}>{row.reference}</td>
                    <td className={cx(TABLE.td, TABLE.text, 'font-semibold text-slate-900')}>{row.client.name}</td>
                    <td className={cx(TABLE.td, TABLE.text)}>{row.systemDescription}</td>
                    <td className={cx(TABLE.td, 'whitespace-nowrap')}>{row.frequency}</td>
                    <td className={cx(TABLE.td, TABLE.text)}>{row.salesEngineer ?? '—'}</td>
                    <td className={TABLE.td}>
                      <ul className="flex flex-wrap gap-1.5">
                        {row.services.map((service) => (
                          <li
                            key={service.id}
                            title={`${formatDate(service.scheduledDate)} · ${VISIT_STATUS_LABELS[service.status]}${service.invoiceNumbers.length ? ` · Invoice ${service.invoiceNumbers.join(', ')}` : ' · No invoice recorded'}`}
                            className={cx('rounded-md px-2 py-0.5 font-mono text-xs font-semibold ring-1 ring-inset', TONE[service.status] ?? 'bg-sky-100 text-[#0b3b66] ring-sky-200')}
                          >
                            {service.serviceCode ?? `No. ${service.sequenceNo}`}
                            <span className="sr-only">, {VISIT_STATUS_LABELS[service.status]}</span>
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className={cx(TABLE.td, 'whitespace-nowrap text-right font-semibold tabular-nums')}>{formatMoney(row.totalValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} shown={data.items.length} onPage={setPage} />
        </>
      )}
    </Card>
  )
}

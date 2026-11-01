import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../../auth/context'
import { ExportButtons } from '../../components/ExportButtons'
import { TABLE } from '../../components/table'
import { Alert, Card, EmptyState, OptionsNotice, PageHeader, Spinner } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { cx, formatDate } from '../../lib/format'
import { formatMoney } from '../../lib/money'
import { queryString } from '../amc/amcApi'
import { Filter, Pager } from '../amc/components'

interface Catalogue {
  id: string
  title: string
  description: string
  filters: ReportFilter[]
  /** The choices of the Status filter: the contract's status, or the visit's on a report over visits. */
  statuses?: { value: string; label: string }[]
}

type ReportFilter = 'dates' | 'client' | 'engineer' | 'system' | 'status' | 'payment'

interface ReportKpi {
  id: string
  label: string
  kind: 'count' | 'money'
  value: string
  hint: string | null
}

interface Column {
  key: string
  header: string
  kind: 'text' | 'identifier' | 'date' | 'money' | 'count'
}

interface ReportData {
  title: string
  columns: Column[]
  rows: Record<string, string | number | null>[]
  total: number
  page: number
  pageSize: number
  totals: Record<string, string>
  kpis?: ReportKpi[]
  notes: string[]
}

interface FilterOptions {
  clients: { id: string; name: string }[]
  salesEngineers: { id: string; name: string }[]
  systems: string[]
}

const PAGE_SIZE = 50

function cell(column: Column, value: string | number | null | undefined) {
  if (value === null || value === undefined || value === '') return '—'
  if (column.kind === 'money') return formatMoney(String(value))
  if (column.kind === 'date') return formatDate(String(value))
  return String(value)
}

const numeric = (column: Column) => column.kind === 'money' || column.kind === 'count'

/** The figures above a report that has any, from the API's row count and totals. */
function KpiStrip({ title, kpis }: { title: string; kpis: ReportKpi[] }) {
  return (
    <dl aria-label={`${title} figures`} className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-2 sm:px-5 xl:grid-cols-4">
      {kpis.map((kpi) => (
        <div key={kpi.id} data-kpi={kpi.id} className="min-w-0 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
          <dt className="text-sm font-semibold text-slate-600">{kpi.label}</dt>
          <dd className="mt-0.5 break-words text-2xl font-bold tabular-nums tracking-tight text-[#0b3b66]">{kpi.kind === 'money' ? formatMoney(kpi.value) : kpi.value}</dd>
          {kpi.hint && <dd className="mt-1 text-xs text-slate-500">{kpi.hint}</dd>}
        </div>
      ))}
    </dl>
  )
}

/** The reports over the live records. Every figure and total comes from the API. */
export function ReportsPage() {
  const auth = useAuth()
  // ?report= opens one report directly, as the Dashboard's Expiring Contracts link does. An unknown id loads nothing and asks for a report.
  const [searchParams] = useSearchParams()
  const [type, setType] = useState(searchParams.get('report') ?? 'contract-summary')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [clientId, setClientId] = useState('')
  const [salesEngineerId, setSalesEngineerId] = useState('')
  const [system, setSystem] = useState('')
  const [status, setStatus] = useState('')
  const [payment, setPayment] = useState('')
  const [page, setPage] = useState(1)
  const [exportError, setExportError] = useState<string | null>(null)

  const catalogue = useQuery({ queryKey: ['reports', 'catalogue'], queryFn: () => api.get<Catalogue[]>('/reports') })
  const options = useQuery({ queryKey: ['reports', 'options'], queryFn: () => api.get<FilterOptions>('/reports/options') })
  const chosen = catalogue.data?.find((item) => item.id === type)
  const offers = (filter: ReportFilter) => chosen?.filters.includes(filter) ?? false
  const statuses = chosen?.statuses ?? []
  // A status kept from another report applies only if this report has it too.
  const applied = {
    from: offers('dates') ? from : '',
    to: offers('dates') ? to : '',
    clientId: offers('client') ? clientId : '',
    salesEngineerId: offers('engineer') ? salesEngineerId : '',
    system: offers('system') ? system : '',
    status: offers('status') && statuses.some((option) => option.value === status) ? status : '',
    payment: offers('payment') ? payment : '',
  }
  const rangeInvalid = from !== '' && to !== '' && from > to

  const report = useQuery({
    queryKey: ['reports', type, applied, page],
    queryFn: () => api.get<ReportData>(`/reports/${type}${queryString({ ...applied, page, pageSize: PAGE_SIZE })}`),
    placeholderData: keepPreviousData,
    enabled: !rangeInvalid && chosen !== undefined,
  })
  const data = report.data
  const change = (set: (value: string) => void) => (event: { target: { value: string } }) => {
    set(event.target.value)
    setPage(1)
  }

  return (
    <>
      <PageHeader
        title="Reports"
        description="Reports from the live records, with the same figures as the source pages."
        actions={
          auth.can('REPORTS', 'EXPORT') && !rangeInvalid ? (
            <ExportButtons what={chosen?.title ?? 'report'} fileStem={`report-${type}`} path={(format) => `/reports/${type}/export${queryString({ ...applied, format })}`} onError={setExportError} />
          ) : undefined
        }
      />

      {exportError && (
        <div className="mb-4">
          <Alert onDismiss={() => setExportError(null)}>{exportError}</Alert>
        </div>
      )}

      <Card>
        <div className="grid gap-4 border-b border-slate-200 p-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-5">
          <Filter label="Report">
            {(id, className) => (
              <select id={id} value={type} onChange={change(setType)} className={className}>
                {catalogue.data && !chosen && <option value={type}>Select a report</option>}
                {(catalogue.data ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            )}
          </Filter>
          {offers('dates') && <Filter label="From">{(id, className) => <input id={id} type="date" value={from} onChange={change(setFrom)} className={className} />}</Filter>}
          {offers('dates') && <Filter label="To">{(id, className) => <input id={id} type="date" value={to} onChange={change(setTo)} className={className} />}</Filter>}
          {offers('client') && options.isSuccess && (
            <Filter label="Client">
              {(id, className) => (
                <select id={id} value={clientId} onChange={change(setClientId)} className={className}>
                  <option value="">All clients</option>
                  <OptionsNotice source={options} count={options.data?.clients.length ?? 0} empty="No clients" />
                  {(options.data?.clients ?? []).map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.name}
                    </option>
                  ))}
                </select>
              )}
            </Filter>
          )}
          {offers('engineer') && options.isSuccess && (
            <Filter label="Sales Engineer">
              {(id, className) => (
                <select id={id} value={salesEngineerId} onChange={change(setSalesEngineerId)} className={className}>
                  <option value="">All sales engineers</option>
                  <OptionsNotice source={options} count={options.data?.salesEngineers.length ?? 0} empty="No sales engineers" />
                  {(options.data?.salesEngineers ?? []).map((engineer) => (
                    <option key={engineer.id} value={engineer.id}>
                      {engineer.name}
                    </option>
                  ))}
                </select>
              )}
            </Filter>
          )}
          {offers('system') && options.isSuccess && (
            <Filter label="System">
              {(id, className) => (
                <select id={id} value={system} onChange={change(setSystem)} className={className}>
                  <option value="">All systems</option>
                  <OptionsNotice source={options} count={options.data?.systems.length ?? 0} empty="No systems" />
                  {(options.data?.systems ?? []).map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              )}
            </Filter>
          )}
          {offers('status') && statuses.length > 0 && (
            <Filter label="Status">
              {(id, className) => (
                <select id={id} value={applied.status} onChange={change(setStatus)} className={className}>
                  <option value="">All statuses</option>
                  {statuses.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
            </Filter>
          )}
          {offers('payment') && (
            <Filter label="Paid / Unpaid">
              {(id, className) => (
                <select id={id} value={payment} onChange={change(setPayment)} className={className}>
                  <option value="">All</option>
                  <option value="PAID">Paid</option>
                  <option value="UNPAID">Unpaid</option>
                </select>
              )}
            </Filter>
          )}
        </div>
        {chosen && <p className="border-b border-slate-200 px-5 py-3 text-sm text-slate-600">{chosen.description}</p>}
        {data && data.kpis && data.kpis.length > 0 && <KpiStrip title={data.title} kpis={data.kpis} />}

        {rangeInvalid && <p className="px-5 py-4 text-sm text-red-700">The From date is after the To date.</p>}
        {!rangeInvalid && report.isPending && (chosen || catalogue.isPending) && <Spinner label="Loading report" />}
        {report.isError && (
          <div className="p-4">
            <Alert>{errorMessage(report.error)}</Alert>
          </div>
        )}
        {data && data.rows.length === 0 && <EmptyState title="No records match these filters" description="Try a different report or filter." />}
        {data && data.rows.length > 0 && (
          <>
            <div className={TABLE.wrapper}>
              <table className={TABLE.table}>
                <caption className="sr-only">{data.title}</caption>
                <thead>
                  <tr>
                    {data.columns.map((column) => (
                      <th key={column.key} scope="col" className={cx(TABLE.th, numeric(column) && 'text-right')}>
                        {column.header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.rows.map((row, index) => (
                    <tr key={index} className={TABLE.row}>
                      {data.columns.map((column) => (
                        <td key={column.key} className={cx(TABLE.td, numeric(column) && 'whitespace-nowrap text-right tabular-nums')}>
                          {cell(column, row[column.key])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-300 font-semibold">
                    {data.columns.map((column, index) => (
                      <td key={column.key} className={cx(TABLE.td, numeric(column) && 'whitespace-nowrap text-right tabular-nums')}>
                        {data.totals[column.key] !== undefined ? cell(column, data.totals[column.key]) : index === 0 ? `Total (${data.total})` : ''}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} shown={data.rows.length} onPage={setPage} />
            {data.notes.length > 0 && (
              <ul className="border-t border-slate-200 px-5 py-3 text-xs text-slate-500">
                {data.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </Card>
    </>
  )
}

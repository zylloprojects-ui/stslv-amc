import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useId, useState } from 'react'
import { useAuth } from '../../auth/context'
import { FILTER_INPUT, FILTER_LABEL, LoadError, Money, Pager } from '../../components/records'
import { TABLE } from '../../components/table'
import { Badge, Button, EmptyState, PageHeader, Spinner, TableScroll } from '../../components/ui'
import { api } from '../../lib/api'
import { formatDate } from '../../lib/format'
import type { Paged } from '../../lib/types'
import { HistoricalRowModal, RecordLink, ReviewStatusBadge } from './HistoricalRowModal'
import { ImportAuditPanel, type InvoiceFilter } from './ImportAuditPanel'
import { invoiceLabel, KIND_LABELS, KIND_PLURALS, reasonLabel, RECORD_KINDS, sourceAmount, sourceReference, type RecordKind, type ReviewRow, type ReviewTotals } from './types'

type KindFilter = 'all' | RecordKind
type StatusFilter = 'all' | 'imported' | 'provisional'
type Tab = 'records' | 'audit'

const PAGE_SIZE = 25

// The built-in administrator role. The API refuses the Import Audit to anyone else.
const ADMIN_ROLE_CODE = 'ADMIN'

const PANEL = 'overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm'
const FOCUS_RING = 'focus:border-[#1479BD] focus:outline-none focus:ring-4 focus:ring-sky-200/60'

const INVOICE_FILTER_LABELS: Record<Exclude<InvoiceFilter, 'all'>, string> = {
  with: 'Has an invoice cell',
  shared: 'Shared or several invoices',
  marker: 'A word, not a number',
}

/** One headline figure. Choosing it lists those records. */
function SummaryCard({ label, value, color, hint, pressed, onClick }: { label: string; value: number; color: string; hint: string; pressed: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`relative overflow-hidden rounded-2xl border bg-white p-4 pl-5 text-left shadow-sm hover:shadow-md ${FOCUS_RING} ${pressed ? 'border-[#1479BD] ring-2 ring-sky-200' : 'border-slate-200'}`}
    >
      <span className="absolute inset-y-0 left-0 w-1.5" style={{ backgroundColor: color }} aria-hidden="true" />
      <span className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</span>
      <span className="mt-1 block text-3xl font-bold tabular-nums text-[#0b3b66]">{value}</span>
      <span className="mt-1 block text-xs text-slate-600">{hint}</span>
    </button>
  )
}

/** What the application holds, or would hold, for the record: one line for the table. */
function proposedLine(row: ReviewRow): string {
  const value = (key: string): string | null => {
    const found = row.proposedValues[key]

    return typeof found === 'string' && found !== '' ? found : null
  }

  if (row.kind === 'CLIENT') {
    return value('masterName') ?? '—'
  }
  if (row.kind === 'PROJECT') {
    return [value('clientName'), value('sourceJobDate'), value('legacyStatus')].filter(Boolean).join(' · ') || '—'
  }

  const period = row.kind === 'AMC_VISIT' ? value('periodStart') : value('validFrom')
  const until = row.kind === 'AMC_VISIT' ? value('periodEnd') : value('validTo')

  return [value('clientName'), value('systemDescription'), period ? `${formatDate(period)}${until ? ` – ${formatDate(until)}` : ''}` : null].filter(Boolean).join(' · ') || '—'
}

/** A filter set from the Import Audit, with a way to remove it. */
function AppliedFilter({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 py-0.5 pl-3 pr-1 text-xs font-medium text-sky-900">
      {label}
      <Button variant="ghost" size="sm" aria-label={`Remove filter: ${label}`} onClick={onRemove}>
        ✕
      </Button>
    </span>
  )
}

export function HistoricalDataPage() {
  const auth = useAuth()
  const searchId = useId()
  const kindId = useId()
  const statusId = useId()

  const [tab, setTab] = useState<Tab>('records')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState<KindFilter>('all')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [reason, setReason] = useState('')
  const [invoice, setInvoice] = useState<InvoiceFilter>('all')
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState<ReviewRow | null>(null)

  const isAdmin = auth.user?.roles.some((role) => role.code === ADMIN_ROLE_CODE) ?? false

  // Wait for a pause in typing before searching.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 300)

    return () => clearTimeout(timer)
  }, [searchInput])

  const summary = useQuery({ queryKey: ['historical-data', 'summary'], queryFn: () => api.get<ReviewTotals>('/historical-data/summary') })
  const rows = useQuery({
    queryKey: ['historical-data', 'rows', { search, kind, status, reason, invoice, page }],
    queryFn: () => {
      const params = new URLSearchParams({ kind, status, invoice, page: String(page), pageSize: String(PAGE_SIZE) })

      if (search) params.set('search', search)
      if (reason) params.set('reason', reason)

      return api.get<Paged<ReviewRow>>(`/historical-data/rows?${params.toString()}`)
    },
    placeholderData: keepPreviousData,
  })

  const data = rows.data
  const totals = summary.data?.totals
  const filtered = search !== '' || kind !== 'all' || status !== 'all' || reason !== '' || invoice !== 'all'
  const nothingLoaded = totals?.records === 0
  const change = <T,>(set: (value: T) => void) => (value: T) => {
    set(value)
    setPage(1)
  }
  const clearFilters = () => {
    setSearchInput('')
    setSearch('')
    setKind('all')
    setStatus('all')
    setReason('')
    setInvoice('all')
    setPage(1)
  }
  /** Lists the records of one status, from a summary card. */
  const showStatus = (value: StatusFilter) => {
    clearFilters()
    setStatus(value)
    setTab('records')
  }
  const cardPressed = (value: StatusFilter) => tab === 'records' && status === value && reason === '' && invoice === 'all'

  const tabButton = (value: Tab, label: string) => (
    <button
      type="button"
      role="tab"
      id={`historical-tab-${value}`}
      aria-selected={tab === value}
      aria-controls="historical-tabpanel"
      onClick={() => setTab(value)}
      className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium ${tab === value ? 'border-blue-700 text-blue-800' : 'border-transparent text-slate-600 hover:text-slate-900'}`}
    >
      {label}
    </button>
  )

  const records = (
    <div className={PANEL}>
      <div className="border-b border-slate-200 bg-slate-50/70 p-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2">
            <label htmlFor={searchId} className={FILTER_LABEL}>
              Search
            </label>
            <input
              id={searchId}
              type="search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Job number, client, invoice number"
              className={`${FILTER_INPUT} ${FOCUS_RING}`}
            />
          </div>
          <div>
            <label htmlFor={kindId} className={FILTER_LABEL}>
              Record type
            </label>
            <select id={kindId} value={kind} onChange={(event) => change(setKind)(event.target.value as KindFilter)} className={`${FILTER_INPUT} ${FOCUS_RING}`}>
              <option value="all">All types</option>
              {RECORD_KINDS.map((option) => (
                <option key={option} value={option}>
                  {KIND_PLURALS[option]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={statusId} className={FILTER_LABEL}>
              Status
            </label>
            <select id={statusId} value={status} onChange={(event) => change(setStatus)(event.target.value as StatusFilter)} className={`${FILTER_INPUT} ${FOCUS_RING}`}>
              <option value="all">All</option>
              <option value="imported">Imported</option>
              <option value="provisional">Needs Review</option>
            </select>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-600">
          {data && <span>{filtered ? `${data.total} matching` : `${data.total} in total`}</span>}
          {reason !== '' && <AppliedFilter label={`Reason: ${reasonLabel(reason)}`} onRemove={() => change(setReason)('')} />}
          {invoice !== 'all' && <AppliedFilter label={`Invoice reference: ${INVOICE_FILTER_LABELS[invoice]}`} onRemove={() => change(setInvoice)('all')} />}
        </div>
      </div>

      {rows.isPending && <Spinner label="Loading records" />}
      {rows.isError && <LoadError error={rows.error} onRetry={() => void rows.refetch()} />}

      {data && data.items.length === 0 && (
        <EmptyState
          title="No records match these filters"
          description="Try a different search or filter."
          action={
            filtered ? (
              <Button variant="secondary" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      )}

      {data && data.items.length > 0 && (
        <>
          <TableScroll label="Historical records">
            <table className={TABLE.table}>
              <caption className="sr-only">Historical records</caption>
              <thead>
                <tr>
                  <th scope="col" className={TABLE.th}>
                    Type
                  </th>
                  <th scope="col" className={TABLE.th}>
                    Source record
                  </th>
                  <th scope="col" className={TABLE.th}>
                    Details
                  </th>
                  <th scope="col" className={`${TABLE.th} text-right`}>
                    Value
                  </th>
                  <th scope="col" className={TABLE.th}>
                    Invoice reference
                  </th>
                  <th scope="col" className={TABLE.th}>
                    Status
                  </th>
                  <th scope="col" className={`${TABLE.th} text-right`}>
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.items.map((row) => {
                  const amount = sourceAmount(row)

                  return (
                    <tr key={row.id} className={TABLE.row}>
                      <td className={`${TABLE.td} whitespace-nowrap`}>
                        <Badge>{KIND_LABELS[row.kind]}</Badge>
                      </td>
                      <td className={`${TABLE.td} ${TABLE.text}`}>
                        <span className="font-semibold text-slate-900">{row.identifier}</span>
                        <span className="block text-xs text-slate-600">{sourceReference(row.source)}</span>
                      </td>
                      <td className={`${TABLE.td} ${TABLE.text}`}>
                        {proposedLine(row)}
                        {row.status === 'IMPORTED' && row.link ? (
                          <span className="block text-xs">
                            <RecordLink link={row.link} />
                          </span>
                        ) : (
                          <span className="block text-xs text-amber-900">
                            {row.holdReasons[0] ? reasonLabel(row.holdReasons[0].code) : 'Not added to the application'}
                            {row.holdReasons.length > 1 && ` (+${row.holdReasons.length - 1} more)`}
                          </span>
                        )}
                      </td>
                      <td className={`${TABLE.td} whitespace-nowrap text-right`}>
                        {row.kind === 'CLIENT' ? <span className="text-slate-400">—</span> : amount === null ? <span className="text-slate-600">Not given</span> : <Money value={amount} className="font-medium text-slate-900" />}
                      </td>
                      <td className={`${TABLE.td} ${TABLE.unbroken}`}>
                        {row.invoiceReference?.rawCell ?? <span className="text-slate-400">—</span>}
                        {row.invoiceReference && !['NO_INVOICE_REFERENCE', 'ONE_JOB_ONE_INVOICE', 'AMC_PERIOD_ONE_INVOICE'].includes(row.invoiceReference.classification) && (
                          <span className="block break-normal text-xs text-slate-600">{invoiceLabel(row.invoiceReference.classification)}</span>
                        )}
                      </td>
                      <td className={`${TABLE.td} whitespace-nowrap`}>
                        <ReviewStatusBadge status={row.status} />
                      </td>
                      <td className={`${TABLE.td} whitespace-nowrap text-right`}>
                        <Button variant="ghost" size="sm" aria-label={`View ${KIND_LABELS[row.kind]} ${row.identifier}, row ${row.source.row}`} onClick={() => setOpen(row)}>
                          View
                        </Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableScroll>
          <Pager page={data.page} pageSize={data.pageSize} shown={data.items.length} total={data.total} onPage={setPage} />
        </>
      )}
    </div>
  )

  return (
    <>
      <PageHeader title="Historical Data" />

      {summary.isPending && <Spinner label="Loading summary" />}
      {summary.isError && <LoadError error={summary.error} onRetry={() => void summary.refetch()} />}

      {nothingLoaded && (
        <div className={PANEL}>
          <EmptyState
            title="No historical data has been loaded yet"
            description="The Excel registers have not been imported into this database. Once they are, every source record appears here."
          />
        </div>
      )}

      {totals && !nothingLoaded && (
        <>
          <div className="mb-5 grid gap-4 sm:grid-cols-3">
            <SummaryCard label="Total Records" value={totals.records} color="#1B8AD3" hint="Every record of the earlier Excel registers" pressed={cardPressed('all') && !filtered} onClick={() => showStatus('all')} />
            <SummaryCard label="Imported" value={totals.imported} color="#5BAF48" hint="Also in the normal pages, marked as historical" pressed={cardPressed('imported')} onClick={() => showStatus('imported')} />
            <SummaryCard label="Needs Review" value={totals.provisional} color="#F5C622" hint="Awaiting client clarification; kept on this page only" pressed={cardPressed('provisional')} onClick={() => showStatus('provisional')} />
          </div>

          {isAdmin ? (
            <>
              <div role="tablist" aria-label="Historical data" className="mb-4 flex overflow-x-auto border-b border-slate-200">
                {tabButton('records', 'Records')}
                {tabButton('audit', 'Import Audit')}
              </div>
              <div role="tabpanel" id="historical-tabpanel" aria-labelledby={`historical-tab-${tab}`}>
                {tab === 'records' ? (
                  records
                ) : (
                  <ImportAuditPanel
                    onReason={(reasonKind, code) => {
                      setKind(reasonKind)
                      setStatus('provisional')
                      setReason(code)
                      setInvoice('all')
                      setPage(1)
                      setTab('records')
                    }}
                    onInvoice={(filter) => {
                      clearFilters()
                      setInvoice(filter)
                      setTab('records')
                    }}
                  />
                )}
              </div>
            </>
          ) : (
            records
          )}
        </>
      )}

      {open && <HistoricalRowModal row={open} onClose={() => setOpen(null)} />}
    </>
  )
}

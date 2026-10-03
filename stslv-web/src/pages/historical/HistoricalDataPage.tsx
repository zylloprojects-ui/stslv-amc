import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useId, useState } from 'react'
import { FILTER_INPUT, FILTER_LABEL, LoadError, Money, Pager } from '../../components/records'
import { TABLE } from '../../components/table'
import { Alert, Button, Card, EmptyState, PageHeader, Spinner, TableScroll } from '../../components/ui'
import { api } from '../../lib/api'
import { formatDate, formatDateTime } from '../../lib/format'
import type { Paged } from '../../lib/types'
import { HistoricalRowModal, RecordLink, ReviewStatusBadge } from './HistoricalRowModal'
import {
  AMOUNT_LABELS,
  invoiceLabel,
  KIND_LABELS,
  KIND_PLURALS,
  reasonLabel,
  RECORD_KINDS,
  sourceAmount,
  sourceReference,
  type RecordKind,
  type ReviewRow,
  type ReviewSummary,
} from './types'

type KindFilter = 'all' | RecordKind
type StatusFilter = 'all' | 'imported' | 'provisional'
type InvoiceFilter = 'all' | 'with' | 'shared' | 'marker'

const PAGE_SIZE = 25

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

function SummaryPanel({ summary, onReason }: { summary: ReviewSummary; onReason: (kind: RecordKind, code: string) => void }) {
  const batch = summary.batches[summary.batches.length - 1]
  const invoiceCounts = new Map<string, number>()

  // By what the reader sees: a job and a visit period with one invoice are both "One invoice".
  for (const item of summary.invoiceReferences.byClassification) {
    const label = invoiceLabel(item.classification)

    invoiceCounts.set(label, (invoiceCounts.get(label) ?? 0) + item.count)
  }

  return (
    <div className="mb-6 space-y-4">
      <Card>
        <div className="border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-900">Summary</h2>
          {batch && (
            <p className="mt-0.5 break-words text-sm text-slate-600">
              {batch.label}, loaded {formatDateTime(batch.createdAt)} from {batch.sourceFiles.map((file) => file.name).join(', ')}. Cutover date{' '}
              {formatDate(batch.cutoverDate)}.
            </p>
          )}
        </div>
        <TableScroll label="Summary of historical records">
          <table className={TABLE.table}>
            <caption className="sr-only">Summary of historical records by type</caption>
            <thead>
              <tr>
                <th scope="col" className={TABLE.th}>
                  Record type
                </th>
                <th scope="col" className={`${TABLE.th} text-right`}>
                  In the Excel files
                </th>
                <th scope="col" className={`${TABLE.th} text-right`}>
                  Imported
                </th>
                <th scope="col" className={`${TABLE.th} text-right`}>
                  Provisional
                </th>
                <th scope="col" className={`${TABLE.th} text-right`}>
                  Imported value
                </th>
                <th scope="col" className={`${TABLE.th} text-right`}>
                  Provisional value
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {summary.byKind.map((kind) => (
                <tr key={kind.kind}>
                  <th scope="row" className={`${TABLE.td} text-left font-medium text-slate-900`}>
                    {KIND_PLURALS[kind.kind]}
                    {kind.kind === 'CLIENT' && (
                      <span className="block text-xs font-normal text-slate-600">
                        {summary.clientNames.distinct} different names, leading to {summary.clientNames.clients} client records so far
                      </span>
                    )}
                    {kind.withoutAmount > 0 && (
                      <span className="block text-xs font-normal text-slate-600">
                        {kind.withoutAmount} with no {AMOUNT_LABELS[kind.kind]?.toLowerCase()} in the source (not counted as zero)
                      </span>
                    )}
                  </th>
                  <td className={`${TABLE.td} text-right tabular-nums`}>{kind.total}</td>
                  <td className={`${TABLE.td} text-right tabular-nums`}>{kind.imported}</td>
                  <td className={`${TABLE.td} text-right tabular-nums`}>{kind.provisional}</td>
                  <td className={`${TABLE.td} text-right`}>{kind.importedAmount === null ? <span className="text-slate-400">—</span> : <Money value={kind.importedAmount} />}</td>
                  <td className={`${TABLE.td} text-right`}>{kind.provisionalAmount === null ? <span className="text-slate-400">—</span> : <Money value={kind.provisionalAmount} />}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-200 bg-slate-50 font-semibold text-slate-900">
                <th scope="row" className={`${TABLE.td} text-left`}>
                  All records
                </th>
                <td className={`${TABLE.td} text-right tabular-nums`}>{summary.totals.records}</td>
                <td className={`${TABLE.td} text-right tabular-nums`}>{summary.totals.imported}</td>
                <td className={`${TABLE.td} text-right tabular-nums`}>{summary.totals.provisional}</td>
                <td className={TABLE.td} />
                <td className={TABLE.td} />
              </tr>
            </tfoot>
          </table>
        </TableScroll>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h2 className="text-sm font-semibold text-slate-900">Why records are provisional</h2>
          {summary.holdReasons.length === 0 ? (
            <p className="mt-2 text-sm text-slate-600">No record is provisional.</p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-100">
              {summary.holdReasons.map((reason) => (
                <li key={`${reason.kind}-${reason.code}`} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                  <span className="min-w-0 break-words text-slate-700">
                    <span className="text-slate-500">{KIND_PLURALS[reason.kind]}:</span> {reasonLabel(reason.code)}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Show ${reason.count} ${KIND_PLURALS[reason.kind].toLowerCase()}: ${reasonLabel(reason.code)}`}
                    onClick={() => onReason(reason.kind, reason.code)}
                  >
                    {reason.count} · Show
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="p-4">
          <h2 className="text-sm font-semibold text-slate-900">Invoice references in the Excel files</h2>
          <p className="mt-1 text-sm text-slate-600">
            {summary.invoiceReferences.numbersMentioned} invoice numbers mentioned, {summary.invoiceReferences.distinctNumbers} different. They are kept for
            reference only: no invoice record has been created from them.
          </p>
          <ul className="mt-2 divide-y divide-slate-100">
            {[...invoiceCounts.entries()].map(([label, count]) => (
              <li key={label} className="flex items-center justify-between gap-3 py-1.5 text-sm text-slate-700">
                <span className="min-w-0 break-words">{label}</span>
                <span className="tabular-nums">{count}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}

export function HistoricalDataPage() {
  const searchId = useId()
  const kindId = useId()
  const statusId = useId()
  const reasonId = useId()
  const invoiceId = useId()

  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState<KindFilter>('all')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [reason, setReason] = useState('')
  const [invoice, setInvoice] = useState<InvoiceFilter>('all')
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState<ReviewRow | null>(null)

  // Wait for a pause in typing before searching.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 300)

    return () => clearTimeout(timer)
  }, [searchInput])

  const summary = useQuery({ queryKey: ['historical-data', 'summary'], queryFn: () => api.get<ReviewSummary>('/historical-data/summary') })
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
  const filtered = search !== '' || kind !== 'all' || status !== 'all' || reason !== '' || invoice !== 'all'
  const nothingLoaded = summary.data?.totals.records === 0
  const reasonCodes = [...new Set((summary.data?.holdReasons ?? []).map((item) => item.code))]
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

  return (
    <>
      <PageHeader title="Historical Data Review" />

      <div className="mb-4">
        <Alert tone="info">
          Every record of the earlier Excel registers is listed here, exactly as it was written. <strong>Imported</strong> records are also in the
          normal pages, marked as historical. <strong>Provisional</strong> records have an open question and exist only on this page: they are in no
          dashboard figure, schedule or invoice list. This page is read-only.
        </Alert>
      </div>

      {summary.isPending && <Spinner label="Loading summary" />}
      {summary.isError && <LoadError error={summary.error} onRetry={() => void summary.refetch()} />}

      {nothingLoaded && (
        <Card>
          <EmptyState
            title="No historical data has been loaded yet"
            description="The Excel registers have not been imported into this database. Once they are, every source record appears here."
          />
        </Card>
      )}

      {summary.data && !nothingLoaded && (
        <>
          <SummaryPanel
            summary={summary.data}
            onReason={(reasonKind, code) => {
              setKind(reasonKind)
              setStatus('provisional')
              setReason(code)
              setInvoice('all')
              setPage(1)
            }}
          />

          <Card>
            <div className="border-b border-slate-200 p-4">
              <h2 className="mb-3 text-sm font-semibold text-slate-900">Source records</h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                <div className="sm:col-span-2 lg:col-span-1">
                  <label htmlFor={searchId} className={FILTER_LABEL}>
                    Search
                  </label>
                  <input
                    id={searchId}
                    type="search"
                    value={searchInput}
                    onChange={(event) => setSearchInput(event.target.value)}
                    placeholder="Job number, client, invoice number"
                    className={FILTER_INPUT}
                  />
                </div>
                <div>
                  <label htmlFor={kindId} className={FILTER_LABEL}>
                    Record type
                  </label>
                  <select id={kindId} value={kind} onChange={(event) => change(setKind)(event.target.value as KindFilter)} className={FILTER_INPUT}>
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
                    Review status
                  </label>
                  <select id={statusId} value={status} onChange={(event) => change(setStatus)(event.target.value as StatusFilter)} className={FILTER_INPUT}>
                    <option value="all">All</option>
                    <option value="imported">Imported</option>
                    <option value="provisional">Provisional</option>
                  </select>
                </div>
                <div>
                  <label htmlFor={reasonId} className={FILTER_LABEL}>
                    Open question
                  </label>
                  <select id={reasonId} value={reason} onChange={(event) => change(setReason)(event.target.value)} className={FILTER_INPUT}>
                    <option value="">Any</option>
                    {reasonCodes.map((code) => (
                      <option key={code} value={code}>
                        {reasonLabel(code)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor={invoiceId} className={FILTER_LABEL}>
                    Invoice reference
                  </label>
                  <select id={invoiceId} value={invoice} onChange={(event) => change(setInvoice)(event.target.value as InvoiceFilter)} className={FILTER_INPUT}>
                    <option value="all">Any</option>
                    <option value="with">Has an invoice cell</option>
                    <option value="shared">Shared or several invoices</option>
                    <option value="marker">A word, not a number</option>
                  </select>
                </div>
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
                <TableScroll label="Historical source records">
                  <table className={TABLE.table}>
                    <caption className="sr-only">Historical source records</caption>
                    <thead>
                      <tr>
                        <th scope="col" className={TABLE.th}>
                          Type
                        </th>
                        <th scope="col" className={TABLE.th}>
                          In the Excel file
                        </th>
                        <th scope="col" className={TABLE.th}>
                          In the application
                        </th>
                        <th scope="col" className={`${TABLE.th} text-right`}>
                          Value
                        </th>
                        <th scope="col" className={TABLE.th}>
                          Invoice cell
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
                            <td className={`${TABLE.td} whitespace-nowrap`}>{KIND_LABELS[row.kind]}</td>
                            <td className={`${TABLE.td} ${TABLE.text}`}>
                              <span className="font-medium text-slate-900">{row.identifier}</span>
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
                              {row.kind === 'CLIENT' ? <span className="text-slate-400">—</span> : amount === null ? <span className="text-slate-600">Not given</span> : <Money value={amount} />}
                            </td>
                            <td className={`${TABLE.td} ${TABLE.unbroken}`}>
                              {row.invoiceReference?.rawCell ?? <span className="text-slate-400">—</span>}
                              {row.invoiceReference && !['NO_INVOICE_REFERENCE', 'ONE_JOB_ONE_INVOICE', 'AMC_PERIOD_ONE_INVOICE'].includes(row.invoiceReference.classification) && (
                                <span className="block break-normal text-xs text-slate-600">{invoiceLabel(row.invoiceReference.classification)}</span>
                              )}
                            </td>
                            <td className={TABLE.td}>
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
          </Card>
        </>
      )}

      {open && <HistoricalRowModal row={open} onClose={() => setOpen(null)} />}
    </>
  )
}

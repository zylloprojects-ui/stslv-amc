import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { FILTER_INPUT, FILTER_LABEL, LoadError, Money, Pager } from '../../components/records'
import { TABLE } from '../../components/table'
import { Button, EmptyState, PageHeader, Spinner, TableScroll } from '../../components/ui'
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

// Colours for the four kinds of record, from the logo palette.
const KIND_COLORS: Record<RecordKind, string> = {
  CLIENT: '#1B8AD3',
  AMC_CONTRACT: '#00A6C8',
  AMC_VISIT: '#5BAF48',
  PROJECT: '#FF8212',
}
const IMPORTED_COLOR = '#5BAF48'
const PROVISIONAL_COLOR = '#F5C622'

const PANEL = 'overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm'

// Colours for the lines of the invoice chart.
const DONUT_COLORS = ['#1B8AD3', '#00A6C8', '#5BAF48', '#F5C622', '#FF8212', '#D1428C', '#7E6FAC', '#94A3B8']
const FOCUS_RING = 'focus:border-[#1479BD] focus:outline-none focus:ring-4 focus:ring-sky-200/60'

const ICONS = {
  stack: (
    <>
      <path d="m12 3.5 8.5 4.2L12 12 3.5 7.7 12 3.5Z" strokeLinejoin="round" />
      <path d="m3.5 12 8.5 4.2 8.5-4.2M3.5 16.3 12 20.5l8.5-4.2" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  check: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.3 12.3 2.6 2.6 4.9-5.3" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  question: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.6 9.6a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.2 1-1.2 1.8M12 16.6v.1" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  file: (
    <>
      <path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20V3.5Z" strokeLinejoin="round" />
      <path d="M14 3.5v4h4" strokeLinecap="round" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" strokeLinecap="round" />
    </>
  ),
  invoice: (
    <>
      <path d="M6 3.5h12v17l-3-2-3 2-3-2-3 2v-17Z" strokeLinejoin="round" />
      <path d="M9.5 8.5h5M9.5 12h5" strokeLinecap="round" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 7.9v.1" strokeLinecap="round" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" strokeLinecap="round" />
    </>
  ),
  filter: <path d="M4 6h16M7 12h10M10 18h4" strokeLinecap="round" />,
}

function Icon({ name, className = 'h-5 w-5' }: { name: keyof typeof ICONS; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      {ICONS[name]}
    </svg>
  )
}

/** A section heading with a coloured marker. The marker is decorative, so the heading's name is just its text. */
function SectionTitle({ color, children }: { color: string; children: ReactNode }) {
  return (
    <h2 className="flex items-center gap-2.5 text-sm font-bold uppercase tracking-wider text-[#0b3b66]">
      <span className="h-4 w-1 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
      {children}
    </h2>
  )
}

function Chip({ icon, children }: { icon: keyof typeof ICONS; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 shadow-sm">
      <Icon name={icon} className="h-3.5 w-3.5 text-[#1479BD]" />
      {children}
    </span>
  )
}

/** One headline figure. */
function Stat({ label, color, icon, delay, children, hint }: { label: string; color: string; icon: keyof typeof ICONS; delay: number; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="login-rise relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-4 pl-5 shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md" style={{ animationDelay: `${delay}s` }}>
      <span className="absolute inset-y-0 left-0 w-1.5" style={{ backgroundColor: color }} aria-hidden="true" />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</p>
          <div className="mt-1 text-3xl font-bold tabular-nums text-[#0b3b66]">{children}</div>
        </div>
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" style={{ backgroundColor: `${color}1f`, color }} aria-hidden="true">
          <Icon name={icon} className="h-5 w-5" />
        </span>
      </div>
      {hint && <div className="mt-2 text-xs text-slate-600">{hint}</div>}
    </div>
  )
}

/** Two-part bar: how much of a total is imported and how much is provisional. Decorative; the numbers are in the text. */
function ShareBar({ imported, total, className = '' }: { imported: number; total: number; className?: string }) {
  const share = total > 0 ? (imported / total) * 100 : 0

  return (
    <span className={`flex h-1.5 overflow-hidden rounded-full bg-slate-200 ${className}`} aria-hidden="true">
      <span className="h-full" style={{ width: `${share}%`, backgroundColor: IMPORTED_COLOR }} />
      <span className="h-full" style={{ width: `${total > 0 ? 100 - share : 0}%`, backgroundColor: PROVISIONAL_COLOR }} />
    </span>
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

/** Ring chart. Decorative: the same numbers are in the list beside it. */
function Donut({ parts, total, caption }: { parts: { value: number; color: string }[]; total: number; caption: string }) {
  const radius = 44
  const circumference = 2 * Math.PI * radius
  let offset = 0

  return (
    <div className="relative h-36 w-36 shrink-0" aria-hidden="true">
      <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
        <circle cx="60" cy="60" r={radius} fill="none" stroke="#E2E8F0" strokeWidth="14" />
        {total > 0 &&
          parts.map((part) => {
            const length = (part.value / total) * circumference
            const segment = (
              <circle
                key={part.color + offset}
                cx="60"
                cy="60"
                r={radius}
                fill="none"
                stroke={part.color}
                strokeWidth="14"
                strokeDasharray={`${Math.max(length - 1.5, 0)} ${circumference}`}
                strokeDashoffset={-offset}
              />
            )

            offset += length

            return segment
          })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="text-2xl font-bold tabular-nums leading-none text-[#0b3b66]">{total}</span>
        <span className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{caption}</span>
      </div>
    </div>
  )
}

function SummaryPanel({ summary, onReason }: { summary: ReviewSummary; onReason: (kind: RecordKind, code: string) => void }) {
  const batch = summary.batches[summary.batches.length - 1]
  const importedShare = summary.totals.records > 0 ? Math.round((summary.totals.imported / summary.totals.records) * 100) : 0

  // By what the reader sees: a job and a visit period with one invoice are both "One invoice".
  const invoiceRows = new Map<string, number>()

  for (const item of summary.invoiceReferences.byClassification) {
    const label = invoiceLabel(item.classification)

    invoiceRows.set(label, (invoiceRows.get(label) ?? 0) + item.count)
  }

  const invoiceList = [...invoiceRows.entries()].sort((a, b) => b[1] - a[1])
  const invoiceTotal = invoiceList.reduce((sum, [, count]) => sum + count, 0)

  // Provisional records by type, and the open questions grouped under each type.
  const provisionalKinds = summary.byKind.filter((item) => item.provisional > 0)
  const reasonGroups = RECORD_KINDS.map((kind) => ({ kind, reasons: summary.holdReasons.filter((reason) => reason.kind === kind) })).filter((group) => group.reasons.length > 0)

  return (
    <div className="mb-6 space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Records in the Excel files" color="#1B8AD3" icon="stack" delay={0} hint={`${summary.byKind.length} record types`}>
          {summary.totals.records}
        </Stat>
        <Stat
          label="Imported records"
          color={IMPORTED_COLOR}
          icon="check"
          delay={0.07}
          hint={
            <>
              <ShareBar imported={summary.totals.imported} total={summary.totals.records} className="mb-1.5" />
              {importedShare}% of all records
            </>
          }
        >
          {summary.totals.imported}
        </Stat>
        <Stat label="Provisional records" color={PROVISIONAL_COLOR} icon="question" delay={0.14} hint="Open questions; kept on this page only">
          {summary.totals.provisional}
        </Stat>
        {batch && (
          <Stat label="Source batch" color="#7E6FAC" icon="calendar" delay={0.21} hint={`Loaded ${formatDateTime(batch.createdAt)}`}>
            <span className="block truncate text-lg leading-9">{batch.label}</span>
          </Stat>
        )}
      </div>

      <div className={PANEL}>
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 bg-gradient-to-r from-sky-50 via-white to-emerald-50 px-5 py-4">
          <div className="min-w-0">
            <SectionTitle color="#1B8AD3">Summary</SectionTitle>
            <p className="mt-1 text-sm text-slate-600">What the Excel registers hold, by type, and how much of it is in the application.</p>
          </div>
          {batch && (
            <div className="flex flex-wrap gap-2">
              <Chip icon="calendar">Cutover date {formatDate(batch.cutoverDate)}</Chip>
              {batch.sourceFiles.map((file) => (
                <Chip key={file.name} icon="file">
                  {file.name}
                </Chip>
              ))}
            </div>
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
                <tr key={kind.kind} className={`${TABLE.row} transition-colors`}>
                  <th scope="row" className={`${TABLE.td} min-w-56 text-left font-medium text-slate-900`}>
                    <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full align-middle" style={{ backgroundColor: KIND_COLORS[kind.kind] }} aria-hidden="true" />
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
                    <ShareBar imported={kind.imported} total={kind.total} className="mt-2 max-w-44" />
                  </th>
                  <td className={`${TABLE.td} text-right text-base font-semibold tabular-nums text-slate-900`}>{kind.total}</td>
                  <td className={`${TABLE.td} text-right tabular-nums`}>{kind.imported}</td>
                  <td className={`${TABLE.td} text-right tabular-nums`}>{kind.provisional}</td>
                  <td className={`${TABLE.td} text-right`}>{kind.importedAmount === null ? <span className="text-slate-400">—</span> : <Money value={kind.importedAmount} />}</td>
                  <td className={`${TABLE.td} text-right`}>{kind.provisionalAmount === null ? <span className="text-slate-400">—</span> : <Money value={kind.provisionalAmount} />}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold text-slate-900">
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
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-slate-100 bg-slate-50 px-5 py-2.5 text-xs text-slate-600" aria-hidden="true">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-6 rounded-full" style={{ backgroundColor: IMPORTED_COLOR }} /> Imported share
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-6 rounded-full" style={{ backgroundColor: PROVISIONAL_COLOR }} /> Provisional share
          </span>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div className={`${PANEL} relative p-5 pt-6`}>
          <span className="absolute inset-x-0 top-0 h-1.5" style={{ backgroundImage: 'linear-gradient(90deg, #F5C622, #FF8212)' }} aria-hidden="true" />
          <h2 className="flex items-center gap-2.5 text-sm font-bold uppercase tracking-wider text-[#0b3b66]">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl text-[#c98a00]" style={{ backgroundColor: `${PROVISIONAL_COLOR}33` }} aria-hidden="true">
              <Icon name="question" className="h-5 w-5" />
            </span>
            Why records are provisional
          </h2>
          {summary.holdReasons.length === 0 ? (
            <p className="mt-3 text-sm text-slate-600">No record is provisional.</p>
          ) : (
            <>
              <p className="mt-2 text-sm text-slate-600">
                {summary.totals.provisional} provisional records, grouped by the open question. Choose Show to list the records behind a line.
              </p>

              <div className="mt-4 rounded-xl border border-slate-100 bg-slate-50/70 p-3.5">
                <span className="flex h-3 overflow-hidden rounded-full bg-slate-200" aria-hidden="true">
                  {provisionalKinds.map((item) => (
                    <span key={item.kind} className="h-full" style={{ width: `${(item.provisional / summary.totals.provisional) * 100}%`, backgroundColor: KIND_COLORS[item.kind] }} />
                  ))}
                </span>
                <p className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
                  {provisionalKinds.map((item) => (
                    <span key={item.kind} className="flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: KIND_COLORS[item.kind] }} aria-hidden="true" />
                      {KIND_PLURALS[item.kind]}
                      <strong className="tabular-nums text-slate-900">{item.provisional}</strong>
                    </span>
                  ))}
                </p>
              </div>

              <div className="mt-4 space-y-4">
                {reasonGroups.map((group) => (
                  <section key={group.kind}>
                    <p className="mb-1.5 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider" style={{ color: KIND_COLORS[group.kind] }}>
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: KIND_COLORS[group.kind] }} aria-hidden="true" />
                      {KIND_PLURALS[group.kind]}
                    </p>
                    <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
                      {group.reasons.map((reason) => (
                        <li key={reason.code} className="flex items-center justify-between gap-3 px-3.5 py-2.5 transition-colors hover:bg-slate-50">
                          <span className="min-w-0 break-words text-sm font-medium text-slate-900">{reasonLabel(reason.code)}</span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="shrink-0"
                            aria-label={`Show ${reason.count} ${KIND_PLURALS[reason.kind].toLowerCase()}: ${reasonLabel(reason.code)}`}
                            onClick={() => onReason(reason.kind, reason.code)}
                          >
                            <span className="rounded-full px-2 py-0.5 text-xs font-bold tabular-nums" style={{ backgroundColor: `${PROVISIONAL_COLOR}40`, color: '#8a6100' }}>
                              {reason.count}
                            </span>
                            Show
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            </>
          )}
        </div>

        <div className={`${PANEL} relative p-5 pt-6`}>
          <span className="absolute inset-x-0 top-0 h-1.5" style={{ backgroundImage: 'linear-gradient(90deg, #1B8AD3, #00A6C8)' }} aria-hidden="true" />
          <h2 className="flex items-center gap-2.5 text-sm font-bold uppercase tracking-wider text-[#0b3b66]">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-50 text-[#1479BD]" aria-hidden="true">
              <Icon name="invoice" className="h-5 w-5" />
            </span>
            Invoice references in the Excel files
          </h2>
          <p className="mt-2 text-sm text-slate-600">
            {summary.invoiceReferences.numbersMentioned} invoice numbers mentioned, {summary.invoiceReferences.distinctNumbers} different. They are kept for
            reference only: no invoice record has been created from them.
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-6 sm:flex-nowrap sm:justify-start">
            <Donut parts={invoiceList.map(([, count], index) => ({ value: count, color: DONUT_COLORS[index % DONUT_COLORS.length] as string }))} total={invoiceTotal} caption="records" />
            <ul className="min-w-0 flex-1 space-y-0.5 self-stretch">
              {invoiceList.map(([label, count], index) => (
                <li key={label} className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-sm text-slate-800 transition-colors hover:bg-slate-50">
                  <span className="min-w-0 flex-1 break-words">
                    <span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ backgroundColor: DONUT_COLORS[index % DONUT_COLORS.length] }} aria-hidden="true" />
                    {label}
                  </span>
                  <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-bold tabular-nums text-slate-800">{count}</span>
                  <span className="w-9 text-right text-xs tabular-nums text-slate-500" aria-hidden="true">
                    {invoiceTotal > 0 ? `${Math.round((count / invoiceTotal) * 100)}%` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
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

      <div className="login-rise mb-6 flex items-start gap-3.5 rounded-2xl border border-sky-200 bg-gradient-to-r from-sky-50 via-white to-emerald-50 p-4 shadow-sm">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white text-[#1479BD] shadow-sm ring-1 ring-sky-100" aria-hidden="true">
          <Icon name="info" className="h-5 w-5" />
        </span>
        <p className="text-sm leading-relaxed text-slate-700">
          Every record of the earlier Excel registers is listed here, exactly as it was written. <strong>Imported</strong> records are also in the
          normal pages, marked as historical. <strong>Provisional</strong> records have an open question and exist only on this page: they are in no
          dashboard figure, schedule or invoice list. This page is read-only.
        </p>
      </div>

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

          <div className={PANEL}>
            <div className="border-b border-slate-200 bg-gradient-to-r from-sky-50 via-white to-emerald-50 p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <SectionTitle color={IMPORTED_COLOR}>Source records</SectionTitle>
                {data && (
                  <span className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 shadow-sm">
                    <Icon name="filter" className="h-3.5 w-3.5 text-[#1479BD]" />
                    {filtered ? `${data.total} matching` : `${data.total} in total`}
                  </span>
                )}
              </div>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                <div className="sm:col-span-2 lg:col-span-1">
                  <label htmlFor={searchId} className={FILTER_LABEL}>
                    Search
                  </label>
                  <div className="relative">
                    <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-slate-400" />
                    <input
                      id={searchId}
                      type="search"
                      value={searchInput}
                      onChange={(event) => setSearchInput(event.target.value)}
                      placeholder="Job number, client, invoice number"
                      className={`${FILTER_INPUT} pl-10 ${FOCUS_RING}`}
                    />
                  </div>
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
                    Review status
                  </label>
                  <select id={statusId} value={status} onChange={(event) => change(setStatus)(event.target.value as StatusFilter)} className={`${FILTER_INPUT} ${FOCUS_RING}`}>
                    <option value="all">All</option>
                    <option value="imported">Imported</option>
                    <option value="provisional">Provisional</option>
                  </select>
                </div>
                <div>
                  <label htmlFor={reasonId} className={FILTER_LABEL}>
                    Open question
                  </label>
                  <select id={reasonId} value={reason} onChange={(event) => change(setReason)(event.target.value)} className={`${FILTER_INPUT} ${FOCUS_RING}`}>
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
                  <select id={invoiceId} value={invoice} onChange={(event) => change(setInvoice)(event.target.value as InvoiceFilter)} className={`${FILTER_INPUT} ${FOCUS_RING}`}>
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
                        const color = KIND_COLORS[row.kind]

                        return (
                          <tr key={row.id} className={`${TABLE.row} transition-colors`}>
                            <td className={`${TABLE.td} whitespace-nowrap ${row.status === 'IMPORTED' ? 'shadow-[inset_4px_0_0_#5BAF48]' : 'shadow-[inset_4px_0_0_#F5C622]'}`}>
                              <span className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-semibold" style={{ backgroundColor: `${color}1f`, color }}>
                                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
                                {KIND_LABELS[row.kind]}
                              </span>
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
          </div>
        </>
      )}

      {open && <HistoricalRowModal row={open} onClose={() => setOpen(null)} />}
    </>
  )
}

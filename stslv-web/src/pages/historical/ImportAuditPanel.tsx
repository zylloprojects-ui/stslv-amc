import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { LoadError, Money } from '../../components/records'
import { TABLE } from '../../components/table'
import { Button, Spinner, TableScroll } from '../../components/ui'
import { api } from '../../lib/api'
import { formatDate, formatDateTime } from '../../lib/format'
import { AMOUNT_LABELS, invoiceLabel, KIND_PLURALS, reasonLabel, RECORD_KINDS, type RecordKind, type ReviewSummary } from './types'

export type InvoiceFilter = 'all' | 'with' | 'shared' | 'marker'

const PANEL = 'overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm'

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className={PANEL}>
      <div className="border-b border-slate-200 bg-slate-50/70 px-5 py-3.5">
        <h2 className="text-sm font-bold uppercase tracking-wider text-[#0b3b66]">{title}</h2>
        {description && <p className="mt-1 text-sm text-slate-600">{description}</p>}
      </div>
      {children}
    </section>
  )
}

const NO_AMOUNT = <span className="text-slate-400">—</span>

interface ImportAuditPanelProps {
  /** Opens the records behind a reason in the Records tab. */
  onReason: (kind: RecordKind, code: string) => void
  /** Opens the records with a kind of invoice reference in the Records tab. */
  onInvoice: (filter: InvoiceFilter) => void
}

/** The detail of the import itself: batches, counts and amounts by type, the reasons records need review, and the invoice references. Admin only. */
export function ImportAuditPanel({ onReason, onInvoice }: ImportAuditPanelProps) {
  const audit = useQuery({ queryKey: ['historical-data', 'audit'], queryFn: () => api.get<ReviewSummary>('/historical-data/audit') })

  if (audit.isPending) return <Spinner label="Loading import audit" />
  if (audit.isError) return <LoadError error={audit.error} onRetry={() => void audit.refetch()} />

  const summary = audit.data

  // By what the reader sees: a job and a visit period with one invoice are both "One invoice".
  const invoiceRows = new Map<string, number>()

  for (const item of summary.invoiceReferences.byClassification) {
    const label = invoiceLabel(item.classification)

    invoiceRows.set(label, (invoiceRows.get(label) ?? 0) + item.count)
  }

  const invoiceList = [...invoiceRows.entries()].sort((a, b) => b[1] - a[1])
  const reasonGroups = RECORD_KINDS.map((kind) => ({ kind, reasons: summary.holdReasons.filter((reason) => reason.kind === kind) })).filter((group) => group.reasons.length > 0)

  return (
    <div className="space-y-5">
      <Section title="Import batches" description="Each run of the controlled import, with the Excel files it read.">
        <TableScroll label="Import batches">
          <table className={TABLE.table}>
            <caption className="sr-only">Import batches</caption>
            <thead>
              <tr>
                <th scope="col" className={TABLE.th}>
                  Batch
                </th>
                <th scope="col" className={TABLE.th}>
                  Loaded
                </th>
                <th scope="col" className={TABLE.th}>
                  Cutover date
                </th>
                <th scope="col" className={TABLE.th}>
                  Source files
                </th>
                <th scope="col" className={`${TABLE.th} text-right`}>
                  Records
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {summary.batches.map((batch) => (
                <tr key={batch.id} className={TABLE.row}>
                  <th scope="row" className={`${TABLE.td} ${TABLE.text} text-left font-medium text-slate-900`}>
                    {batch.label}
                  </th>
                  <td className={`${TABLE.td} whitespace-nowrap`}>{formatDateTime(batch.createdAt)}</td>
                  <td className={`${TABLE.td} whitespace-nowrap`}>{formatDate(batch.cutoverDate)}</td>
                  <td className={`${TABLE.td} ${TABLE.text}`}>{batch.sourceFiles.map((file) => file.name).join(', ')}</td>
                  <td className={`${TABLE.td} text-right tabular-nums`}>{batch.rows}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </Section>

      <Section title="Records by type" description="What the Excel registers hold, by type, and how much of it is in the application.">
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
                  Needs review
                </th>
                <th scope="col" className={`${TABLE.th} text-right`}>
                  Imported value
                </th>
                <th scope="col" className={`${TABLE.th} text-right`}>
                  Needs review value
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {summary.byKind.map((kind) => (
                <tr key={kind.kind} className={TABLE.row}>
                  <th scope="row" className={`${TABLE.td} min-w-56 text-left font-medium text-slate-900`}>
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
                  <td className={`${TABLE.td} text-right font-semibold tabular-nums text-slate-900`}>{kind.total}</td>
                  <td className={`${TABLE.td} text-right tabular-nums`}>{kind.imported}</td>
                  <td className={`${TABLE.td} text-right tabular-nums`}>{kind.provisional}</td>
                  <td className={`${TABLE.td} text-right`}>{kind.importedAmount === null ? NO_AMOUNT : <Money value={kind.importedAmount} />}</td>
                  <td className={`${TABLE.td} text-right`}>{kind.provisionalAmount === null ? NO_AMOUNT : <Money value={kind.provisionalAmount} />}</td>
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
      </Section>

      <div className="grid gap-5 lg:grid-cols-2">
        <Section
          title="Why records need review"
          description={
            summary.holdReasons.length === 0
              ? 'No record needs review.'
              : `${summary.totals.provisional} records need review, grouped by the open question. Choose Show to list the records behind a line.`
          }
        >
          {reasonGroups.length > 0 && (
            <div className="space-y-4 p-5">
              {reasonGroups.map((group) => (
                <div key={group.kind}>
                  <h3 className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-600">{KIND_PLURALS[group.kind]}</h3>
                  <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200">
                    {group.reasons.map((reason) => (
                      <li key={reason.code} className="flex items-center justify-between gap-3 px-3.5 py-2">
                        <span className="min-w-0 break-words text-sm text-slate-900">{reasonLabel(reason.code)}</span>
                        <span className="flex shrink-0 items-center gap-2">
                          <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-bold tabular-nums text-amber-900">{reason.count}</span>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Show ${reason.count} ${KIND_PLURALS[reason.kind].toLowerCase()}: ${reasonLabel(reason.code)}`}
                            onClick={() => onReason(reason.kind, reason.code)}
                          >
                            Show
                          </Button>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section
          title="Invoice references in the Excel files"
          description={`${summary.invoiceReferences.numbersMentioned} invoice numbers mentioned, ${summary.invoiceReferences.distinctNumbers} different. They are kept for reference only: no invoice record has been created from them.`}
        >
          <div className="p-5">
            <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200">
              {invoiceList.map(([label, count]) => (
                <li key={label} className="flex items-center justify-between gap-3 px-3.5 py-2 text-sm text-slate-900">
                  <span className="min-w-0 break-words">{label}</span>
                  <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-bold tabular-nums text-slate-800">{count}</span>
                </li>
              ))}
            </ul>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => onInvoice('with')}>
                Show records with an invoice cell
              </Button>
              <Button variant="secondary" size="sm" onClick={() => onInvoice('shared')}>
                Show shared or several invoices
              </Button>
              <Button variant="secondary" size="sm" onClick={() => onInvoice('marker')}>
                Show words, not numbers
              </Button>
            </div>
          </div>
        </Section>
      </div>
    </div>
  )
}

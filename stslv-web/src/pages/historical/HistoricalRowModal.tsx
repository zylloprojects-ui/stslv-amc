import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/context'
import { Alert, Badge, Button, Modal } from '../../components/ui'
import { formatDate } from '../../lib/format'
import { formatMoney, formatRate } from '../../lib/money'
import type { Module } from '../../lib/types'
import {
  invoiceLabel,
  KIND_LABELS,
  PROPOSED_FIELDS,
  reasonLabel,
  sourceReference,
  STATUS_LABELS,
  valueLabel,
  type ReviewLink,
  type ReviewRow,
  type ReviewStatus,
} from './types'

export function ReviewStatusBadge({ status }: { status: ReviewStatus }) {
  return <Badge tone={status === 'IMPORTED' ? 'green' : 'amber'}>{STATUS_LABELS[status]}</Badge>
}

// Where each kind of imported record is found in the normal application, and the permission that page needs.
const DESTINATIONS: Record<ReviewLink['type'], { module: Module; path: (id: string) => string; text: (label: string) => string }> = {
  project: { module: 'PROJECTS', path: (id) => `/projects/${id}`, text: (label) => `Open project ${label}` },
  client: { module: 'CLIENTS', path: () => '/clients', text: (label) => `Open Clients (${label})` },
  contract: { module: 'AMC_CONTRACTS', path: () => '/amc/contracts', text: (label) => `Open AMC Contracts (${label})` },
  visit: { module: 'AMC_SCHEDULE', path: () => '/amc/schedule', text: (label) => `Open AMC Schedule (${label})` },
}

/** A link to the record an imported row produced, for a user who may open that module. Otherwise its name only. */
export function RecordLink({ link }: { link: ReviewLink }) {
  const auth = useAuth()
  const destination = DESTINATIONS[link.type]

  if (!auth.can(destination.module, 'VIEW')) {
    return <span>{link.label}</span>
  }

  return (
    <Link to={destination.path(link.id)} className="font-medium text-sky-700 underline hover:text-sky-900">
      {destination.text(link.label)}
    </Link>
  )
}

const NOT_GIVEN = <span className="text-slate-500">Not given in the source</span>
const EMPTY_CELL = <span className="text-slate-500">(empty)</span>
const NO_NUMBERS = <span className="text-slate-500">None</span>

function proposedValue(value: unknown, format: (typeof PROPOSED_FIELDS)['PROJECT'][number]['format']): ReactNode {
  if (value === null || value === undefined || value === '') {
    return NOT_GIVEN
  }
  if (format === 'occurrences' && typeof value === 'object') {
    const uses = value as { contracts?: number; schedule?: number; jobs?: number }

    return `Contract register ${uses.contracts ?? 0} · AMC schedule ${uses.schedule ?? 0} · Job register ${uses.jobs ?? 0}`
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    return NOT_GIVEN
  }

  const text = String(value)

  if (format === 'money') return <span className="tabular-nums">{formatMoney(text)}</span>
  if (format === 'rate') return formatRate(text)
  if (format === 'date') return formatDate(text)
  if (format === 'lookup') return valueLabel(text)

  return text
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200">
      <h3 className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600">{title}</h3>
      <div className="px-4 py-2">{children}</div>
    </section>
  )
}

function Values({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="divide-y divide-slate-100">
      {rows.map(([label, value]) => (
        <div key={label} className="gap-4 py-2 sm:grid sm:grid-cols-5">
          <dt className="break-words text-sm font-medium text-slate-600 sm:col-span-2">{label}</dt>
          <dd className="mt-0.5 whitespace-pre-wrap break-words text-sm text-slate-900 sm:col-span-3 sm:mt-0">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** One source record: what the Excel register says, beside what the application holds or proposes. Read-only. */
export function HistoricalRowModal({ row, onClose }: { row: ReviewRow; onClose: () => void }) {
  const provisional = row.status === 'PROVISIONAL'
  const invoice = row.invoiceReference

  return (
    <Modal title={`${KIND_LABELS[row.kind]}: ${row.identifier}`} onClose={onClose} size="xl" footer={<Button onClick={onClose}>Close</Button>}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-700">
          <ReviewStatusBadge status={row.status} />
          <span>
            <span className="font-medium">Source:</span> {sourceReference(row.source)}
          </span>
        </div>

        {provisional ? (
          <Alert tone="info">
            This record is provisional. It is shown here exactly as it is in the Excel file and has not been added to the application: it is in no
            dashboard figure, schedule or invoice list. Nothing can be changed on this page.
          </Alert>
        ) : (
          row.link && (
            <p className="text-sm text-slate-700">
              Imported as a historical record. <RecordLink link={row.link} />
            </p>
          )
        )}

        {row.holdReasons.length > 0 && (
          <Section title="Why it is provisional">
            <ul className="space-y-3 py-1">
              {row.holdReasons.map((reason) => (
                <li key={reason.code} className="text-sm">
                  <p className="font-medium text-amber-900">{reasonLabel(reason.code)}</p>
                  <p className="mt-0.5 break-words text-slate-700">{reason.message}</p>
                </li>
              ))}
            </ul>
          </Section>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          <Section title="Original Excel values">
            {/* In the order of the sheet's columns. */}
            <Values rows={(row.sourceColumns.length > 0 ? row.sourceColumns : Object.keys(row.rawValues)).map((heading) => [heading, row.rawValues[heading] ?? EMPTY_CELL])} />
          </Section>
          <Section title={provisional ? 'Proposed mapping (not applied)' : 'As imported'}>
            <Values rows={PROPOSED_FIELDS[row.kind].map((field) => [field.label, proposedValue(row.proposedValues[field.key], field.format)])} />
          </Section>
        </div>

        {invoice && (
          <Section title="Invoice reference in the source">
            <Values
              rows={[
                ['Invoice cell', invoice.rawCell ?? EMPTY_CELL],
                ['Reading', invoiceLabel(invoice.classification)],
                ['Invoice numbers', invoice.numbers.length > 0 ? invoice.numbers.join(', ') : NO_NUMBERS],
                ...invoice.notes.map((note, index): [string, ReactNode] => [`Note ${index + 1}`, note]),
              ]}
            />
            <p className="border-t border-slate-100 py-2 text-xs text-slate-600">
              Kept for reference only. No invoice record has been created from it.
            </p>
          </Section>
        )}

        {row.warnings.length > 0 && (
          <Section title="Notes">
            <ul className="list-disc space-y-1.5 py-1 pl-5 text-sm text-slate-700">
              {row.warnings.map((warning) => (
                <li key={warning} className="break-words">
                  {warning}
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </Modal>
  )
}

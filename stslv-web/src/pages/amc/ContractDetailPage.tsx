import { useQuery } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../../auth/context'
import { AttachmentsPanel } from '../../components/AttachmentsPanel'
import { LoadError } from '../../components/records'
import { TABLE } from '../../components/table'
import { Alert, Button, Card, EmptyState, PageHeader, Spinner } from '../../components/ui'
import { api, ApiError } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import type { PagedInvoices } from '../../lib/invoiceTypes'
import { InvoiceDialogs, type InvoiceDialog } from '../invoices/InvoiceDialogs'
import { InvoicesTable } from '../invoices/InvoicesTable'
import { formatDate, formatMoney, isZeroMoney, todayIso } from './amcFormat'
import { ContractStatusPill, DetailRow, EligibilityPill, OrDash, Pager, Pill, PlannedDate, VisitStatusPill } from './components'
import { ContractFormModal } from './ContractFormModal'
import { ContractMastersPanel } from './ContractMastersPanel'
import { ContractRenewalsPanel } from './ContractRenewalsPanel'
import { ContractStatusDialog } from './ContractStatusDialog'
import { validityState } from './contractValidity'
import {
  CONTRACT_STATUS_LABELS,
  FREQUENCY_LABELS,
  type Contract,
  type ContractHistory,
  type ContractHistoryEntry,
  type ContractStatus,
  type MaintenanceFrequency,
  type SavedContract,
  type VisitList,
} from './types'

// The page shows up to this many visits and invoices; the full lists are on their own pages.
const VISIT_LIMIT = 200
const INVOICE_LIMIT = 50
const HISTORY_PAGE_SIZE = 20

const ACTION_LABELS: Record<string, string> = {
  'amc_contract.created': 'Contract created',
  'amc_contract.updated': 'Contract updated',
  'amc_contract.status_changed': 'Status changed',
  'amc_contract.schedule_generated': 'Schedule updated',
  'amc_contract.masters_linked': 'Master records linked',
  'attachment.uploaded': 'Document attached',
  'attachment.version_uploaded': 'Document replaced',
  'amc_contract.renewal_created': 'Renewal created',
  'amc_contract.renewal_of': 'Created as a renewal',
}

const FIELD_LABELS: Record<string, string> = {
  clientId: 'Client',
  responsibleEngineer: 'Responsible engineer',
  validFrom: 'Valid from',
  validTo: 'Valid to',
  systemDescription: 'System',
  description: 'Description',
  contractValue: 'Contract value',
  finalCredit: 'Final credit',
  maintenanceFrequency: 'Frequency',
  defaultVisitAmount: 'Default visit amount',
  notes: 'Notes',
  status: 'Status',
  salesEngineer: 'Sales engineer',
  systemType: 'System type',
}

const MONEY_FIELDS = new Set(['contractValue', 'finalCredit', 'defaultVisitAmount'])
const DATE_FIELDS = new Set(['validFrom', 'validTo'])

/** "amc_contract.some_action" -> "Some action", for an action without its own label. */
function actionLabel(action: string): string {
  if (ACTION_LABELS[action]) {
    return ACTION_LABELS[action]
  }

  const verb = action.split('.').pop() ?? action
  const words = verb.replace(/_/g, ' ').trim()

  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Change recorded'
}

/** A recorded value in the words the rest of the page uses. */
function changeValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '—'
  }
  if (typeof value !== 'string') {
    return String(value)
  }
  if (field === 'status' && value in CONTRACT_STATUS_LABELS) {
    return CONTRACT_STATUS_LABELS[value as ContractStatus]
  }
  if (field === 'maintenanceFrequency' && value in FREQUENCY_LABELS) {
    return FREQUENCY_LABELS[value as MaintenanceFrequency]
  }
  if (MONEY_FIELDS.has(field)) {
    return formatMoney(value)
  }
  if (DATE_FIELDS.has(field)) {
    return formatDate(value)
  }

  return value
}

function Section({ id, title, actions, children }: { id: string; title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <section aria-labelledby={id}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-6 py-4">
          <h2 id={id} className="text-base font-semibold text-slate-900">
            {title}
          </h2>
          {actions}
        </div>
        {children}
      </section>
    </Card>
  )
}

function HistoryEntry({ entry }: { entry: ContractHistoryEntry }) {
  const changes = entry.changes ? Object.entries(entry.changes) : []

  return (
    <li className="px-6 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm font-semibold text-slate-900">{actionLabel(entry.action)}</p>
        <p className="text-xs text-slate-500">
          <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
          {' · '}
          {entry.user ? entry.user.fullName : 'System'}
        </p>
      </div>
      {entry.description && <p className="mt-1 text-sm text-slate-700">{entry.description}</p>}
      {changes.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-sm text-slate-600" aria-label="Changed fields">
          {changes.map(([field, change]) => (
            <li key={field}>
              <span className="font-medium text-slate-700">{FIELD_LABELS[field] ?? field}:</span> {changeValue(field, change?.from)} →{' '}
              {changeValue(field, change?.to)}
            </li>
          ))}
        </ul>
      )}
      {entry.reason && (
        <p className="mt-1 text-sm text-slate-600">
          <span className="font-medium text-slate-700">Reason:</span> {entry.reason}
        </p>
      )}
    </li>
  )
}

type Dialog = { kind: 'none' } | { kind: 'edit' } | { kind: 'renew' } | { kind: 'status'; status: ContractStatus }

function scheduleNote(saved: SavedContract): string {
  const change = saved.scheduleChange
  const parts: string[] = []

  if (change && change.created > 0) parts.push(`${change.created} visit(s) added to the schedule`)
  if (change && change.removed > 0) parts.push(`${change.removed} untouched visit(s) removed`)
  if (saved.cancelledVisits) parts.push(`${saved.cancelledVisits} visit(s) cancelled`)

  return parts.length > 0 ? ` ${parts.join(', ')}.` : ''
}

/** AMC Contract 360: one contract with its validity, figures, schedule, invoices and history. */
export function ContractDetailPage() {
  const { id = '' } = useParams()
  const auth = useAuth()
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' })
  const [invoiceDialog, setInvoiceDialog] = useState<InvoiceDialog>({ kind: 'none' })
  const [notice, setNotice] = useState<string | null>(null)
  const [historyPage, setHistoryPage] = useState(1)

  const canEdit = auth.can('AMC_CONTRACTS', 'EDIT')
  // Cancelling a contract needs its own permission.
  const canCancel = auth.can('AMC_CONTRACTS', 'DELETE')
  const canViewSchedule = auth.can('AMC_SCHEDULE', 'VIEW')
  const canViewInvoices = auth.can('INVOICES', 'VIEW')

  // Always read the record again, so the details shown are the stored values.
  const query = useQuery({ queryKey: ['amc', 'contracts', 'detail', id], queryFn: () => api.get<Contract>(`/amc/contracts/${id}`) })
  const visits = useQuery({
    queryKey: ['amc', 'visits', 'contract', id],
    queryFn: () => api.get<VisitList>(`/amc/visits?contractId=${id}&pageSize=${VISIT_LIMIT}`),
    enabled: canViewSchedule && query.isSuccess,
  })
  const invoices = useQuery({
    queryKey: ['invoices', 'contract', id],
    queryFn: () => api.get<PagedInvoices>(`/invoices?amcContractId=${id}&pageSize=${INVOICE_LIMIT}`),
    enabled: canViewInvoices && query.isSuccess,
  })
  const history = useQuery({
    queryKey: ['amc', 'contracts', 'history', id, historyPage],
    queryFn: () => api.get<ContractHistory>(`/amc/contracts/${id}/history?page=${historyPage}&pageSize=${HISTORY_PAGE_SIZE}`),
    enabled: query.isSuccess,
  })

  const back = (
    <Link to="/amc/contracts" className="text-sm font-medium text-blue-700 hover:underline">
      ← All contracts
    </Link>
  )

  if (query.isPending) {
    return <Spinner label="Loading contract" />
  }

  if (query.isError) {
    const missing = query.error instanceof ApiError && query.error.status === 404

    return (
      <>
        <div className="mb-4">{back}</div>
        <Card>
          {missing ? (
            <EmptyState title="Contract not found" description="It may have been opened from an old link." />
          ) : (
            <LoadError error={query.error} onRetry={() => void query.refetch()} />
          )}
        </Card>
      </>
    )
  }

  const contract = query.data
  const validity = validityState(contract.validFrom, contract.validTo, todayIso())
  const schedule = contract.schedule

  return (
    <>
      <div className="mb-4">{back}</div>

      <PageHeader
        title={`${contract.client.name} — ${contract.systemDescription}`}
        description="AMC contract: validity, contract figures, maintenance schedule, invoices and history."
        actions={
          canEdit && (
            <>
              {contract.status === 'DRAFT' && <Button onClick={() => setDialog({ kind: 'status', status: 'ACTIVE' })}>Activate</Button>}
              {contract.status === 'ACTIVE' && (
                <Button variant="secondary" onClick={() => setDialog({ kind: 'status', status: 'EXPIRED' })}>
                  Mark as expired
                </Button>
              )}
              {(contract.status === 'EXPIRED' || contract.status === 'CANCELLED') && (
                <Button variant="secondary" onClick={() => setDialog({ kind: 'status', status: 'ACTIVE' })}>
                  Reactivate
                </Button>
              )}
              {canCancel && (contract.status === 'DRAFT' || contract.status === 'ACTIVE') && (
                <Button variant="danger" onClick={() => setDialog({ kind: 'status', status: 'CANCELLED' })}>
                  Cancel contract
                </Button>
              )}
              <Button variant="secondary" onClick={() => setDialog({ kind: 'edit' })}>
                Edit
              </Button>
            </>
          )
        }
      />

      {notice && (
        <div className="mb-4">
          <Alert tone="success" onDismiss={() => setNotice(null)}>
            {notice}
          </Alert>
        </div>
      )}

      {contract.isPastValidity && contract.status === 'ACTIVE' && (
        <div className="mb-4">
          <Alert tone="info">The validity period of this contract ended on {formatDate(contract.validTo)}. It is still marked Active.</Alert>
        </div>
      )}

      <div className="space-y-6">
        <div className="grid gap-6 lg:grid-cols-3">
          <Section id="contract-overview-heading" title="Contract overview">
            <dl className="px-6 py-2">
              <DetailRow label="Client">
                {contract.client.name}
                {!contract.client.isActive && ' (inactive)'}
              </DetailRow>
              <DetailRow label="System">{contract.systemDescription}</DetailRow>
              <DetailRow label="Responsible engineer">
                <OrDash value={contract.responsibleEngineer} />
              </DetailRow>
              <DetailRow label="Frequency">{FREQUENCY_LABELS[contract.maintenanceFrequency]}</DetailRow>
              <DetailRow label="Status">
                <span className="inline-flex flex-wrap items-center gap-1">
                  <ContractStatusPill status={contract.status} />
                  {contract.isPastValidity && contract.status === 'ACTIVE' && <Pill tone="amber">Validity ended</Pill>}
                </span>
              </DetailRow>
              <DetailRow label="Description">
                <OrDash value={contract.description} />
              </DetailRow>
              <DetailRow label="Notes">
                <OrDash value={contract.notes} />
              </DetailRow>
            </dl>
            <ContractMastersPanel contractId={contract.id} canEdit={canEdit} />
          </Section>

          <Section id="contract-validity-heading" title="Contract validity">
            <dl className="px-6 py-2">
              <DetailRow label="Start date">{formatDate(contract.validFrom)}</DetailRow>
              <DetailRow label="End date">{formatDate(contract.validTo)}</DetailRow>
              <DetailRow label="Duration">
                {validity ? `${validity.durationDays} calendar days (start and end dates included)` : '—'}
              </DetailRow>
              <DetailRow label="Time remaining">
                {validity ? (
                  <span className={validity.phase === 'ended' ? 'font-medium text-amber-700' : undefined}>{validity.text}</span>
                ) : (
                  '—'
                )}
              </DetailRow>
              <DetailRow label="Created">{formatDateTime(contract.createdAt)}</DetailRow>
              <DetailRow label="Last updated">{formatDateTime(contract.updatedAt)}</DetailRow>
            </dl>
          </Section>

          <Section id="contract-commercial-heading" title="Commercial details">
            <dl className="px-6 py-2">
              <DetailRow label="Contract value">{formatMoney(contract.contractValue)}</DetailRow>
              <DetailRow label="Default visit amount">{formatMoney(contract.defaultVisitAmount)}</DetailRow>
              <DetailRow label="Final credit">{formatMoney(contract.finalCredit)}</DetailRow>
              <DetailRow label="Total of visit amounts">{formatMoney(schedule.scheduledTotal)}</DetailRow>
              <DetailRow label="Contract value less visit amounts">{formatMoney(schedule.valueDifference)}</DetailRow>
            </dl>
            {schedule.visitCount > 0 && (!isZeroMoney(schedule.valueDifference) || schedule.amountMissingCount > 0) && (
              <p className="px-6 pb-4 text-xs text-slate-500">
                {!isZeroMoney(schedule.valueDifference) &&
                  'The visit amounts do not add up to the contract value. This is shown for information; it is not treated as an error. '}
                {schedule.amountMissingCount > 0 && `${schedule.amountMissingCount} visit(s) have no amount yet.`}
              </p>
            )}
          </Section>
        </div>

        <Section id="contract-schedule-heading" title="Service schedule">
          <div className="px-6 py-4">
            <p className="text-sm text-slate-700">
              {schedule.visitCount} visit{schedule.visitCount === 1 ? '' : 's'}: {schedule.completedCount} completed, {schedule.openCount} open
              {schedule.historicalCount > 0 && `, ${schedule.historicalCount} historical`}
              {schedule.cancelledCount > 0 && `, ${schedule.cancelledCount} cancelled`}.
            </p>
            {contract.scheduleCutoverDate !== null && (
              <p className="mt-2 text-sm text-slate-600">
                This contract was imported from an earlier register. Visits are generated only for periods starting on or after{' '}
                {formatDate(contract.scheduleCutoverDate)}. Earlier periods are shown as historical where the earlier schedule listed them, and
                are not created otherwise.
              </p>
            )}
            {contract.status === 'DRAFT' && (
              <p className="mt-2 text-sm text-slate-600">
                {schedule.historicalCount > 0
                  ? 'A draft has no generated schedule. New visits are generated when the contract is activated.'
                  : 'A draft has no schedule. The visits are generated when the contract is activated.'}
              </p>
            )}
          </div>
          {!canViewSchedule && <p className="px-6 pb-4 text-sm text-slate-600">Your role does not include access to the AMC schedule.</p>}
          {canViewSchedule && visits.isPending && <Spinner size="sm" label="Loading visits" />}
          {visits.isError && (
            <div className="px-6 pb-4">
              <LoadError error={visits.error} onRetry={() => void visits.refetch()} />
            </div>
          )}
          {visits.data && visits.data.items.length === 0 && contract.status !== 'DRAFT' && (
            <EmptyState title="No visits scheduled" description="Visits appear here once the contract's schedule has been generated." />
          )}
          {visits.data && visits.data.items.length > 0 && (
            <>
              <div className={TABLE.wrapper}>
                <table className={TABLE.table}>
                  <caption className="sr-only">Visits of this contract</caption>
                  <thead>
                    <tr>
                      <th scope="col" className={TABLE.th}>
                        No.
                      </th>
                      <th scope="col" className={TABLE.th}>
                        Scheduled
                      </th>
                      <th scope="col" className={TABLE.th}>
                        Period
                      </th>
                      <th scope="col" className={TABLE.th}>
                        Status
                      </th>
                      <th scope="col" className={TABLE.th}>
                        Completed
                      </th>
                      <th scope="col" className={`${TABLE.th} text-right`}>
                        Amount
                      </th>
                      <th scope="col" className={TABLE.th}>
                        Invoicing
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {visits.data.items.map((visit) => (
                      <tr key={visit.id}>
                        <td className={TABLE.td}>{visit.sequenceNo}</td>
                        <td className={`${TABLE.td} whitespace-nowrap`}>
                          <PlannedDate visit={visit} format={formatDate} />
                        </td>
                        <td className={`${TABLE.td} whitespace-nowrap`}>
                          {formatDate(visit.periodStart)} – {formatDate(visit.periodEnd)}
                        </td>
                        <td className={TABLE.td}>
                          <VisitStatusPill status={visit.status} overdue={visit.isOverdue} />
                        </td>
                        <td className={`${TABLE.td} whitespace-nowrap`}>{formatDate(visit.completedDate)}</td>
                        <td className={`${TABLE.td} whitespace-nowrap text-right tabular-nums`}>{formatMoney(visit.visitAmount)}</td>
                        <td className={TABLE.td}>
                          <EligibilityPill eligibility={visit.invoiceEligibility} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {visits.data.total > visits.data.items.length && (
                <p className="border-t border-slate-200 px-6 py-3 text-sm text-slate-600">
                  Showing the first {visits.data.items.length} of {visits.data.total} visits. The full list is in{' '}
                  <Link to="/amc/schedule" className="font-medium text-blue-700 hover:underline">
                    AMC Schedule
                  </Link>
                  .
                </p>
              )}
            </>
          )}
        </Section>

        {canViewInvoices && (
          <Section
            id="contract-invoices-heading"
            title="Invoices"
            actions={
              <Link to="/invoices" className="text-sm font-medium text-blue-700 hover:underline">
                Invoice Tracking
              </Link>
            }
          >
            <p className="px-6 pt-3 text-sm text-slate-600">Invoices recorded against at least one visit of this contract.</p>
            {invoices.isPending && <Spinner size="sm" label="Loading invoices" />}
            {invoices.isError && (
              <div className="px-6 py-4">
                <LoadError error={invoices.error} onRetry={() => void invoices.refetch()} />
              </div>
            )}
            {invoices.data && invoices.data.items.length === 0 && (
              <EmptyState title="No invoices recorded for this contract" description="Invoices are recorded in Invoice Tracking once visits are completed." />
            )}
            {invoices.data && invoices.data.items.length > 0 && (
              <>
                <InvoicesTable
                  items={invoices.data.items}
                  showClient={false}
                  canEdit={auth.can('INVOICES', 'EDIT')}
                  onDialog={setInvoiceDialog}
                />
                {invoices.data.total > invoices.data.items.length && (
                  <p className="border-t border-slate-200 px-6 py-3 text-sm text-slate-600">
                    Showing the latest {invoices.data.items.length} of {invoices.data.total} invoices. The full list is in Invoice Tracking.
                  </p>
                )}
              </>
            )}
          </Section>
        )}

        <Section id="contract-renewals-heading" title="Renewals">
          <ContractRenewalsPanel contractId={contract.id} canRenew={auth.can('AMC_CONTRACTS', 'CREATE')} onRenew={() => setDialog({ kind: 'renew' })} />
        </Section>

        <Section id="contract-documents-heading" title="Documents">
          <AttachmentsPanel entityType="amc_contracts" entityId={contract.id} canUpload={canEdit} />
        </Section>

        <Section id="contract-history-heading" title="Contract history">
          {history.isPending && <Spinner size="sm" label="Loading history" />}
          {history.isError && (
            <div className="px-6 py-4">
              <LoadError error={history.error} onRetry={() => void history.refetch()} />
            </div>
          )}
          {history.data && history.data.items.length === 0 && <EmptyState title="No history recorded for this contract" />}
          {history.data && history.data.items.length > 0 && (
            <>
              <ol className="divide-y divide-slate-100" aria-label="Contract history, newest first">
                {history.data.items.map((entry) => (
                  <HistoryEntry key={entry.id} entry={entry} />
                ))}
              </ol>
              <Pager
                page={history.data.page}
                pageSize={history.data.pageSize}
                total={history.data.total}
                shown={history.data.items.length}
                onPage={setHistoryPage}
              />
            </>
          )}
        </Section>
      </div>

      {dialog.kind === 'edit' && (
        <ContractFormModal
          contract={contract}
          onClose={() => setDialog({ kind: 'none' })}
          onSaved={(saved) => {
            setNotice(`The contract was updated.${scheduleNote(saved)}`)
            setDialog({ kind: 'none' })
          }}
        />
      )}

      {dialog.kind === 'renew' && (
        <ContractFormModal
          contract={null}
          renewalOf={contract}
          onClose={() => setDialog({ kind: 'none' })}
          onSaved={(saved) => {
            setNotice(`Renewal created as a separate ${CONTRACT_STATUS_LABELS[saved.status].toLowerCase()} contract (${formatDate(saved.validFrom)} to ${formatDate(saved.validTo)}). This contract is unchanged.`)
            setDialog({ kind: 'none' })
          }}
        />
      )}

      {dialog.kind === 'status' && (
        <ContractStatusDialog
          contract={contract}
          status={dialog.status}
          onClose={() => setDialog({ kind: 'none' })}
          onChanged={(saved) => {
            setNotice(`The contract is now ${CONTRACT_STATUS_LABELS[saved.status]}.${scheduleNote(saved)}`)
            setDialog({ kind: 'none' })
          }}
        />
      )}

      <InvoiceDialogs dialog={invoiceDialog} setDialog={setInvoiceDialog} canEdit={auth.can('INVOICES', 'EDIT')} onNotice={setNotice} />
    </>
  )
}

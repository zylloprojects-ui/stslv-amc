import { useQuery } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../../auth/context'
import { AttachmentsPanel } from '../../components/AttachmentsPanel'
import { PageTabs, TabPanel, useTabsLayout } from '../../components/PageTabs'
import { ContactChip } from '../../components/ProfileParts'
import { LoadError } from '../../components/records'
import { TABLE } from '../../components/table'
import { Alert, BannerButton, Card, EmptyState, PageHeader, Spinner } from '../../components/ui'
import { api, ApiError } from '../../lib/api'
import { cx, formatDateTime } from '../../lib/format'
import type { PagedInvoices } from '../../lib/invoiceTypes'
import { InvoiceDialogs, type InvoiceDialog } from '../invoices/InvoiceDialogs'
import { InvoicesTable } from '../invoices/InvoicesTable'
import { formatDate, formatMoney, isZeroMoney, todayIso } from './amcFormat'
import { ContractStatusPill, EligibilityPill, OrDash, Pager, Pill, PlannedDate, VisitStatusPill } from './components'
import { ContractFormModal } from './ContractFormModal'
import { ContractMastersPanel } from './ContractMastersPanel'
import { ContractRenewalsPanel } from './ContractRenewalsPanel'
import { ContractStatusDialog } from './ContractStatusDialog'
import { validityState } from './contractValidity'
import {
  CONTRACT_STATUS_LABELS,
  frequencyLabel,
  visitNumberLabel,
  type Contract,
  type ContractHistory,
  type ContractHistoryEntry,
  type ContractStatus,
  type SavedContract,
  type VisitList,
} from './types'

// The page shows up to this many visits and invoices; the full lists are on their own pages.
const VISIT_LIMIT = 200
const INVOICE_LIMIT = 50
const HISTORY_PAGE_SIZE = 20

type TabId = 'schedule' | 'invoices' | 'renewals' | 'documents' | 'history' | 'details'

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
  if (field === 'maintenanceFrequency') {
    return frequencyLabel(value)
  }
  if (MONEY_FIELDS.has(field)) {
    return formatMoney(value)
  }
  if (DATE_FIELDS.has(field)) {
    return formatDate(value)
  }

  return value
}

/** One fact of the contract: the caption above, the value below. `inline` puts the value on the right, for short figures. */
function Fact({ label, inline = false, children }: { label: string; inline?: boolean; children: ReactNode }) {
  return (
    <div className={inline ? 'flex items-baseline justify-between gap-4 border-b border-slate-200 py-3 last:border-0' : 'border-b border-slate-200 py-3 last:border-0'}>
      <dt className="text-[11px] font-bold uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className={inline ? 'min-w-0 break-words text-right text-sm font-bold tabular-nums text-slate-900' : 'mt-1 min-w-0 break-words whitespace-pre-wrap text-sm font-semibold text-slate-900'}>{children}</dd>
    </div>
  )
}

/** A thin bar showing a share of a whole. Decorative: the dates and counts it pictures are written out beside it. */
function ShareBar({ share, title }: { share: number; title: string }) {
  return (
    <div className="h-2 overflow-hidden rounded-full bg-sky-100" aria-hidden="true" title={title}>
      <div className="h-2 rounded-full bg-gradient-to-r from-[#0e5a96] to-[#2f9bd8]" style={{ width: `${Math.round(Math.min(Math.max(share, 0), 1) * 100)}%` }} />
    </div>
  )
}

/** The share (0 to 1) of the period from one date to another that has passed by a given day. */
function elapsedShare(from: string, to: string, today: string): number {
  const start = Date.parse(from)
  const end = Date.parse(to)

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0

  return (Date.parse(today) - start) / (end - start)
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
  const [activeTab, setActiveTab] = useState<TabId>('schedule')
  const layout = useTabsLayout()

  const canEdit = auth.can('AMC_CONTRACTS', 'EDIT')
  // Cancelling a contract needs its own permission.
  const canCancel = auth.can('AMC_CONTRACTS', 'DELETE')
  const canViewSchedule = auth.can('AMC_SCHEDULE', 'VIEW')
  // The contract's invoices: data-only read is enough (it opens no Finance page).
  const canViewInvoices = auth.canRead('INVOICES')

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
    <Link to="/amc/contracts" className="inline-flex items-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-[#0b3b66] shadow-sm hover:bg-sky-50">
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

  // What the profile bar and the figures do not already say; the linked master records are here too.
  const detailsBody = (
    <>
      <dl className="grid gap-x-10 px-6 py-1 sm:grid-cols-2 lg:grid-cols-3">
        <Fact label="Description">
          <OrDash value={contract.description} />
        </Fact>
        <Fact label="Notes">
          <OrDash value={contract.notes} />
        </Fact>
        <Fact label="Duration">{validity ? `${validity.durationDays} calendar days (start and end dates included)` : '—'}</Fact>
        <Fact label="Created">{formatDateTime(contract.createdAt)}</Fact>
        <Fact label="Last updated">{formatDateTime(contract.updatedAt)}</Fact>
      </dl>
      <ContractMastersPanel contractId={contract.id} canEdit={canEdit} />
    </>
  )

  const PANEL: Record<TabId, [string, string]> = {
    schedule: ['Service schedule', 'Every maintenance visit of this contract and where it stands.'],
    invoices: ['Invoices', 'Invoices recorded against visits of this contract.'],
    renewals: ['Renewals', 'Renewal history and renewing this contract.'],
    documents: ['Documents', 'Files attached to this contract.'],
    history: ['Contract history', 'Every change made to this contract.'],
    details: ['Details', 'Description, notes and linked master records.'],
  }

  const tabs: { id: TabId; label: string; count?: number }[] = [
    { id: 'schedule', label: 'Service schedule', count: schedule.visitCount },
    ...(canViewInvoices ? [{ id: 'invoices' as const, label: 'Invoices', count: invoices.data?.total }] : []),
    { id: 'renewals', label: 'Renewals' },
    { id: 'documents', label: 'Documents' },
    { id: 'history', label: 'Contract history' },
    { id: 'details', label: 'Details' },
  ]

  return (
    <>
      <div className="mb-4">{back}</div>

      <PageHeader
        title={`${contract.client.name} — ${contract.systemDescription}`}
        description="AMC contract: validity, contract figures, maintenance schedule, invoices and history."
        actions={
          canEdit && (
            <>
              {contract.status === 'DRAFT' && <BannerButton onClick={() => setDialog({ kind: 'status', status: 'ACTIVE' })}>Activate</BannerButton>}
              {contract.status === 'ACTIVE' && <BannerButton onClick={() => setDialog({ kind: 'status', status: 'EXPIRED' })}>Mark as expired</BannerButton>}
              {(contract.status === 'EXPIRED' || contract.status === 'CANCELLED') && (
                <BannerButton onClick={() => setDialog({ kind: 'status', status: 'ACTIVE' })}>Reactivate</BannerButton>
              )}
              {canCancel && (contract.status === 'DRAFT' || contract.status === 'ACTIVE') && (
                <BannerButton danger onClick={() => setDialog({ kind: 'status', status: 'CANCELLED' })}>
                  Cancel contract
                </BannerButton>
              )}
              <BannerButton onClick={() => setDialog({ kind: 'edit' })}>Edit</BannerButton>
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
        <Card className="rounded-2xl">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-4 p-5">
            <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-[#0a3a66] to-[#2f9bd8] text-white shadow-md" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20V3.5Z" strokeLinejoin="round" />
                <path d="M14 3.5v4h4M9.5 12h5M9.5 15.5h5" strokeLinecap="round" />
              </svg>
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <ContractStatusPill status={contract.status} />
                {contract.isPastValidity && contract.status === 'ACTIVE' && <Pill tone="amber">Validity ended</Pill>}
                <span className="rounded-full bg-sky-50 px-2.5 py-0.5 text-xs font-semibold text-[#0b3b66] ring-1 ring-inset ring-sky-200">{frequencyLabel(contract.maintenanceFrequency)}</span>
              </div>
              <p className={cx('mt-1.5 text-sm font-semibold', validity?.phase === 'ended' ? 'text-amber-700' : 'text-slate-700')}>{validity ? validity.text : '—'}</p>
            </div>
            <dl className="grid min-w-0 flex-1 basis-[30rem] gap-3 sm:grid-cols-2 2xl:grid-cols-4">
              <ContactChip icon="building" label="Client">
                {contract.client.name}
                {!contract.client.isActive && ' (inactive)'}
              </ContactChip>
              <ContactChip icon="badge" label="System">
                {contract.systemDescription}
              </ContactChip>
              <ContactChip icon="user" label="Responsible engineer">
                <OrDash value={contract.responsibleEngineer} />
              </ContactChip>
              <ContactChip icon="clock" label="Validity">
                {formatDate(contract.validFrom)} – {formatDate(contract.validTo)}
              </ContactChip>
            </dl>
          </div>
          {validity && (
            <div className="border-t border-slate-200 bg-slate-50/70 px-5 py-3">
              <ShareBar share={elapsedShare(contract.validFrom, contract.validTo, todayIso())} title="Share of the validity period that has passed" />
            </div>
          )}
        </Card>

        <section aria-label="Contract figures">
          <Card className="rounded-2xl">
            <dl className="grid grid-cols-2 divide-x divide-y divide-slate-200 lg:grid-cols-5 lg:divide-y-0">
              {[
                { label: 'Contract value', value: formatMoney(contract.contractValue) },
                { label: 'Default visit amount', value: formatMoney(contract.defaultVisitAmount) },
                { label: 'Final credit', value: formatMoney(contract.finalCredit) },
                { label: 'Total of visit amounts', value: formatMoney(schedule.scheduledTotal) },
                { label: 'Contract value less visit amounts', value: formatMoney(schedule.valueDifference) },
              ].map((figure) => (
                <div key={figure.label} className="min-w-0 px-5 py-4">
                  <dt className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">{figure.label}</dt>
                  <dd className="mt-1.5 text-xl font-bold leading-none tabular-nums text-[#0b3b66]">{figure.value}</dd>
                </div>
              ))}
            </dl>
          </Card>
          {schedule.visitCount > 0 && (!isZeroMoney(schedule.valueDifference) || schedule.amountMissingCount > 0) && (
            <p className="mt-2 text-xs text-slate-500">
              {!isZeroMoney(schedule.valueDifference) && 'The visit amounts do not add up to the contract value. This is shown for information; it is not treated as an error. '}
              {schedule.amountMissingCount > 0 && `${schedule.amountMissingCount} visit(s) have no amount yet.`}
            </p>
          )}
        </section>

        <div className={layout.wrapper}>
          <PageTabs label="Contract records" idPrefix="contract-tab" active={activeTab} onChange={setActiveTab} tabs={tabs} />
          <TabPanel idPrefix="contract-tab" active={activeTab} title={PANEL[activeTab][0]} description={PANEL[activeTab][1]}>
            <div>
              {activeTab === 'schedule' && (
                <>
                    <div className="px-6 py-4">
                      {schedule.visitCount > 0 && (
                        <div className="mb-3">
                          <ShareBar share={schedule.completedCount / schedule.visitCount} title="Share of the visits that are completed" />
                        </div>
                      )}
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
                                  <td className={`${TABLE.td} whitespace-nowrap`}>{visitNumberLabel(visit)}</td>
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

                </>
              )}
              {activeTab === 'invoices' && canViewInvoices && (
                <>
                  <div className="flex justify-end border-b border-slate-200 bg-slate-50/70 px-4 py-2.5">
                    <Link to="/invoices" className="text-sm font-semibold text-[#1479BD] hover:underline">
                      Invoice Tracking →
                    </Link>
                  </div>
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

                </>
              )}
              {activeTab === 'renewals' && <ContractRenewalsPanel contractId={contract.id} canRenew={auth.can('AMC_RENEWAL', 'CREATE')} onRenew={() => setDialog({ kind: 'renew' })} />}
              {activeTab === 'documents' && <AttachmentsPanel entityType="amc_contracts" entityId={contract.id} canUpload={canEdit} />}
              {activeTab === 'history' && (
                <>
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

                </>
              )}
              {activeTab === 'details' && detailsBody}
            </div>
          </TabPanel>
        </div>
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

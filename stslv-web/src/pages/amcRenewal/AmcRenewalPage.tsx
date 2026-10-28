import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../auth/context'
import { ExportButtons } from '../../components/ExportButtons'
import { PageTabs, TabPanel } from '../../components/PageTabs'
import { TABLE } from '../../components/table'
import { Alert, Button, EmptyState, Modal, PageHeader, Spinner } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { cx, formatDate, formatDateTime } from '../../lib/format'
import { formatMoney } from '../../lib/money'
import { queryString } from '../amc/amcApi'
import { Filter, Pager } from '../amc/components'
import { ContractFormModal } from '../amc/ContractFormModal'
import { ContractStatusDialog } from '../amc/ContractStatusDialog'
import { amcReference } from '../amc/calendar/calendarTypes'
import { CONTRACT_STATUS_LABELS, type Contract, type ContractStatus } from '../amc/types'
import { KpiGroup } from '../amcManagement/KpiGroup'
import { RENEWAL_KPIS } from './renewalKpis'
import { COLUMN_IDS, COLUMN_LABELS, RENEWAL_KPI_PREFIX, useHiddenColumns, type ColumnId } from './renewalPreferences'
import {
  RENEWAL_STATES,
  RENEWAL_STATE_LABELS,
  RENEWAL_STATE_TONES,
  renewalStateOf,
  type RenewalHistory,
  type RenewalQueue,
  type RenewalQueueItem,
  type RenewalState,
} from './renewalTypes'

// AMC Renewal: the contracts due for renewal and the renewals made of them.
// The queue and the history are read-only views. Each action opens the
// contract dialogs used elsewhere (create a renewal, change a contract's
// status), so the API applies the same checks and permissions everywhere.
// A renewal is a separate contract; the contract it renews is never changed.

const PAGE_SIZE = 50
type TabId = 'queue' | 'history'

const isState = (value: string | null): value is RenewalState => RENEWAL_STATES.includes(value as RenewalState)

function StatePill({ state }: { state: RenewalState }) {
  return <span className={cx('inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset', RENEWAL_STATE_TONES[state])}>{RENEWAL_STATE_LABELS[state]}</span>
}

const Missing = ({ title }: { title: string }) => (
  <span className="text-slate-400" title={title}>
    —<span className="sr-only">{title}</span>
  </span>
)

function expiryNote(daysLeft: number): string {
  if (daysLeft < 0) return `Ended ${-daysLeft} day${daysLeft === -1 ? '' : 's'} ago`
  if (daysLeft === 0) return 'Ends today'
  return `Ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`
}

/**
 * The Actions column stays at the right edge while the wide table scrolls, so
 * the row's actions are reachable at any screen width. Opaque, with a soft edge.
 */
const STICKY_ACTIONS = 'sticky right-0 z-[1] shadow-[-8px_0_8px_-8px_rgba(15,23,42,0.25)]'

/** What a row's action opens: a renewal of the source, or a status change of its renewal. */
type Action = { kind: 'renew'; contractId: string } | { kind: 'status'; contractId: string; status: ContractStatus }

export function AmcRenewalPage() {
  const auth = useAuth()
  const [params, setParams] = useSearchParams()
  const tab: TabId = params.get('tab') === 'history' ? 'history' : 'queue'
  const [notice, setNotice] = useState<string | null>(null)

  const setTab = (next: TabId) => {
    const nextParams = new URLSearchParams(params)
    if (next === 'history') nextParams.set('tab', 'history')
    else nextParams.delete('tab')
    setParams(nextParams, { replace: true })
  }

  return (
    <>
      <PageHeader title="AMC Renewal" description="Contracts due for renewal, client approval and renewal history. A renewal is a new contract; the contract it renews is never changed." />

      {notice && (
        <div className="mb-4">
          <Alert tone="success" onDismiss={() => setNotice(null)}>
            {notice}
          </Alert>
        </div>
      )}

      <PageTabs
        label="AMC Renewal"
        idPrefix="renewal-tab"
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'queue', label: 'Renewal Queue' },
          { id: 'history', label: 'Renewal History' },
        ]}
      />
      {tab === 'queue' ? <QueueTab userId={auth.user?.id ?? 'anonymous'} onNotice={setNotice} /> : <HistoryTab />}
    </>
  )
}

// --- Renewal Queue -------------------------------------------------------------

function QueueTab({ userId, onNotice }: { userId: string; onNotice: (message: string) => void }) {
  const auth = useAuth()
  const [params, setParams] = useSearchParams()
  const status = params.get('status')
  const renewalStatus = isState(status) ? status : ''
  const [search, setSearch] = useState('')
  const [draftSearch, setDraftSearch] = useState('')
  const [page, setPage] = useState(1)
  const [hidden, setHidden] = useHiddenColumns(userId)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [action, setAction] = useState<Action | null>(null)

  const filters = { search, renewalStatus }
  const queue = useQuery({
    queryKey: ['amc', 'renewals', 'queue', { ...filters, page }],
    queryFn: () => api.get<RenewalQueue>(`/amc/renewals/queue${queryString({ ...filters, page, pageSize: PAGE_SIZE })}`),
    placeholderData: keepPreviousData,
  })

  // The status filter lives in the address, so a KPI card's link filters the queue.
  const setStatus = (value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set('status', value)
    else next.delete('status')
    setParams(next, { replace: true })
    setPage(1)
  }
  const apply = (event: FormEvent) => {
    event.preventDefault()
    setSearch(draftSearch.trim())
    setPage(1)
  }
  const reset = () => {
    setDraftSearch('')
    setSearch('')
    setStatus('')
  }
  const filtered = search !== '' || renewalStatus !== ''
  const data = queue.data
  const shown = (id: ColumnId) => !hidden.has(id)
  const visible = COLUMN_IDS.filter(shown)
  const canView = (module: Parameters<typeof auth.can>[0]) => auth.can(module, 'VIEW')

  return (
    <TabPanel
      idPrefix="renewal-tab"
      active="queue"
      title="Renewal Queue"
      description={`Active or expired contracts ending within ${data?.windowDays ?? 45} days or already ended, and those with a renewal.${data?.today ? ` As of ${formatDate(data.today)}.` : ''}`}
      actions={
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => setColumnsOpen(true)}>
            Hide Columns · {visible.length} of {COLUMN_IDS.length} shown
          </Button>
          {auth.can('AMC_CONTRACTS', 'EXPORT') && (
            <ExportButtons
              what="Renewal Queue"
              fileStem="amc-renewal-queue"
              size="sm"
              path={(format) => `/amc/renewals/queue/export${queryString({ ...filters, hidden: [...hidden].join(','), format })}`}
              onError={setExportError}
            />
          )}
        </div>
      }
    >
      <div className="p-4 sm:p-5">
        {exportError && (
          <div className="mb-4">
            <Alert onDismiss={() => setExportError(null)}>{exportError}</Alert>
          </div>
        )}
        <KpiGroup group={RENEWAL_KPIS} userId={userId} data={data} failed={queue.isError} canView={canView} storagePrefix={RENEWAL_KPI_PREFIX} />

        <form className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" onSubmit={apply} aria-label="Filters">
          <Filter label="Search" className="sm:col-span-2">
            {(id, className) => (
              <input id={id} type="search" value={draftSearch} onChange={(event) => setDraftSearch(event.target.value)} placeholder="AMC reference, client or system" className={className} />
            )}
          </Filter>
          <Filter label="Renewal Status">
            {(id, className) => (
              <select id={id} value={renewalStatus} onChange={(event) => setStatus(event.target.value)} className={className}>
                <option value="">All statuses</option>
                {RENEWAL_STATES.map((value) => (
                  <option key={value} value={value}>
                    {RENEWAL_STATE_LABELS[value]}
                  </option>
                ))}
              </select>
            )}
          </Filter>
          <div className="flex items-end gap-2">
            <Button type="submit" variant={draftSearch.trim() !== search ? 'primary' : 'secondary'}>
              Search
            </Button>
            <Button variant="secondary" disabled={!filtered && draftSearch === ''} onClick={reset}>
              Reset
            </Button>
          </div>
        </form>
      </div>

      {queue.isPending && <Spinner label="Loading the renewal queue" />}
      {queue.isError && (
        <div className="px-4 pb-4 sm:px-5">
          <Alert>
            {errorMessage(queue.error)}{' '}
            <button type="button" className="font-medium underline" onClick={() => void queue.refetch()}>
              Try again
            </button>
          </Alert>
        </div>
      )}
      {data && data.items.length === 0 && (
        <EmptyState
          title="No contracts in the renewal queue"
          description={filtered ? 'No contract matches these filters.' : `A contract appears here ${data.windowDays} days before its validity ends.`}
          action={filtered ? <Button variant="secondary" onClick={reset}>Reset</Button> : undefined}
        />
      )}
      {data && data.items.length > 0 && (
        <>
          <p className="border-t border-slate-200 px-4 py-2 text-sm text-slate-500 sm:px-5" aria-live="polite">
            <span className="font-semibold tabular-nums text-slate-800">{data.total}</span> {data.total === 1 ? 'contract' : 'contracts'}
          </p>
          <div className={TABLE.wrapper}>
            <table className={TABLE.table}>
              <caption className="sr-only">Renewal Queue</caption>
              <thead>
                <tr>
                  <th scope="col" className={TABLE.snHead}>
                    #
                  </th>
                  <th scope="col" className={TABLE.th}>
                    AMC Reference
                  </th>
                  {visible.map((id) => (
                    <th key={id} scope="col" className={cx(TABLE.th, id === 'amount' && 'text-right')}>
                      {COLUMN_LABELS[id]}
                    </th>
                  ))}
                  <th scope="col" className={TABLE.th}>
                    Renewal Status
                  </th>
                  <th scope="col" className={cx(TABLE.th, STICKY_ACTIONS, 'bg-slate-50')}>
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.items.map((item, index) => (
                  <QueueRow key={item.id} item={item} number={(data.page - 1) * data.pageSize + index + 1} shown={shown} onAction={setAction} />
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} shown={data.items.length} onPage={setPage} />
        </>
      )}

      {columnsOpen && (
        <HideColumnsDialog
          hidden={hidden}
          onSave={(next) => {
            setHidden(next)
            setColumnsOpen(false)
          }}
          onClose={() => setColumnsOpen(false)}
        />
      )}
      {action && <ActionDialog action={action} onClose={() => setAction(null)} onDone={(message) => { setAction(null); onNotice(message) }} />}
    </TabPanel>
  )
}

function QueueRow({ item, number, shown, onAction }: { item: RenewalQueueItem; number: number; shown: (id: ColumnId) => boolean; onAction: (action: Action) => void }) {
  const auth = useAuth()
  const canCreate = auth.can('AMC_CONTRACTS', 'CREATE')
  const canEdit = auth.can('AMC_CONTRACTS', 'EDIT')
  const canCancel = canEdit && auth.can('AMC_CONTRACTS', 'DELETE')
  const renewal = item.renewal
  const actionClass = 'inline-flex items-center rounded-lg border px-2.5 py-1 text-xs font-semibold shadow-sm'

  return (
    <tr className={TABLE.row} data-state={item.renewalState}>
      <td className={TABLE.sn}>{number}</td>
      <td className={`${TABLE.td} whitespace-nowrap`}>
        <Link to={`/amc/contracts/${item.id}`} className="font-mono text-sm font-semibold text-[#0b3b66] hover:underline" aria-label={`Open contract ${item.reference}`}>
          {item.reference}
        </Link>
      </td>
      {shown('client') && <td className={`${TABLE.td} ${TABLE.text} font-semibold text-slate-900`}>{item.client.name}</td>}
      {shown('system') && (
        <td className={`${TABLE.td} ${TABLE.text}`}>
          {item.system.typeName ?? item.system.description}
          {item.system.typeName && item.system.typeName !== item.system.description && <div className="text-xs text-slate-500">{item.system.description}</div>}
        </td>
      )}
      {shown('frequency') && <td className={`${TABLE.td} whitespace-nowrap`}>{item.frequency.label}</td>}
      {shown('service') && (
        <td className={`${TABLE.td} whitespace-nowrap`} title="Completed visits of scheduled visits (cancelled visits not counted)">
          <span className="tabular-nums font-medium text-slate-900">
            {item.services.completed} / {item.services.scheduled}
          </span>
          <div className="text-xs text-slate-500">completed</div>
        </td>
      )}
      {shown('expiry') && (
        <td className={`${TABLE.td} whitespace-nowrap`}>
          <div className="font-medium text-slate-900">{formatDate(item.validTo)}</div>
          <div className={cx('text-xs', item.daysLeft < 0 ? 'font-semibold text-red-700' : 'text-slate-500')}>{expiryNote(item.daysLeft)}</div>
        </td>
      )}
      {shown('contractStatus') && <td className={`${TABLE.td} whitespace-nowrap`}>{CONTRACT_STATUS_LABELS[item.contractStatus]}</td>}
      {shown('amount') && <td className={`${TABLE.td} whitespace-nowrap text-right font-semibold tabular-nums text-slate-900`}>{formatMoney(item.contractValue)}</td>}
      {shown('remarks') && <td className={`${TABLE.td} ${TABLE.text} text-xs`}>{item.remarks ?? <Missing title="No remarks" />}</td>}
      <td className={TABLE.td}>
        <StatePill state={item.renewalState} />
        {renewal && (
          <div className="mt-1 text-xs text-slate-500">
            <Link to={`/amc/contracts/${renewal.id}`} className="font-mono font-semibold text-[#1479BD] hover:underline">
              {renewal.reference}
            </Link>{' '}
            {formatDate(renewal.validFrom)} – {formatDate(renewal.validTo)}
          </div>
        )}
      </td>
      <td className={cx(TABLE.td, STICKY_ACTIONS, 'whitespace-nowrap bg-white')}>
        <div className="flex flex-wrap gap-1.5">
          {(item.renewalState === 'DUE' || item.renewalState === 'CANCELLED') && canCreate && (
            <button type="button" className={`${actionClass} border-[#1479BD] bg-[#1479BD] text-white hover:bg-[#0e5a96]`} onClick={() => onAction({ kind: 'renew', contractId: item.id })}>
              {item.renewalState === 'CANCELLED' ? 'Restart Renewal' : 'Start Renewal'}
            </button>
          )}
          {item.renewalState === 'UNDER_APPROVAL' && renewal && canEdit && (
            <button
              type="button"
              className={`${actionClass} border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700`}
              onClick={() => onAction({ kind: 'status', contractId: renewal.id, status: 'ACTIVE' })}
            >
              Approve
            </button>
          )}
          {item.renewalState === 'UNDER_APPROVAL' && renewal && canCancel && (
            <button
              type="button"
              className={`${actionClass} border-slate-300 bg-white text-red-700 hover:border-red-400`}
              onClick={() => onAction({ kind: 'status', contractId: renewal.id, status: 'CANCELLED' })}
            >
              Cancel
            </button>
          )}
          <Link to={`/amc/contracts/${renewal && item.renewalState !== 'CANCELLED' ? renewal.id : item.id}`} className={`${actionClass} border-slate-300 bg-white text-[#0b3b66] hover:border-[#1479BD]`}>
            {renewal && item.renewalState !== 'CANCELLED' ? 'View Renewal' : 'View'}
          </Link>
        </div>
      </td>
    </tr>
  )
}

/** Loads the contract the action is about, then opens the usual contract dialog for it. */
function ActionDialog({ action, onClose, onDone }: { action: Action; onClose: () => void; onDone: (message: string) => void }) {
  const contract = useQuery({ queryKey: ['amc', 'contracts', 'detail', action.contractId], queryFn: () => api.get<Contract>(`/amc/contracts/${action.contractId}`) })

  if (!contract.data) {
    return (
      <Modal title="AMC Renewal" onClose={onClose}>
        {contract.isError ? <Alert>{errorMessage(contract.error)}</Alert> : <Spinner label="Loading the contract" />}
      </Modal>
    )
  }

  if (action.kind === 'renew') {
    return (
      <ContractFormModal
        contract={null}
        renewalOf={contract.data}
        draftOnly
        onClose={onClose}
        onSaved={(saved) => onDone(`Renewal ${amcReference(saved.id)} created for ${amcReference(action.contractId)} (${formatDate(saved.validFrom)} to ${formatDate(saved.validTo)}). It is under client approval; ${amcReference(action.contractId)} is unchanged.`)}
      />
    )
  }

  return (
    <ContractStatusDialog
      contract={contract.data}
      status={action.status}
      onClose={onClose}
      onChanged={(saved) =>
        onDone(
          saved.status === 'ACTIVE'
            ? `Renewal ${amcReference(saved.id)} approved: it is now active and its schedule was generated.`
            : `Renewal ${amcReference(saved.id)} cancelled. It is kept in the renewal history, and a new renewal can be started.`,
        )
      }
    />
  )
}

/** Show or hide columns. AMC Reference, Renewal Status and Actions always stay. */
function HideColumnsDialog({ hidden, onSave, onClose }: { hidden: ReadonlySet<ColumnId>; onSave: (hidden: ReadonlySet<ColumnId>) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<Set<ColumnId>>(new Set(hidden))
  const toggle = (id: ColumnId) => {
    const next = new Set(draft)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setDraft(next)
  }

  return (
    <Modal
      title="Hide columns"
      onClose={onClose}
      footer={
        <div className="flex flex-wrap justify-between gap-2">
          <Button variant="secondary" onClick={() => setDraft(new Set())}>
            Reset to Default
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => onSave(draft)}>Apply</Button>
          </div>
        </div>
      }
    >
      <p className="mb-3 text-sm text-slate-600">AMC Reference, Renewal Status and Actions are always shown. Downloads include only the columns shown here.</p>
      <fieldset>
        <legend className="sr-only">Columns to show</legend>
        <ul className="grid gap-1 sm:grid-cols-2">
          {COLUMN_IDS.map((id) => (
            <li key={id}>
              <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-slate-700 hover:bg-sky-50">
                <input type="checkbox" checked={!draft.has(id)} onChange={() => toggle(id)} className="h-4 w-4 rounded border-slate-300 accent-[#1479BD]" />
                {COLUMN_LABELS[id]}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
    </Modal>
  )
}

// --- Renewal History -----------------------------------------------------------

function HistoryTab() {
  const auth = useAuth()
  const [page, setPage] = useState(1)
  const [exportError, setExportError] = useState<string | null>(null)
  const history = useQuery({
    queryKey: ['amc', 'renewals', 'history', page],
    queryFn: () => api.get<RenewalHistory>(`/amc/reports/renewals${queryString({ page, pageSize: PAGE_SIZE })}`),
    placeholderData: keepPreviousData,
  })
  const data = history.data

  return (
    <TabPanel
      idPrefix="renewal-tab"
      active="history"
      title="Renewal History"
      description="Every renewal made, newest first, cancelled ones included. The contract renewed and its visits, invoices and history are kept unchanged."
      actions={
        auth.can('AMC_CONTRACTS', 'EXPORT') ? (
          <ExportButtons what="Renewal History" fileStem="amc-renewal-history" size="sm" path={(format) => `/amc/reports/renewals/export${queryString({ format })}`} onError={setExportError} />
        ) : undefined
      }
    >
      {exportError && (
        <div className="p-4">
          <Alert onDismiss={() => setExportError(null)}>{exportError}</Alert>
        </div>
      )}
      {history.isPending && <Spinner label="Loading the renewal history" />}
      {history.isError && (
        <div className="p-4">
          <Alert>
            {errorMessage(history.error)}{' '}
            <button type="button" className="font-medium underline" onClick={() => void history.refetch()}>
              Try again
            </button>
          </Alert>
        </div>
      )}
      {data && data.items.length === 0 && <EmptyState title="No renewals yet" description="A renewal appears here as soon as it is started from the Renewal Queue or a contract." />}
      {data && data.items.length > 0 && (
        <>
          <div className={TABLE.wrapper}>
            <table className={TABLE.table}>
              <caption className="sr-only">Renewal History</caption>
              <thead>
                <tr>
                  {['Source AMC', 'Client / System', 'Source Expiry', 'Renewed AMC', 'New Validity', 'Status', 'Created'].map((label) => (
                    <th key={label} scope="col" className={TABLE.th}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.items.map(({ renewal, source, createdOn }) => (
                  <tr key={renewal.id} className={TABLE.row}>
                    <td className={`${TABLE.td} whitespace-nowrap`}>
                      <Link to={`/amc/contracts/${source.id}`} className="font-mono text-sm font-semibold text-[#0b3b66] hover:underline">
                        {amcReference(source.id)}
                      </Link>
                    </td>
                    <td className={`${TABLE.td} ${TABLE.text}`}>
                      <div className="font-semibold text-slate-900">{renewal.client.name}</div>
                      <div className="text-xs text-slate-500">{renewal.systemDescription}</div>
                    </td>
                    <td className={`${TABLE.td} whitespace-nowrap`}>{formatDate(source.validTo)}</td>
                    <td className={`${TABLE.td} whitespace-nowrap`}>
                      <Link to={`/amc/contracts/${renewal.id}`} className="font-mono text-sm font-semibold text-[#1479BD] hover:underline">
                        {amcReference(renewal.id)}
                      </Link>
                    </td>
                    <td className={`${TABLE.td} whitespace-nowrap`}>
                      {formatDate(renewal.validFrom)} – {formatDate(renewal.validTo)}
                    </td>
                    <td className={TABLE.td}>
                      <StatePill state={renewalStateOf(renewal.status)} />
                      <div className="mt-1 text-xs text-slate-500">Contract: {CONTRACT_STATUS_LABELS[renewal.status]}</div>
                    </td>
                    <td className={`${TABLE.td} whitespace-nowrap`} title={formatDateTime(renewal.createdAt)}>
                      {formatDate(createdOn)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} shown={data.items.length} onPage={setPage} />
        </>
      )}
    </TabPanel>
  )
}

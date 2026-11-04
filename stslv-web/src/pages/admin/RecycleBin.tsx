import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { LoadError, Pager } from '../../components/records'
import { TABLE } from '../../components/table'
import { Alert, Button, Card, EmptyState, Modal, Spinner, TextField } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { cx, formatDate, formatDateTime } from '../../lib/format'
import { refreshOperationalData } from '../../lib/refreshOperationalData'
import { queryString } from '../amc/amcApi'
import { Filter } from '../amc/components'

// The Recycle Bin (migrations 0101 and 0106): the AMC contracts, clients, system types and sales engineers
// that are deleted now. It is read from each record's current state, never from past events, so a
// restored or reactivated record is never listed and a deactivated one never appears: deactivation is
// managed on the record's own page. Super Admin only; the API refuses everyone else.

export type RecycleType = 'AMC_CONTRACT' | 'CLIENT' | 'SYSTEM_TYPE' | 'SALES_ENGINEER'

export interface RecycleBinItem {
  type: RecycleType
  typeLabel: string
  id: string
  reference: string
  name: string
  details: string | null
  status: string | null
  isActive: boolean | null
  deletedAt: string
  deletedBy: { id: string; fullName: string } | null
  contract: { validFrom: string; validTo: string; contractValue: string | null; services: number; invoices: number; documents: number } | null
}

interface RecycleBinList {
  items: RecycleBinItem[]
  total: number
  page: number
  pageSize: number
  counts: Record<RecycleType, number>
  options: { deletedBy: { id: string; fullName: string }[] }
}

interface RecycleCheck {
  type: RecycleType
  id: string
  reference: string
  name: string
  restore: { allowed: boolean; blockers: string[]; warnings: string[] }
  purge: { allowed: boolean; reasons: string[]; confirmText: string | null }
}

const SEGMENTS: Record<RecycleType, string> = {
  AMC_CONTRACT: 'amc-contracts',
  CLIENT: 'clients',
  SYSTEM_TYPE: 'system-types',
  SALES_ENGINEER: 'sales-engineers',
}

const TYPE_TABS: { value: '' | RecycleType; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'AMC_CONTRACT', label: 'AMC contracts' },
  { value: 'CLIENT', label: 'Clients' },
  { value: 'SYSTEM_TYPE', label: 'System types' },
  { value: 'SALES_ENGINEER', label: 'Sales engineers' },
]

const TYPE_TONE: Record<RecycleType, string> = {
  AMC_CONTRACT: 'border-sky-200 bg-sky-50 text-[#0b3b66]',
  CLIENT: 'border-violet-200 bg-violet-50 text-violet-900',
  SYSTEM_TYPE: 'border-teal-200 bg-teal-50 text-teal-900',
  SALES_ENGINEER: 'border-amber-200 bg-amber-50 text-amber-900',
}

/** The type inside a sentence: "Restore AMC contract", "Delete system type permanently". */
const NOUN: Record<RecycleType, string> = {
  AMC_CONTRACT: 'AMC contract',
  CLIENT: 'client',
  SYSTEM_TYPE: 'system type',
  SALES_ENGINEER: 'sales engineer',
}

const PAGE_SIZE = 25
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
const KEY = ['security', 'recycle-bin'] as const

/** What the restored or deleted record returns to: every list that may show it. */
async function refreshAfterChange(queryClient: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    refreshOperationalData(queryClient),
    queryClient.invalidateQueries({ queryKey: ['security'] }),
    queryClient.invalidateQueries({ queryKey: ['clients'] }),
    queryClient.invalidateQueries({ queryKey: ['masters'] }),
  ])
}

function useDebounced(value: string) {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value.trim()), 300)
    return () => clearTimeout(timer)
  }, [value])

  return debounced
}

export function RecycleBin() {
  const queryClient = useQueryClient()
  const [type, setType] = useState<'' | RecycleType>('')
  const [searchInput, setSearchInput] = useState('')
  const search = useDebounced(searchInput)
  const [deletedBy, setDeletedBy] = useState('')
  const [page, setPage] = useState(1)
  const [notice, setNotice] = useState<string | null>(null)
  const [restoring, setRestoring] = useState<RecycleBinItem | null>(null)
  const [purging, setPurging] = useState<RecycleBinItem | null>(null)

  // A filter change starts again at page 1.
  const chooseType = (value: '' | RecycleType) => {
    setType(value)
    setPage(1)
  }

  const list = useQuery({
    queryKey: [...KEY, { type, search, deletedBy, page }],
    queryFn: () => api.get<RecycleBinList>(`/security/recycle-bin${queryString({ type, search, deletedBy, page, pageSize: PAGE_SIZE })}`),
    placeholderData: keepPreviousData,
  })
  const data = list.data
  const total = data ? Object.values(data.counts).reduce((sum, count) => sum + count, 0) : null
  const filtered = search !== '' || deletedBy !== ''

  return (
    <Card className="mb-6 overflow-hidden rounded-2xl">
      <section aria-labelledby="recycle-bin-heading">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 bg-gradient-to-r from-red-50 via-white to-white px-5 py-3">
          <h2 id="recycle-bin-heading" className="text-base font-semibold text-slate-900">
            In the Recycle Bin
            {total !== null && <span className="ml-2 text-sm font-normal text-slate-500">{total}</span>}
          </h2>
          <p className="text-xs text-slate-600">Records deleted now. Nothing in them was removed. Restore brings each back with the same number and links.</p>
        </div>

        <div className="flex flex-wrap items-end gap-3 border-b border-slate-200 bg-slate-50/70 px-5 py-3">
          <div role="tablist" aria-label="Record type" className="flex flex-wrap gap-1.5">
            {TYPE_TABS.map((tab) => {
              const count = tab.value === '' ? total : (data?.counts[tab.value] ?? null)
              const selected = type === tab.value

              return (
                <button
                  key={tab.value || 'all'}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => chooseType(tab.value)}
                  className={cx(
                    'rounded-full border px-3 py-1 text-xs font-semibold shadow-sm',
                    selected ? 'border-[#0b3b66] bg-[#0b3b66] text-white' : 'border-slate-300 bg-white text-slate-700 hover:border-[#1479BD] hover:text-[#0b3b66]',
                  )}
                >
                  {tab.label}
                  {count !== null && <span className={cx('ml-1.5 tabular-nums', selected ? 'text-sky-100' : 'text-slate-500')}>{count}</span>}
                </button>
              )
            })}
          </div>
          <div className="ml-auto grid min-w-0 gap-3 sm:grid-cols-2">
            <Filter label="Search">
              {(id, className) => (
                <input
                  id={id}
                  type="search"
                  value={searchInput}
                  onChange={(event) => {
                    setSearchInput(event.target.value)
                    setPage(1)
                  }}
                  placeholder="Reference, name or details"
                  className={className}
                />
              )}
            </Filter>
            <Filter label="Deleted by">
              {(id, className) => (
                <select
                  id={id}
                  value={deletedBy}
                  onChange={(event) => {
                    setDeletedBy(event.target.value)
                    setPage(1)
                  }}
                  className={className}
                >
                  <option value="">Anyone</option>
                  {(data?.options.deletedBy ?? []).map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.fullName}
                    </option>
                  ))}
                </select>
              )}
            </Filter>
          </div>
        </div>

        {notice && (
          <div role="status" className="border-b border-emerald-200 bg-emerald-50 px-5 py-2.5 text-sm text-emerald-900">
            {notice}
          </div>
        )}
        {list.isPending && <Spinner label="Loading the Recycle Bin" />}
        {list.isError && <LoadError error={list.error} onRetry={() => void list.refetch()} />}
        {data && data.items.length === 0 && (
          <EmptyState
            title={filtered || type ? 'Nothing in the Recycle Bin matches' : 'The Recycle Bin is empty'}
            description={filtered || type ? 'Try another record type or search.' : 'Deactivated records are not here: they stay on their own pages, where they can be switched back on.'}
          />
        )}
        {data && data.items.length > 0 && (
          <>
            <div className={TABLE.wrapper}>
              <table className={cx(TABLE.table, 'table-compact')}>
                <caption className="sr-only">Records in the Recycle Bin</caption>
                <thead>
                  <tr>
                    {['Type', 'Reference', 'Record', 'Kept', 'Deleted', 'Actions'].map((heading) => (
                      <th key={heading} scope="col" className={TABLE.th}>
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.items.map((item) => (
                    <tr key={`${item.type}-${item.id}`} className={TABLE.row}>
                      <td className={TABLE.td}>
                        <span className={cx('inline-flex whitespace-nowrap rounded-md border px-2.5 py-1 text-xs font-semibold', TYPE_TONE[item.type])}>{item.typeLabel}</span>
                      </td>
                      <td className={cx(TABLE.td, 'whitespace-nowrap font-mono text-xs font-bold text-slate-700')}>{item.reference}</td>
                      <td className={TABLE.td}>
                        <span className="block font-semibold text-[#0b3b66]">{item.name}</span>
                        {item.details && <span className="text-xs text-slate-600">{item.details}</span>}
                        {item.contract && (
                          <span className="block text-xs text-slate-500">
                            {formatDate(item.contract.validFrom)} – {formatDate(item.contract.validTo)}
                            {item.status ? ` · ${item.status.charAt(0)}${item.status.slice(1).toLowerCase()}` : ''}
                          </span>
                        )}
                        {item.isActive === false && <span className="mt-1 inline-flex rounded bg-slate-200 px-1.5 py-0.5 text-[11px] font-semibold text-slate-700">Was disabled</span>}
                      </td>
                      <td className={cx(TABLE.td, 'whitespace-nowrap text-xs text-slate-700')}>
                        {item.contract
                          ? `${plural(item.contract.services, 'service')} · ${plural(item.contract.invoices, 'invoice')} · ${plural(item.contract.documents, 'document')}`
                          : 'The full record'}
                      </td>
                      <td className={cx(TABLE.td, 'whitespace-nowrap text-xs text-slate-700')}>
                        <time dateTime={item.deletedAt}>{formatDateTime(item.deletedAt)}</time>
                        <span className="block text-slate-500">{item.deletedBy?.fullName ?? 'Unknown user'}</span>
                      </td>
                      <td className={TABLE.td}>
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" variant="secondary" aria-label={`Restore ${item.typeLabel} ${item.reference} ${item.name}`} onClick={() => setRestoring(item)}>
                            Restore
                          </Button>
                          {item.type !== 'AMC_CONTRACT' && (
                            <Button size="sm" variant="danger" aria-label={`Delete permanently ${item.typeLabel} ${item.reference} ${item.name}`} onClick={() => setPurging(item)}>
                              Delete permanently
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} shown={data.items.length} onPage={setPage} />
          </>
        )}
      </section>

      {restoring && (
        <RestoreDialog
          item={restoring}
          onClose={() => setRestoring(null)}
          onDone={async (message) => {
            setRestoring(null)
            await refreshAfterChange(queryClient)
            setNotice(message)
          }}
        />
      )}
      {purging && (
        <PurgeDialog
          item={purging}
          onClose={() => setPurging(null)}
          onDone={async (message) => {
            setPurging(null)
            await refreshAfterChange(queryClient)
            setNotice(message)
          }}
        />
      )}
    </Card>
  )
}

/** The check for one record, read when its dialog opens so the answer is current. */
function useCheck(item: RecycleBinItem) {
  return useQuery({
    queryKey: [...KEY, 'check', item.type, item.id],
    queryFn: () => api.get<RecycleCheck>(`/security/recycle-bin/${SEGMENTS[item.type]}/${item.id}/check`),
    staleTime: 0,
    gcTime: 0,
  })
}

function Reasons({ title, items, tone }: { title: string; items: string[]; tone: 'error' | 'info' }) {
  if (items.length === 0) return null

  return (
    <Alert tone={tone}>
      <p className="font-semibold">{title}</p>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        {items.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
    </Alert>
  )
}

function RestoreDialog({ item, onClose, onDone }: { item: RecycleBinItem; onClose: () => void; onDone: (message: string) => Promise<void> }) {
  const check = useCheck(item)
  const restore = useMutation({
    mutationFn: () => api.post(`/security/recycle-bin/${SEGMENTS[item.type]}/${item.id}/restore`),
    onSuccess: () => onDone(`${item.typeLabel} ${item.reference} (${item.name}) was restored.`),
  })
  const allowed = check.data?.restore.allowed === true

  return (
    <Modal
      title={`Restore ${NOUN[item.type]}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={restore.isPending}>
            Cancel
          </Button>
          <Button onClick={() => restore.mutate()} loading={restore.isPending} disabled={!allowed}>
            Restore
          </Button>
        </>
      }
    >
      <div className="space-y-3 break-words text-sm text-slate-700">
        <p>
          Restore <strong>{item.reference}</strong> — <strong>{item.name}</strong>
          {item.details ? ` (${item.details})` : ''}?
        </p>
        <p className="text-xs text-slate-600">
          {item.type === 'AMC_CONTRACT'
            ? 'It returns to AMC Contracts, schedules, the calendar, Accounts and the dashboard figures with the same number, services and history.'
            : 'It returns to its list with the same id, code and links, and can be chosen again for new records.'}
        </p>
        {check.isPending && <Spinner label="Checking the record" size="sm" />}
        {check.isError && <Alert>{errorMessage(check.error)}</Alert>}
        {check.data && <Reasons title="It cannot be restored yet" items={check.data.restore.blockers} tone="error" />}
        {check.data && <Reasons title="Restoring keeps these as they are" items={check.data.restore.warnings} tone="info" />}
        {restore.isError && <Alert>{errorMessage(restore.error)}</Alert>}
      </div>
    </Modal>
  )
}

function PurgeDialog({ item, onClose, onDone }: { item: RecycleBinItem; onClose: () => void; onDone: (message: string) => Promise<void> }) {
  const check = useCheck(item)
  const [typed, setTyped] = useState('')
  const purge = useMutation({
    mutationFn: () => api.delete(`/security/recycle-bin/${SEGMENTS[item.type]}/${item.id}`, { confirm: typed }),
    onSuccess: () => onDone(`${item.typeLabel} ${item.reference} (${item.name}) was deleted permanently.`),
  })
  const confirmText = check.data?.purge.confirmText ?? null
  const matches = confirmText !== null && typed.trim().toLowerCase() === confirmText.toLowerCase()

  return (
    <Modal
      title={`Delete ${NOUN[item.type]} permanently`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={purge.isPending}>
            {check.data && !check.data.purge.allowed ? 'Keep in Recycle Bin' : 'Cancel'}
          </Button>
          {check.data?.purge.allowed && (
            <Button variant="danger" onClick={() => purge.mutate()} loading={purge.isPending} disabled={!matches}>
              Delete permanently
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3 break-words text-sm text-slate-700">
        <p>
          <strong>{item.reference}</strong> — <strong>{item.name}</strong>
        </p>
        {check.isPending && <Spinner label="Checking whether it was ever used" size="sm" />}
        {check.isError && <Alert>{errorMessage(check.error)}</Alert>}
        {check.data && !check.data.purge.allowed && (
          <>
            <Reasons title="It cannot be deleted permanently, because it may have been used" items={check.data.purge.reasons} tone="error" />
            <p className="text-xs text-slate-600">It stays in the Recycle Bin, where it can be restored at any time.</p>
          </>
        )}
        {check.data?.purge.allowed && confirmText && (
          <>
            <Alert>
              This cannot be undone. The record is removed from the database; the Audit Log keeps a copy of what it was.
              {item.type === 'SALES_ENGINEER' ? ' The engineer code is retired and can never be used again.' : ''}
            </Alert>
            <TextField
              label={`Type ${confirmText} to confirm`}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
            />
          </>
        )}
        {purge.isError && <Alert>{errorMessage(purge.error)}</Alert>}
      </div>
    </Modal>
  )
}

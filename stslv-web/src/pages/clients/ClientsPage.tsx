import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { useAuth } from '../../auth/context'
import { ExportButtons } from '../../components/ExportButtons'
import { Pager } from '../../components/records'
import { Alert, Button, EmptyState, PageHeader, Spinner, TableScroll } from '../../components/ui'
import { TABLE } from '../../components/table'
import { api, errorMessage } from '../../lib/api'
import { formatDate } from '../../lib/format'
import { Link } from 'react-router-dom'
import { CLIENT_STATUS_LABELS, CLIENT_TYPE_LABELS, type Client, type ClientFeatures, type Paged } from '../../lib/types'
import { ClientAvatar } from './clientAvatar'
import { ClientDetailsModal } from './ClientDetailsModal'
import { ClientFormModal } from './ClientFormModal'
import { ClientStatusBadge } from './ClientStatusBadge'
import { ColumnsMenu, type ColumnOption } from './ColumnsMenu'

type StatusFilter = 'active' | 'inactive' | 'all'

// The list's sort choices, as the API's sort and direction.
const SORTS: Record<string, { label: string; sort: string; direction: 'asc' | 'desc' }> = {
  'name-asc': { label: 'Name (A–Z)', sort: 'name', direction: 'asc' },
  'name-desc': { label: 'Name (Z–A)', sort: 'name', direction: 'desc' },
  'created-desc': { label: 'Newest first', sort: 'createdAt', direction: 'desc' },
  'created-asc': { label: 'Oldest first', sort: 'createdAt', direction: 'asc' },
  'updated-desc': { label: 'Recently updated', sort: 'updatedAt', direction: 'desc' },
}

const PAGE_SIZE = 25

type Dialog = { kind: 'none' } | { kind: 'create' } | { kind: 'edit'; client: Client } | { kind: 'view'; clientId: string }

// The columns a user may hide. Client name always shows, so every row stays identifiable.
type ColumnKey = 'code' | 'type' | 'vat' | 'contact' | 'phone' | 'status'
const COLUMN_OPTIONS: ColumnOption<ColumnKey>[] = [
  { key: 'code', label: 'Client code' },
  { key: 'type', label: 'Client type' },
  { key: 'vat', label: 'VAT number' },
  { key: 'contact', label: 'Contact person' },
  { key: 'phone', label: 'Phone' },
  { key: 'status', label: 'Status' },
]
// Type and VAT number need migration 0074; without it they are not offered.
const DETAIL_COLUMNS: ReadonlySet<ColumnKey> = new Set(['type', 'vat'])

// The hidden columns, remembered in this browser only. Storage may be blocked; the choice then lasts for this visit.
const COLUMNS_KEY = 'stslev.clients.hidden-columns'

function readHiddenColumns(): Set<ColumnKey> {
  try {
    const stored = JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? '[]') as unknown
    const known = new Set<string>(COLUMN_OPTIONS.map((option) => option.key))

    return new Set(Array.isArray(stored) ? stored.filter((key): key is ColumnKey => typeof key === 'string' && known.has(key)) : [])
  } catch {
    return new Set()
  }
}

function saveHiddenColumns(hidden: Set<ColumnKey>) {
  try {
    localStorage.setItem(COLUMNS_KEY, JSON.stringify([...hidden]))
  } catch {
    // Not remembered; the choice still applies on this page.
  }
}

const ICONS = {
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" strokeLinecap="round" />
    </>
  ),
  phone: <path d="M6.5 4h3l1.5 4-2 1.2a11 11 0 0 0 5.8 5.8L16 13l4 1.5v3a2 2 0 0 1-2.2 2A15.5 15.5 0 0 1 4.5 6.2 2 2 0 0 1 6.5 4Z" strokeLinejoin="round" />,
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="m4 7 8 6 8-6" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  edit: <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3ZM14 8l3 3" strokeLinecap="round" strokeLinejoin="round" />,
}

function Icon({ name, className = 'h-4 w-4' }: { name: keyof typeof ICONS; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      {ICONS[name]}
    </svg>
  )
}

const FIELD = 'rounded-lg border border-slate-300 bg-white text-sm shadow-sm transition focus:border-[#1479BD] focus:outline-none focus:ring-4 focus:ring-sky-200/60'
const ICON_BUTTON =
  'inline-flex h-8 w-9 items-center justify-center text-slate-500 transition-colors hover:bg-sky-50 hover:text-[#1479BD] focus-visible:relative focus-visible:z-10'
const LABEL = 'mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-600'
const NONE = <span className="text-slate-400">—</span>

/** A small square button with an icon only. The accessible name is given by aria-label; title shows it on hover. */
function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={ICON_BUTTON}>
      {children}
    </button>
  )
}

type StatusValue = 'active' | 'inactive'

/**
 * The status of one row as a select. Choosing a different status does nothing
 * by itself: Apply saves it, Cancel puts the select back.
 */
function StatusCell({ client, busy, onApply }: { client: Client; busy: boolean; onApply: (client: Client) => void }) {
  // The list keys this cell by the stored status, so a saved change starts it afresh.
  const current: StatusValue = client.isActive ? 'active' : 'inactive'
  const [chosen, setChosen] = useState<StatusValue>(current)
  const changed = chosen !== current

  return (
    <div className="flex items-center gap-1.5">
      <select
        aria-label={`Status of ${client.name}`}
        value={chosen}
        disabled={busy}
        onChange={(event) => setChosen(event.target.value as StatusValue)}
        className={`rounded-lg border px-2 py-1.5 text-xs font-semibold shadow-sm focus:border-[#1479BD] focus:outline-none focus:ring-4 focus:ring-sky-200/60 ${
          chosen === 'active' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-slate-300 bg-slate-100 text-slate-700'
        }`}
      >
        <option value="active">{CLIENT_STATUS_LABELS.active}</option>
        <option value="inactive">{CLIENT_STATUS_LABELS.inactive}</option>
      </select>
      {changed && (
        <>
          <Button size="sm" loading={busy} onClick={() => onApply(client)} aria-label={`Apply ${CLIENT_STATUS_LABELS[chosen]} to ${client.name}`}>
            Apply
          </Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => setChosen(current)} aria-label={`Keep ${client.name} ${CLIENT_STATUS_LABELS[current]}`}>
            Cancel
          </Button>
        </>
      )}
    </div>
  )
}

export function ClientsPage() {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const searchId = useId()
  const statusId = useId()
  const typeId = useId()
  const sortId = useId()

  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<StatusFilter>('active')
  const [clientType, setClientType] = useState('')
  const [sortKey, setSortKey] = useState('name-asc')
  const [page, setPage] = useState(1)
  // Client type and VAT number need migration 0074; without it they are not shown.
  const features = useQuery({ queryKey: ['clients', 'features'], queryFn: () => api.get<ClientFeatures>('/clients/features'), staleTime: 60_000 })
  const withDetails = features.data?.clientDetails === true
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' })
  const [notice, setNotice] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [hiddenColumns, setHiddenColumns] = useState<Set<ColumnKey>>(readHiddenColumns)
  const columnOptions = COLUMN_OPTIONS.filter((option) => withDetails || !DETAIL_COLUMNS.has(option.key))
  const show = (key: ColumnKey) => !hiddenColumns.has(key) && (withDetails || !DETAIL_COLUMNS.has(key))

  // Wait for a pause in typing before searching.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 300)

    return () => clearTimeout(timer)
  }, [searchInput])

  const order = SORTS[sortKey] ?? { sort: 'name', direction: 'asc' as const }

  // The list's filters and order, shared by the list and its export.
  const filterParams = () => {
    const params = new URLSearchParams({ status, sort: order.sort, direction: order.direction })
    if (search) {
      params.set('search', search)
    }
    if (clientType) {
      params.set('clientType', clientType)
    }
    return params
  }

  const clients = useQuery({
    queryKey: ['clients', 'list', { search, status, clientType, sortKey, page }],
    queryFn: () => {
      const params = filterParams()
      params.set('page', String(page))
      params.set('pageSize', String(PAGE_SIZE))
      return api.get<Paged<Client>>(`/clients?${params.toString()}`)
    },
    placeholderData: keepPreviousData,
  })

  // Applies the status chosen in a row. The only change a row can ask for is the opposite of the stored status.
  const toggle = useMutation({
    mutationFn: (client: Client) => api.post<Client>(`/clients/${client.id}/${client.isActive ? 'deactivate' : 'reactivate'}`),
    onMutate: () => setNotice(null),
    onSuccess: async (updated) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['clients'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['masters'] }),
      ])
      setNotice(`${updated.name} is now ${CLIENT_STATUS_LABELS[updated.isActive ? 'active' : 'inactive']}.`)
    },
  })

  const closeDialog = () => setDialog({ kind: 'none' })

  const canCreate = auth.can('CLIENTS', 'CREATE')
  const canEdit = auth.can('CLIENTS', 'EDIT')
  // Clients are never deleted: the DELETE permission governs disabling and re-enabling.
  const canChangeStatus = auth.can('CLIENTS', 'DELETE')
  const canExport = auth.can('CLIENTS', 'EXPORT')

  const data = clients.data
  const filtered = search !== '' || status !== 'active' || clientType !== ''

  return (
    <>
      <PageHeader
        title="Clients"
        description="The client master used by AMC contracts and invoices."
        actions={canCreate && <Button onClick={() => setDialog({ kind: 'create' })}>Add Client</Button>}
      />

      {notice && (
        <div className="mb-4">
          <Alert tone="success" onDismiss={() => setNotice(null)}>
            {notice}
          </Alert>
        </div>
      )}
      {toggle.isError && (
        <div className="mb-4">
          <Alert onDismiss={() => toggle.reset()}>{errorMessage(toggle.error)}</Alert>
        </div>
      )}
      {exportError && (
        <div className="mb-4">
          <Alert onDismiss={() => setExportError(null)}>{exportError}</Alert>
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 bg-gradient-to-r from-sky-50 via-white to-white">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pt-4 sm:px-5">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <h2 className="text-base font-semibold text-slate-900">Client directory</h2>
              <p className="text-sm text-slate-500" aria-live="polite">
                {data ? (
                  <>
                    <span className="font-semibold tabular-nums text-slate-800">{data.total}</span> {filtered ? 'matching ' : ''}
                    {data.total === 1 ? 'client' : 'clients'}
                  </>
                ) : (
                  'Loading…'
                )}
              </p>
            </div>
            {canExport && <ExportButtons what="clients" fileStem="clients" size="sm" path={(format) => `/clients/export?${filterParams().toString()}&format=${format}`} onError={setExportError} />}
          </div>
          <div className="flex flex-wrap items-end gap-4 p-4 sm:p-5">
            <div className="min-w-56 flex-1">
              <label htmlFor={searchId} className={LABEL}>
                Search
              </label>
              <div className="relative">
                <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-slate-400" />
                <input
                  id={searchId}
                  type="search"
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  placeholder={withDetails ? 'Name, code, VAT, phone, email or contact' : 'Name, code, phone, email or contact'}
                  className={`block w-full py-2.5 pl-10 pr-3 placeholder:text-slate-500 ${FIELD}`}
                />
              </div>
            </div>
            <div>
              <label htmlFor={statusId} className={LABEL}>
                Status
              </label>
              <select
                id={statusId}
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value as StatusFilter)
                  setPage(1)
                }}
                className={`block px-3 py-2.5 ${FIELD}`}
              >
                <option value="active">{CLIENT_STATUS_LABELS.active}</option>
                <option value="inactive">{CLIENT_STATUS_LABELS.inactive}</option>
                <option value="all">All</option>
              </select>
            </div>
            {withDetails && (
              <div>
                <label htmlFor={typeId} className={LABEL}>
                  Type
                </label>
                <select
                  id={typeId}
                  value={clientType}
                  onChange={(event) => {
                    setClientType(event.target.value)
                    setPage(1)
                  }}
                  className={`block px-3 py-2.5 ${FIELD}`}
                >
                  <option value="">All types</option>
                  <option value="COMPANY">{CLIENT_TYPE_LABELS.COMPANY}</option>
                  <option value="INDIVIDUAL">{CLIENT_TYPE_LABELS.INDIVIDUAL}</option>
                </select>
              </div>
            )}
            <div>
              <label htmlFor={sortId} className={LABEL}>
                Sort
              </label>
              <select
                id={sortId}
                value={sortKey}
                onChange={(event) => {
                  setSortKey(event.target.value)
                  setPage(1)
                }}
                className={`block px-3 py-2.5 ${FIELD}`}
              >
                {Object.entries(SORTS).map(([key, option]) => (
                  <option key={key} value={key}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:ml-auto">
              <ColumnsMenu
                options={columnOptions}
                hidden={hiddenColumns}
                onChange={(next) => {
                  setHiddenColumns(next)
                  saveHiddenColumns(next)
                }}
              />
            </div>
          </div>
        </div>

        {clients.isPending && <Spinner label="Loading clients" />}

        {clients.isError && (
          <div className="p-4">
            <Alert>
              {errorMessage(clients.error)}{' '}
              <button type="button" className="font-medium underline" onClick={() => void clients.refetch()}>
                Try again
              </button>
            </Alert>
          </div>
        )}

        {data && data.items.length === 0 && (
          <EmptyState
            title={filtered ? 'No clients match your search' : 'No clients yet'}
            description={filtered ? 'Try a different search or status filter.' : 'Clients you add here can be selected on AMC contracts.'}
            action={!filtered && canCreate ? <Button onClick={() => setDialog({ kind: 'create' })}>Add Client</Button> : undefined}
          />
        )}

        {data && data.items.length > 0 && (
          <>
            <TableScroll label="Clients">
              <table className={TABLE.table}>
                <caption className="sr-only">Clients</caption>
                <thead>
                  <tr>
                    <th scope="col" className={TABLE.snHead}>
                      #
                    </th>
                    {show('code') && (
                      <th scope="col" className={TABLE.th}>
                        Code
                      </th>
                    )}
                    <th scope="col" className={TABLE.th}>
                      Client name
                    </th>
                    {show('type') && (
                      <th scope="col" className={TABLE.th}>
                        Type
                      </th>
                    )}
                    {show('vat') && (
                      <th scope="col" className={TABLE.th}>
                        VAT number
                      </th>
                    )}
                    {show('contact') && (
                      <th scope="col" className={TABLE.th}>
                        Contact person
                      </th>
                    )}
                    {show('phone') && (
                      <th scope="col" className={TABLE.th}>
                        Phone
                      </th>
                    )}
                    {show('status') && (
                      <th scope="col" className={TABLE.th}>
                        Status
                      </th>
                    )}
                    <th scope="col" className={`${TABLE.th} pr-5 text-right`}>
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.items.map((client, index) => (
                    <tr key={client.id} className={`${TABLE.row} hover:shadow-[inset_3px_0_0_#1479BD]`}>
                      <td className={TABLE.sn}>{(data.page - 1) * data.pageSize + index + 1}</td>
                      {show('code') && <td className={`${TABLE.td} whitespace-nowrap font-mono text-xs font-semibold text-slate-600`}>{client.code}</td>}
                      <td className={`${TABLE.td} min-w-56 py-3`}>
                        <div className="flex items-center gap-3.5">
                          <ClientAvatar name={client.name} />
                          <div className="min-w-0">
                            <Link
                              to={`/clients/${client.id}`}
                              className={`block max-w-64 break-words text-sm font-semibold leading-snug hover:text-[#1479BD] hover:underline ${client.isActive ? 'text-slate-900' : 'text-slate-500'}`}
                            >
                              {client.name}
                            </Link>
                            <span className="mt-0.5 block text-xs text-slate-500">Added {formatDate(client.createdAt.slice(0, 10))}</span>
                          </div>
                        </div>
                      </td>
                      {show('type') && <td className={`${TABLE.td} whitespace-nowrap`}>{client.clientType ? CLIENT_TYPE_LABELS[client.clientType] : NONE}</td>}
                      {show('vat') && <td className={`${TABLE.td} whitespace-nowrap font-mono text-xs`}>{client.vatNumber ?? NONE}</td>}
                      {show('contact') && (
                        <td className={`${TABLE.td} ${TABLE.text}`}>
                          {client.contactPerson && <span className="block text-sm font-medium text-slate-900">{client.contactPerson}</span>}
                          {client.email && (
                            <a
                              href={`mailto:${client.email}`}
                              className="mt-0.5 inline-flex max-w-full items-center gap-1 text-xs text-slate-500 [overflow-wrap:anywhere] hover:text-[#1479BD] hover:underline"
                            >
                              <Icon name="mail" className="h-3.5 w-3.5 shrink-0" />
                              {client.email}
                            </a>
                          )}
                          {!client.contactPerson && !client.email && NONE}
                        </td>
                      )}
                      {show('phone') && (
                        <td className={`${TABLE.td} whitespace-nowrap`}>
                          {client.phone ? (
                            <a
                              href={`tel:${client.phone.replace(/[^+\d]/g, '')}`}
                              className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-sky-100 hover:text-[#0b3b66]"
                            >
                              <Icon name="phone" className="h-3.5 w-3.5 shrink-0 text-[#1479BD]" />
                              {client.phone}
                            </a>
                          ) : (
                            NONE
                          )}
                        </td>
                      )}
                      {show('status') && (
                        <td className={`${TABLE.td} whitespace-nowrap`}>
                          {canChangeStatus ? (
                            <StatusCell key={`${client.id}-${client.isActive}`} client={client} busy={toggle.isPending && toggle.variables?.id === client.id} onApply={(target) => toggle.mutate(target)} />
                          ) : (
                            <ClientStatusBadge active={client.isActive} />
                          )}
                        </td>
                      )}
                      <td className={`${TABLE.td} whitespace-nowrap pr-5 text-right`}>
                        <div className="inline-flex items-center divide-x divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
                          <IconButton label={`View ${client.name}`} onClick={() => setDialog({ kind: 'view', clientId: client.id })}>
                            <Icon name="eye" className="h-[18px] w-[18px]" />
                          </IconButton>
                          {canEdit && (
                            <IconButton label={`Edit ${client.name}`} onClick={() => setDialog({ kind: 'edit', client })}>
                              <Icon name="edit" className="h-[18px] w-[18px]" />
                            </IconButton>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>

            <Pager page={data.page} pageSize={data.pageSize} shown={data.items.length} total={data.total} onPage={setPage} />
          </>
        )}
      </div>

      {(dialog.kind === 'create' || dialog.kind === 'edit') && (
        <ClientFormModal
          client={dialog.kind === 'edit' ? dialog.client : null}
          onClose={closeDialog}
          onSaved={(saved) => {
            setNotice(dialog.kind === 'edit' ? `${saved.name} was updated.` : `${saved.name} was added.`)
            setDialog({ kind: 'none' })
          }}
        />
      )}

      {dialog.kind === 'view' && (
        <ClientDetailsModal clientId={dialog.clientId} canEdit={canEdit} onEdit={(client) => setDialog({ kind: 'edit', client })} onClose={closeDialog} />
      )}
    </>
  )
}

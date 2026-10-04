import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { useAuth } from '../../auth/context'
import { Pager } from '../../components/records'
import { Alert, Button, ConfirmDialog, EmptyState, PageHeader, Spinner, StatusBadge, TableScroll } from '../../components/ui'
import { TABLE } from '../../components/table'
import { api, errorMessage } from '../../lib/api'
import { formatDate } from '../../lib/format'
import type { Client, Paged } from '../../lib/types'
import { ClientAvatar } from './clientAvatar'
import { ClientDetailsModal } from './ClientDetailsModal'
import { ClientFormModal } from './ClientFormModal'

type StatusFilter = 'active' | 'inactive' | 'all'

const PAGE_SIZE = 25

type Dialog =
  | { kind: 'none' }
  | { kind: 'create' }
  | { kind: 'edit'; client: Client }
  | { kind: 'view'; clientId: string }
  | { kind: 'toggle'; client: Client }

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
  stop: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m6 6 12 12" strokeLinecap="round" />
    </>
  ),
  restore: <path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4" strokeLinecap="round" strokeLinejoin="round" />,
  users: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 19c0-3.2 2.7-5 6-5s6 1.8 6 5" strokeLinecap="round" />
      <path d="M16 5.2a3 3 0 0 1 0 5.6M18.5 14.4c1.6.7 2.5 2.1 2.5 4.6" strokeLinecap="round" />
    </>
  ),
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

/** A small square button with an icon only. The accessible name is given by aria-label; title shows it on hover. */
function IconButton({ label, onClick, danger = false, children }: { label: string; onClick: () => void; danger?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`${ICON_BUTTON} ${danger ? 'hover:!bg-red-50 hover:!text-red-700' : ''}`}
    >
      {children}
    </button>
  )
}

export function ClientsPage() {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const searchId = useId()
  const statusId = useId()

  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<StatusFilter>('active')
  const [page, setPage] = useState(1)
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' })
  const [notice, setNotice] = useState<string | null>(null)

  // Wait for a pause in typing before searching.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 300)

    return () => clearTimeout(timer)
  }, [searchInput])

  const clients = useQuery({
    queryKey: ['clients', 'list', { search, status, page }],
    queryFn: () => {
      const params = new URLSearchParams({ status, page: String(page), pageSize: String(PAGE_SIZE) })
      if (search) {
        params.set('search', search)
      }
      return api.get<Paged<Client>>(`/clients?${params.toString()}`)
    },
    placeholderData: keepPreviousData,
  })

  const toggle = useMutation({
    mutationFn: (client: Client) => api.post<Client>(`/clients/${client.id}/${client.isActive ? 'deactivate' : 'reactivate'}`),
    onSuccess: async (updated) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['clients'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ])
      setNotice(`${updated.name} was ${updated.isActive ? 'reactivated' : 'deactivated'}.`)
      setDialog({ kind: 'none' })
    },
  })

  const closeDialog = () => {
    toggle.reset()
    setDialog({ kind: 'none' })
  }

  const canCreate = auth.can('CLIENTS', 'CREATE')
  const canEdit = auth.can('CLIENTS', 'EDIT')
  const canDeactivate = auth.can('CLIENTS', 'DELETE')

  const data = clients.data
  const filtered = search !== '' || status !== 'active'

  return (
    <>
      <PageHeader
        title="Clients"
        description="The client master used by AMC contracts and projects."
        actions={canCreate && <Button onClick={() => setDialog({ kind: 'create' })}>Add Client</Button>}
      />

      {notice && (
        <div className="mb-4">
          <Alert tone="success" onDismiss={() => setNotice(null)}>
            {notice}
          </Alert>
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 bg-gradient-to-r from-sky-50 via-white to-white">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 pt-4 sm:px-5">
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
          <div className="flex flex-wrap items-end gap-4 p-4 sm:p-5">
          <div className="min-w-56 flex-1">
            <label htmlFor={searchId} className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-600">
              Search
            </label>
            <div className="relative">
              <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-slate-400" />
              <input
                id={searchId}
                type="search"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Name, contact person, email or phone"
                className={`block w-full py-2.5 pl-10 pr-3 placeholder:text-slate-500 ${FIELD}`}
              />
            </div>
          </div>
          <div>
            <label htmlFor={statusId} className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-600">
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
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="all">All</option>
            </select>
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
            description={
              filtered
                ? 'Try a different search or status filter.'
                : 'Clients you add here can be selected on AMC contracts and projects.'
            }
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
                    <th scope="col" className={`${TABLE.th} pl-5`}>
                      Client
                    </th>
                    <th scope="col" className={TABLE.th}>
                      Contact details
                    </th>
                    <th scope="col" className={TABLE.th}>
                      Status
                    </th>
                    <th scope="col" className={`${TABLE.th} pr-5 text-right`}>
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.items.map((client, index) => (
                    <tr key={client.id} className={`${TABLE.row} hover:shadow-[inset_3px_0_0_#1479BD]`}>
                      <td className={TABLE.sn}>{(data.page - 1) * data.pageSize + index + 1}</td>
                      <td className={`${TABLE.td} min-w-56 py-3 pl-5`}>
                        <div className="flex items-center gap-3.5">
                          <ClientAvatar name={client.name} />
                          <div className="min-w-0">
                            <span className={`block max-w-64 break-words text-sm font-semibold leading-snug ${client.isActive ? 'text-slate-900' : 'text-slate-500'}`}>{client.name}</span>
                            <span className="mt-0.5 block text-xs text-slate-500">Added {formatDate(client.createdAt.slice(0, 10))}</span>
                          </div>
                        </div>
                      </td>
                      {/* Person, phone and email in one cell, as small pills. A client with none of them offers to add them. */}
                      <td className={`${TABLE.td} min-w-52 py-3`}>
                        {client.contactPerson || client.phone || client.email ? (
                          <div className="space-y-1.5">
                            {client.contactPerson && <span className="block text-sm font-medium text-slate-900">{client.contactPerson}</span>}
                            <div className="flex flex-wrap gap-1.5">
                              {client.phone && (
                                <a
                                  href={`tel:${client.phone.replace(/[^+\d]/g, '')}`}
                                  className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-sky-100 hover:text-[#0b3b66]"
                                >
                                  <Icon name="phone" className="h-3.5 w-3.5 shrink-0 text-[#1479BD]" />
                                  {client.phone}
                                </a>
                              )}
                              {client.email && (
                                <a
                                  href={`mailto:${client.email}`}
                                  className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors [overflow-wrap:anywhere] hover:bg-sky-100 hover:text-[#0b3b66]"
                                >
                                  <Icon name="mail" className="h-3.5 w-3.5 shrink-0 text-[#1479BD]" />
                                  {client.email}
                                </a>
                              )}
                            </div>
                          </div>
                        ) : canEdit ? (
                          <button
                            type="button"
                            onClick={() => setDialog({ kind: 'edit', client })}
                            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-500 transition-colors hover:border-[#1479BD] hover:bg-sky-50 hover:text-[#1479BD]"
                          >
                            <Icon name="edit" className="h-3.5 w-3.5" />
                            Add contact details
                          </button>
                        ) : (
                          <span className="text-xs italic text-slate-400">No contact details added</span>
                        )}
                      </td>
                      <td className={TABLE.td}>
                        <StatusBadge active={client.isActive} />
                      </td>
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
                          {canDeactivate && (
                            <IconButton
                              label={`${client.isActive ? 'Deactivate' : 'Reactivate'} ${client.name}`}
                              danger={client.isActive}
                              onClick={() => setDialog({ kind: 'toggle', client })}
                            >
                              <Icon name={client.isActive ? 'stop' : 'restore'} className="h-[18px] w-[18px]" />
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
        <ClientDetailsModal
          clientId={dialog.clientId}
          canEdit={canEdit}
          onEdit={(client) => setDialog({ kind: 'edit', client })}
          onClose={closeDialog}
        />
      )}

      {dialog.kind === 'toggle' && (
        <ConfirmDialog
          title={dialog.client.isActive ? 'Deactivate client' : 'Reactivate client'}
          message={
            dialog.client.isActive ? (
              <>
                Deactivate <strong>{dialog.client.name}</strong>? The client is kept on existing records but can no longer be
                selected for new work. You can reactivate it later.
              </>
            ) : (
              <>
                Reactivate <strong>{dialog.client.name}</strong>? The client becomes selectable again.
              </>
            )
          }
          confirmLabel={dialog.client.isActive ? 'Deactivate' : 'Reactivate'}
          danger={dialog.client.isActive}
          loading={toggle.isPending}
          error={toggle.isError ? errorMessage(toggle.error) : null}
          onConfirm={() => toggle.mutate(dialog.client)}
          onCancel={closeDialog}
        />
      )}
    </>
  )
}

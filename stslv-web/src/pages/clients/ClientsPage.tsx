import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useState } from 'react'
import { useAuth } from '../../auth/context'
import { Alert, Button, Card, ConfirmDialog, EmptyState, PageHeader, Spinner, StatusBadge, TableScroll } from '../../components/ui'
import { TABLE } from '../../components/table'
import { api, errorMessage } from '../../lib/api'
import type { Client, Paged } from '../../lib/types'
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
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1
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

      <Card>
        <div className="flex flex-wrap items-end gap-4 border-b border-slate-200 p-4">
          <div className="min-w-56 flex-1">
            <label htmlFor={searchId} className="mb-1 block text-sm font-medium text-slate-700">
              Search
            </label>
            <input
              id={searchId}
              type="search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Name, contact person, email or phone"
              className="block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm placeholder:text-slate-500"
            />
          </div>
          <div>
            <label htmlFor={statusId} className="mb-1 block text-sm font-medium text-slate-700">
              Status
            </label>
            <select
              id={statusId}
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as StatusFilter)
                setPage(1)
              }}
              className="block rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="all">All</option>
            </select>
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
                    <th scope="col" className={TABLE.th}>
                      Client name
                    </th>
                    <th scope="col" className={TABLE.th}>
                      Contact person
                    </th>
                    <th scope="col" className={TABLE.th}>
                      Phone
                    </th>
                    <th scope="col" className={TABLE.th}>
                      Email
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
                  {data.items.map((client) => (
                    <tr key={client.id} className={TABLE.row}>
                      <td className={`${TABLE.td} ${TABLE.text} font-medium text-slate-900`}>{client.name}</td>
                      <td className={`${TABLE.td} min-w-28 max-w-48 break-words`}>{client.contactPerson ?? '—'}</td>
                      <td className={`${TABLE.td} whitespace-nowrap`}>{client.phone ?? '—'}</td>
                      <td className={`${TABLE.td} ${TABLE.unbroken}`}>{client.email ?? '—'}</td>
                      <td className={TABLE.td}>
                        <StatusBadge active={client.isActive} />
                      </td>
                      <td className={`${TABLE.td} whitespace-nowrap text-right`}>
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`View ${client.name}`}
                            onClick={() => setDialog({ kind: 'view', clientId: client.id })}
                          >
                            View
                          </Button>
                          {canEdit && (
                            <Button variant="ghost" size="sm" aria-label={`Edit ${client.name}`} onClick={() => setDialog({ kind: 'edit', client })}>
                              Edit
                            </Button>
                          )}
                          {canDeactivate && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className={client.isActive ? 'text-red-700 hover:bg-red-50' : undefined}
                              aria-label={`${client.isActive ? 'Deactivate' : 'Reactivate'} ${client.name}`}
                              onClick={() => setDialog({ kind: 'toggle', client })}
                            >
                              {client.isActive ? 'Deactivate' : 'Reactivate'}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-sm text-slate-600">
              <p>
                Showing {(data.page - 1) * data.pageSize + 1}–{(data.page - 1) * data.pageSize + data.items.length} of {data.total}
              </p>
              {totalPages > 1 && (
                <div className="flex items-center gap-2">
                  <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                    Previous
                  </Button>
                  <span>
                    Page {data.page} of {totalPages}
                  </span>
                  <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
                    Next
                  </Button>
                </div>
              )}
            </div>
          </>
        )}
      </Card>

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

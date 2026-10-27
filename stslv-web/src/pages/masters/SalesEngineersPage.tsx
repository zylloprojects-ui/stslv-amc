import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/context'
import { ActionButton, ActionGroup, ActionLink } from '../../components/IconActions'
import { LoadError, Pager } from '../../components/records'
import { TABLE } from '../../components/table'
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, PageHeader, Spinner } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { queryString } from '../amc/amcApi'
import { Filter } from '../amc/components'
import { MasterFormModal, type AnyRecord } from './MasterDataPage'
import { isFeatureUnavailable, type MasterList, type SalesEngineer } from './masterTypes'

const PAGE_SIZE = 25

const SORTS: Record<string, { label: string; sort: string; direction: 'asc' | 'desc' }> = {
  'name-asc': { label: 'Name (A–Z)', sort: 'name', direction: 'asc' },
  'name-desc': { label: 'Name (Z–A)', sort: 'name', direction: 'desc' },
  'employee-asc': { label: 'Employee no.', sort: 'employeeNo', direction: 'asc' },
  'department-asc': { label: 'Department', sort: 'department', direction: 'asc' },
  'created-desc': { label: 'Newest first', sort: 'createdAt', direction: 'desc' },
}

/** Master Data Center → Sales Engineers: search, filter, sort, page; add, view, edit, deactivate (never delete). */
export function SalesEngineersPage() {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('active')
  const [sortKey, setSortKey] = useState('name-asc')
  const [page, setPage] = useState(1)
  const [editing, setEditing] = useState<{ record: SalesEngineer | null } | null>(null)
  const [toggling, setToggling] = useState<SalesEngineer | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 300)

    return () => clearTimeout(timer)
  }, [searchInput])

  const order = SORTS[sortKey] ?? { sort: 'name', direction: 'asc' as const }
  const list = useQuery({
    queryKey: ['masters', 'sales-engineers', { search, status, sortKey, page }],
    queryFn: () =>
      api.get<MasterList<SalesEngineer>>(`/masters/sales-engineers${queryString({ search, status, sort: order.sort, direction: order.direction, page, pageSize: PAGE_SIZE })}`),
    placeholderData: keepPreviousData,
    retry: false,
  })
  const toggle = useMutation({
    mutationFn: (engineer: SalesEngineer) => api.post<SalesEngineer>(`/masters/sales-engineers/${engineer.id}/status`, { isActive: !engineer.isActive }),
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ['masters'] })
      setNotice(`${saved.name} is now ${saved.isActive ? 'active' : 'inactive'}.`)
      setToggling(null)
    },
  })

  const canCreate = auth.can('SETTINGS', 'CREATE')
  const canEdit = auth.can('SETTINGS', 'EDIT')
  const unavailable = list.isError && isFeatureUnavailable(list.error)
  const data = list.data
  const filtered = search !== '' || status !== 'active'

  return (
    <>
      <PageHeader
        title="Sales Engineers"
        description="Engineers assigned to AMC contracts. Records are deactivated, never deleted, so the contracts they are on stay intact."
        actions={canCreate && !unavailable && <Button onClick={() => setEditing({ record: null })}>Add sales engineer</Button>}
      />

      {notice && (
        <div className="mb-4">
          <Alert tone="success" onDismiss={() => setNotice(null)}>
            {notice}
          </Alert>
        </div>
      )}

      <Card>
        {unavailable ? (
          <div className="p-5">
            <Alert tone="info">
              Sales engineers need a database update that has not been applied to this database yet (migration 0070). Until then they can be neither listed nor saved; contracts
              keep their typed engineer names.
            </Alert>
          </div>
        ) : (
          <>
            <div className="grid gap-4 border-b border-slate-200 p-4 sm:grid-cols-3 sm:px-5">
              <Filter label="Search">
                {(id, className) => (
                  <input id={id} type="search" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Name, employee no., email or phone" className={className} />
                )}
              </Filter>
              <Filter label="Status">
                {(id, className) => (
                  <select
                    id={id}
                    value={status}
                    onChange={(event) => {
                      setStatus(event.target.value)
                      setPage(1)
                    }}
                    className={className}
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                    <option value="all">All</option>
                  </select>
                )}
              </Filter>
              <Filter label="Sort">
                {(id, className) => (
                  <select
                    id={id}
                    value={sortKey}
                    onChange={(event) => {
                      setSortKey(event.target.value)
                      setPage(1)
                    }}
                    className={className}
                  >
                    {Object.entries(SORTS).map(([key, option]) => (
                      <option key={key} value={key}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                )}
              </Filter>
            </div>

            {list.isPending && <Spinner label="Loading sales engineers" />}
            {list.isError && <LoadError error={list.error} onRetry={() => void list.refetch()} />}
            {data && data.items.length === 0 && (
              <EmptyState
                title={filtered ? 'No sales engineers match your filters' : 'No sales engineers yet'}
                action={!filtered && canCreate ? <Button onClick={() => setEditing({ record: null })}>Add sales engineer</Button> : undefined}
              />
            )}
            {data && data.items.length > 0 && (
              <>
                <div className={TABLE.wrapper}>
                  <table className={TABLE.table}>
                    <caption className="sr-only">Sales engineers</caption>
                    <thead>
                      <tr>
                        {['Engineer', 'Employee no.', 'Department', 'Contact', 'Sign-in account', 'Contracts', 'Status'].map((label) => (
                          <th key={label} scope="col" className={TABLE.th}>
                            {label}
                          </th>
                        ))}
                        <th scope="col" className={`${TABLE.th} text-right`}>
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {data.items.map((engineer) => (
                        <tr key={engineer.id}>
                          <td className={TABLE.td}>
                            <Link to={`/master-data/sales-engineers/${engineer.id}`} className="font-semibold text-slate-900 hover:text-[#1479BD] hover:underline">
                              {engineer.name}
                            </Link>
                          </td>
                          <td className={TABLE.td}>{engineer.employeeNo ?? '—'}</td>
                          <td className={TABLE.td}>{engineer.department ? `${engineer.department.code} — ${engineer.department.name}` : '—'}</td>
                          <td className={TABLE.td}>
                            <span className="block break-all">{engineer.email ?? '—'}</span>
                            {engineer.phone && <span className="block text-xs text-slate-500">{engineer.phone}</span>}
                          </td>
                          <td className={TABLE.td}>{engineer.user ? engineer.user.fullName : <span className="text-slate-500">Not linked</span>}</td>
                          <td className={`${TABLE.td} tabular-nums`}>{engineer.contractCount}</td>
                          <td className={TABLE.td}>
                            <Badge tone={engineer.isActive ? 'green' : 'slate'}>{engineer.isActive ? 'Active' : 'Inactive'}</Badge>
                          </td>
                          <td className={`${TABLE.td} whitespace-nowrap text-right`}>
                            <ActionGroup>
                              <ActionLink label={`View ${engineer.name}`} icon="eye" to={`/master-data/sales-engineers/${engineer.id}`} />
                              {canEdit && <ActionButton label={`Edit ${engineer.name}`} icon="edit" onClick={() => setEditing({ record: engineer })} />}
                              {canEdit && (
                                <ActionButton
                                  label={`${engineer.isActive ? 'Deactivate' : 'Reactivate'} ${engineer.name}`}
                                  icon={engineer.isActive ? 'stop' : 'restore'}
                                  danger={engineer.isActive}
                                  onClick={() => setToggling(engineer)}
                                />
                              )}
                            </ActionGroup>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pager page={data.page} pageSize={data.pageSize} total={data.total} shown={data.items.length} onPage={setPage} />
              </>
            )}
          </>
        )}
      </Card>

      {editing && (
        <MasterFormModal
          tab="sales-engineers"
          record={editing.record as AnyRecord | null}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setNotice(message)
            setEditing(null)
          }}
        />
      )}
      {toggling && (
        <ConfirmDialog
          title={toggling.isActive ? 'Deactivate sales engineer' : 'Reactivate sales engineer'}
          message={
            toggling.isActive
              ? `${toggling.name} will no longer be offered for contracts. Contracts already linked to them keep the link.`
              : `${toggling.name} will be offered again for contracts.`
          }
          confirmLabel={toggling.isActive ? 'Deactivate' : 'Reactivate'}
          danger={toggling.isActive}
          loading={toggle.isPending}
          error={toggle.isError ? errorMessage(toggle.error) : null}
          onConfirm={() => toggle.mutate(toggling)}
          onCancel={() => {
            toggle.reset()
            setToggling(null)
          }}
        />
      )}
    </>
  )
}

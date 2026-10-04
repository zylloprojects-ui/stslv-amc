import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useId, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../../auth/context'
import { FILTER_INPUT, FILTER_LABEL, LoadError, Pager } from '../../components/records'
import { Alert, Button, Card, EmptyState, PageHeader, Spinner } from '../../components/ui'
import { api } from '../../lib/api'
import { projectLabel, useProjectOptions } from '../../lib/projectOptions'
import { PROCUREMENT_STATUSES, PROCUREMENT_STATUS_LABELS, type ProcurementRequest, type ProcurementStatus } from '../../lib/projectTypes'
import type { Paged } from '../../lib/types'
import { ProcurementDialogs, type ProcurementDialog } from './ProcurementDialogs'
import { ProcurementTable } from './ProcurementTable'

const PAGE_SIZE = 25

export function ProcurementPage() {
  const auth = useAuth()
  const searchId = useId()
  const projectFilterId = useId()
  const statusId = useId()
  // The project filter lives in the address, so a project page can link straight to its procurement.
  const [searchParams, setSearchParams] = useSearchParams()
  const projectId = searchParams.get('projectId') ?? ''

  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<ProcurementStatus | ''>('')
  const [page, setPage] = useState(1)
  const [dialog, setDialog] = useState<ProcurementDialog>({ kind: 'none' })
  const [notice, setNotice] = useState<string | null>(null)

  // Wait for a pause in typing before searching.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 300)

    return () => clearTimeout(timer)
  }, [searchInput])

  const options = useProjectOptions()
  const requests = useQuery({
    queryKey: ['procurement', 'list', { search, status, projectId, page }],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
      if (search) params.set('search', search)
      if (status) params.set('status', status)
      if (projectId) params.set('projectId', projectId)

      return api.get<Paged<ProcurementRequest>>(`/procurement?${params.toString()}`)
    },
    placeholderData: keepPreviousData,
  })

  const canCreate = auth.can('PROCUREMENT', 'CREATE')
  const canEdit = auth.can('PROCUREMENT', 'EDIT')
  const data = requests.data
  const filtered = search !== '' || status !== '' || projectId !== ''

  return (
    <>
      <PageHeader
        title="Procurement"
        description="What each project needs, from request and quotation to order and delivery."
        actions={canCreate && <Button onClick={() => setDialog({ kind: 'create' })}>New Request</Button>}
      />

      {notice && (
        <div className="mb-4">
          <Alert tone="success">{notice}</Alert>
        </div>
      )}

      <Card>
        <div className="flex flex-wrap items-end gap-4 border-b border-slate-200 p-4">
          <div className="min-w-56 flex-1">
            <label htmlFor={searchId} className={FILTER_LABEL}>
              Search
            </label>
            <input
              id={searchId}
              type="search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Requirement, supplier, reference or job number"
              className={FILTER_INPUT}
            />
          </div>
          <div className="min-w-56 max-w-sm flex-1">
            <label htmlFor={projectFilterId} className={FILTER_LABEL}>
              Project
            </label>
            <select
              id={projectFilterId}
              value={projectId}
              onChange={(event) => {
                setSearchParams(event.target.value ? { projectId: event.target.value } : {}, { replace: true })
                setPage(1)
              }}
              className={FILTER_INPUT}
            >
              <option value="">All projects</option>
              {options.data?.map((option) => (
                <option key={option.id} value={option.id}>
                  {projectLabel(option)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={statusId} className={FILTER_LABEL}>
              Status
            </label>
            <select
              id={statusId}
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as ProcurementStatus | '')
                setPage(1)
              }}
              className={FILTER_INPUT}
            >
              <option value="">All statuses</option>
              {PROCUREMENT_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {PROCUREMENT_STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
        </div>

        {requests.isPending && <Spinner label="Loading procurement" />}
        {requests.isError && <LoadError error={requests.error} onRetry={() => void requests.refetch()} />}

        {data && data.items.length === 0 && (
          <EmptyState
            title={filtered ? 'No procurement requests match your search' : 'No procurement requests yet'}
            description={filtered ? 'Try a different search or filter.' : 'Every procurement request belongs to a project / job.'}
            action={!filtered && canCreate ? <Button onClick={() => setDialog({ kind: 'create' })}>New Request</Button> : undefined}
          />
        )}

        {data && data.items.length > 0 && (
          <>
            <ProcurementTable
              items={data.items}
              showProject
              linkProject={auth.can('PROJECTS', 'VIEW')}
              canEdit={canEdit}
              onDialog={setDialog}
              startAt={(data.page - 1) * data.pageSize}
            />
            <Pager page={data.page} pageSize={data.pageSize} shown={data.items.length} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>

      <p className="mt-3 text-xs text-slate-500">
        A quotation amount is a commitment, not a cost. Project costs come only from recorded expenses.
      </p>

      <ProcurementDialogs dialog={dialog} setDialog={setDialog} canEdit={canEdit} onNotice={setNotice} />
    </>
  )
}

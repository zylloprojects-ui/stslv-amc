import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/context'
import { FILTER_INPUT, FILTER_LABEL, InvoiceStateBadge, LoadError, Money, Pager, ProjectStatusBadge } from '../../components/records'
import { TABLE } from '../../components/table'
import { Alert, Button, Card, EmptyState, PageHeader, Spinner } from '../../components/ui'
import { api } from '../../lib/api'
import { formatJobDate } from '../../lib/format'
import { PROJECT_STATUSES, PROJECT_STATUS_LABELS, type InvoiceState, type Project, type ProjectStatus } from '../../lib/projectTypes'
import type { Paged } from '../../lib/types'
import { ProjectFormModal } from './ProjectFormModal'

const PAGE_SIZE = 25

type Dialog = { kind: 'none' } | { kind: 'create' } | { kind: 'edit'; project: Project }

export function ProjectsPage() {
  const auth = useAuth()
  const searchId = useId()
  const statusId = useId()
  const invoiceId = useId()

  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<ProjectStatus | ''>('')
  const [invoiceState, setInvoiceState] = useState<InvoiceState | ''>('')
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

  const projects = useQuery({
    queryKey: ['projects', 'list', { search, status, invoiceState, page }],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
      if (search) params.set('search', search)
      if (status) params.set('status', status)
      if (invoiceState) params.set('invoiceState', invoiceState)

      return api.get<Paged<Project>>(`/projects?${params.toString()}`)
    },
    placeholderData: keepPreviousData,
  })

  const canCreate = auth.can('PROJECTS', 'CREATE')
  const canEdit = auth.can('PROJECTS', 'EDIT')
  // Recorded costs are returned only to roles that may view expenses.
  const showCosts = auth.can('EXPENSES', 'VIEW')

  const data = projects.data
  const filtered = search !== '' || status !== '' || invoiceState !== ''

  return (
    <>
      <PageHeader
        title="Projects"
        description="Jobs for clients, with their value, procurement, tracked expenses and invoice readiness."
        actions={canCreate && <Button onClick={() => setDialog({ kind: 'create' })}>New Project</Button>}
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
              placeholder="Job number, client, description or LPO number"
              className={FILTER_INPUT}
            />
          </div>
          <div>
            <label htmlFor={statusId} className={FILTER_LABEL}>
              Status
            </label>
            <select
              id={statusId}
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as ProjectStatus | '')
                setPage(1)
              }}
              className={FILTER_INPUT}
            >
              <option value="">All statuses</option>
              {PROJECT_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {PROJECT_STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={invoiceId} className={FILTER_LABEL}>
              Invoicing
            </label>
            <select
              id={invoiceId}
              value={invoiceState}
              onChange={(event) => {
                setInvoiceState(event.target.value as InvoiceState | '')
                setPage(1)
              }}
              className={FILTER_INPUT}
            >
              <option value="">Any</option>
              <option value="READY_FOR_INVOICE">Ready for invoice</option>
              <option value="NO_INVOICE_REQUIRED">No invoice required</option>
            </select>
          </div>
        </div>

        {projects.isPending && <Spinner label="Loading projects" />}
        {projects.isError && <LoadError error={projects.error} onRetry={() => void projects.refetch()} />}

        {data && data.items.length === 0 && (
          <EmptyState
            title={filtered ? 'No projects match your search' : 'No projects yet'}
            description={
              filtered ? 'Try a different search or filter.' : 'A project is created for a client and receives its job number automatically.'
            }
            action={!filtered && canCreate ? <Button onClick={() => setDialog({ kind: 'create' })}>New Project</Button> : undefined}
          />
        )}

        {data && data.items.length > 0 && (
          <>
            <div className={TABLE.wrapper}>
              <table className={TABLE.table}>
                <caption className="sr-only">Projects</caption>
                <thead>
                  <tr>
                    <th scope="col" className={TABLE.th}>
                      Job number
                    </th>
                    <th scope="col" className={TABLE.th}>
                      Client
                    </th>
                    <th scope="col" className={TABLE.th}>
                      Job description
                    </th>
                    <th scope="col" className={TABLE.th}>
                      Job date
                    </th>
                    <th scope="col" className={TABLE.th}>
                      Status
                    </th>
                    <th scope="col" className={`${TABLE.th} text-right`}>
                      Job value
                    </th>
                    <th scope="col" className={`${TABLE.th} text-right`}>
                      VAT
                    </th>
                    <th scope="col" className={`${TABLE.th} text-right`}>
                      Grand job value
                    </th>
                    {showCosts && (
                      <>
                        <th scope="col" className={`${TABLE.th} text-right`}>
                          Tracked expenses
                        </th>
                        <th scope="col" className={`${TABLE.th} text-right`}>
                          Operational job margin
                        </th>
                      </>
                    )}
                    <th scope="col" className={`${TABLE.th} text-right`}>
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.items.map((project) => (
                    <tr key={project.id} className={TABLE.row}>
                      <td className={`${TABLE.td} whitespace-nowrap font-medium`}>
                        <Link to={`/projects/${project.id}`} className="text-blue-700 hover:underline">
                          {project.jobNumber}
                        </Link>
                      </td>
                      <td className={TABLE.td}>{project.clientName}</td>
                      <td className={`${TABLE.td} min-w-56`}>{project.description}</td>
                      <td className={`${TABLE.td} whitespace-nowrap`}>{formatJobDate(project)}</td>
                      <td className={TABLE.td}>
                        <div className="flex flex-col items-start gap-1">
                          <ProjectStatusBadge status={project.status} legacyStatus={project.legacyStatus} />
                          <InvoiceStateBadge state={project.invoiceState} />
                        </div>
                      </td>
                      <td className={`${TABLE.td} text-right`}>
                        <Money value={project.jobValue} />
                      </td>
                      <td className={`${TABLE.td} text-right`}>
                        <Money value={project.vatAmount} />
                      </td>
                      <td className={`${TABLE.td} text-right font-medium text-slate-900`}>
                        <Money value={project.grandValue} />
                      </td>
                      {showCosts && (
                        <>
                          <td className={`${TABLE.td} text-right`}>
                            <Money value={project.trackedExpenses} />
                          </td>
                          <td className={`${TABLE.td} text-right font-medium`}>
                            <Money value={project.operationalJobMargin} />
                          </td>
                        </>
                      )}
                      <td className={`${TABLE.td} whitespace-nowrap text-right`}>
                        <div className="flex justify-end gap-1">
                          <Link
                            to={`/projects/${project.id}`}
                            aria-label={`View ${project.jobNumber}`}
                            className="rounded-md px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50"
                          >
                            View
                          </Link>
                          {canEdit && project.status !== 'CANCELLED' && project.status !== 'HISTORICAL' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={`Edit ${project.jobNumber}`}
                              onClick={() => setDialog({ kind: 'edit', project })}
                            >
                              Edit
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Pager page={data.page} pageSize={data.pageSize} shown={data.items.length} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>

      <p className="mt-3 text-xs text-slate-500">
        Job value excludes VAT.
        {showCosts &&
          ' Operational job margin is the job value excluding VAT minus the expenses recorded against the job. It is not accounting profit.'}
      </p>

      {dialog.kind !== 'none' && (
        <ProjectFormModal
          project={dialog.kind === 'edit' ? dialog.project : null}
          onClose={() => setDialog({ kind: 'none' })}
          onSaved={(saved) => {
            setNotice(dialog.kind === 'edit' ? `Project ${saved.jobNumber} was updated.` : `Project ${saved.jobNumber} was created.`)
            setDialog({ kind: 'none' })
          }}
        />
      )}
    </>
  )
}

import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useId, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../auth/context'
import { ExportButtons } from '../../components/ExportButtons'
import { FILTER_INPUT, FILTER_LABEL, InvoiceStateBadge, LoadError, Money, Pager } from '../../components/records'
import { TABLE } from '../../components/table'
import { Alert, Button, Card, EmptyState, PageHeader, Spinner } from '../../components/ui'
import { api } from '../../lib/api'
import { formatCount, formatDate } from '../../lib/format'
import type { BillableWork, InvoiceStatus, PagedInvoices } from '../../lib/invoiceTypes'
import { InvoiceDialogs, type InvoiceDialog } from './InvoiceDialogs'
import { InvoicesTable } from './InvoicesTable'

const PAGE_SIZE = 25

export function InvoicesPage() {
  const auth = useAuth()
  const searchId = useId()
  const statusId = useId()
  const fromId = useId()
  const toId = useId()
  // The project filter lives in the address, so a project page can link straight to its invoices.
  const [searchParams, setSearchParams] = useSearchParams()
  const projectId = searchParams.get('projectId') ?? ''

  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<InvoiceStatus | ''>('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [page, setPage] = useState(1)
  const [dialog, setDialog] = useState<InvoiceDialog>({ kind: 'none' })
  const [notice, setNotice] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)

  // Wait for a pause in typing before searching.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 300)

    return () => clearTimeout(timer)
  }, [searchInput])

  const pending = useQuery({ queryKey: ['invoices', 'billable', 'pending'], queryFn: () => api.get<BillableWork>('/invoices/billable') })
  const invoices = useQuery({
    queryKey: ['invoices', 'list', { search, status, projectId, dateFrom, dateTo, page }],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
      if (search) params.set('search', search)
      if (status) params.set('status', status)
      if (projectId) params.set('projectId', projectId)
      if (dateFrom) params.set('dateFrom', dateFrom)
      if (dateTo) params.set('dateTo', dateTo)

      return api.get<PagedInvoices>(`/invoices?${params.toString()}`)
    },
    placeholderData: keepPreviousData,
  })

  const canCreate = auth.can('INVOICES', 'CREATE')
  // Invoices are never deleted; changing and cancelling one need the same permission.
  const canEdit = auth.can('INVOICES', 'EDIT')
  const canExport = auth.can('INVOICES', 'EXPORT')
  const linkProject = auth.can('PROJECTS', 'VIEW')
  const work = pending.data
  const visits = work?.amcVisits ?? null
  const projects = work?.projects ?? null
  const nothingWaiting = work !== undefined && (visits?.items.length ?? 0) === 0 && (projects?.items.length ?? 0) === 0
  const data = invoices.data
  const filtered = search !== '' || status !== '' || projectId !== '' || dateFrom !== '' || dateTo !== ''
  // The export covers every invoice that matches the filters, not only the page shown.
  const invoicesExportPath = (format: string) => {
    const params = new URLSearchParams({ format })
    if (search) params.set('search', search)
    if (status) params.set('status', status)
    if (projectId) params.set('projectId', projectId)
    if (dateFrom) params.set('dateFrom', dateFrom)
    if (dateTo) params.set('dateTo', dateTo)

    return `/invoices/export?${params.toString()}`
  }

  return (
    <>
      <PageHeader
        title="Invoice Tracking"
        description="Invoices raised in Zoho, recorded against the completed AMC visits and projects they cover."
        actions={canCreate && <Button onClick={() => setDialog({ kind: 'create' })}>Record Invoice</Button>}
      />

      {notice && (
        <div className="mb-4">
          <Alert tone="success">{notice}</Alert>
        </div>
      )}

      {exportError && (
        <div className="mb-4">
          <Alert onDismiss={() => setExportError(null)}>{exportError}</Alert>
        </div>
      )}

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Waiting for an invoice</h2>
            <p className="mt-1 text-sm text-slate-600">Completed work that no invoice covers yet. Raise the invoice in Zoho, then record it here.</p>
          </div>
          {/* Offered when the role may export and may see at least one kind of waiting work. */}
          {canExport && (visits !== null || projects !== null) && (
            <ExportButtons
              what="pending invoices"
              fileStem="pending-invoices"
              size="sm"
              path={(format) => `/invoices/billable/export?format=${format}`}
              onError={setExportError}
            />
          )}
        </div>

        {pending.isPending && <Spinner size="sm" label="Loading work waiting for an invoice" />}
        {pending.isError && <LoadError error={pending.error} onRetry={() => void pending.refetch()} />}
        {nothingWaiting && (
          <EmptyState
            title="Nothing is waiting for an invoice"
            description={
              visits === null || projects === null
                ? 'Completed work is listed for roles that may also view the AMC Schedule or Projects.'
                : 'Every completed visit and project is covered by an invoice.'
            }
          />
        )}

        {visits && visits.items.length > 0 && (
          <>
            <p className="px-6 pt-4 text-sm font-medium text-slate-900" data-testid="pending-visits">
              AMC visits: {formatCount(visits.pendingCount)} · <Money value={visits.pendingAmount} />{' '}
              <span className="font-normal text-slate-500">(visit amounts as entered)</span>
            </p>
            <div className={TABLE.wrapper}>
              <table className={TABLE.table}>
                <caption className="sr-only">AMC visits waiting for an invoice</caption>
                <thead>
                  <tr>
                    <th scope="col" className={TABLE.th}>
                      Client
                    </th>
                    <th scope="col" className={TABLE.th}>
                      System
                    </th>
                    <th scope="col" className={TABLE.th}>
                      Visit
                    </th>
                    <th scope="col" className={TABLE.th}>
                      Completed
                    </th>
                    <th scope="col" className={`${TABLE.th} text-right`}>
                      Visit amount
                    </th>
                    <th scope="col" className={`${TABLE.th} text-right`}>
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visits.items.map((visit) => (
                    <tr key={visit.id} className={TABLE.row}>
                      <td className={`${TABLE.td} ${TABLE.text}`}>{visit.client.name}</td>
                      <td className={TABLE.td}>{visit.systemDescription}</td>
                      <td className={`${TABLE.td} whitespace-nowrap`}>
                        No. {visit.sequenceNo} · {formatDate(visit.periodStart)} to {formatDate(visit.periodEnd)}
                      </td>
                      <td className={`${TABLE.td} whitespace-nowrap`}>{formatDate(visit.completedDate)}</td>
                      <td className={`${TABLE.td} text-right font-medium`}>
                        <Money value={visit.visitAmount} />
                      </td>
                      <td className={`${TABLE.td} whitespace-nowrap text-right`}>
                        {canCreate && (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Record invoice for ${visit.client.name} ${visit.systemDescription} visit ${visit.sequenceNo}`}
                            onClick={() => setDialog({ kind: 'create', preset: { client: visit.client, key: `visit:${visit.id}`, amount: '' } })}
                          >
                            Record invoice
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {projects && projects.items.length > 0 && (
          <>
            <p className="border-t border-slate-200 px-6 pt-4 text-sm font-medium text-slate-900" data-testid="pending-projects">
              Projects: {formatCount(projects.pendingCount)} · <Money value={projects.pendingValue} />{' '}
              <span className="font-normal text-slate-500">(not yet invoiced, excluding VAT)</span>
            </p>
            <div className={TABLE.wrapper}>
              <table className={TABLE.table}>
                <caption className="sr-only">Projects waiting for an invoice</caption>
                <thead>
                  <tr>
                    <th scope="col" className={TABLE.th}>
                      Job number
                    </th>
                    <th scope="col" className={TABLE.th}>
                      Client
                    </th>
                    <th scope="col" className={TABLE.th}>
                      Description
                    </th>
                    <th scope="col" className={TABLE.th}>
                      Completed
                    </th>
                    <th scope="col" className={`${TABLE.th} text-right`}>
                      Job value
                    </th>
                    <th scope="col" className={`${TABLE.th} text-right`}>
                      Invoiced
                    </th>
                    <th scope="col" className={`${TABLE.th} text-right`}>
                      Not yet invoiced
                    </th>
                    <th scope="col" className={`${TABLE.th} text-right`}>
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {projects.items.map((project) => (
                    <tr key={project.id} className={TABLE.row}>
                      <td className={`${TABLE.td} whitespace-nowrap font-medium`}>
                        {linkProject ? (
                          <Link to={`/projects/${project.id}`} className="text-blue-700 hover:underline">
                            {project.jobNumber}
                          </Link>
                        ) : (
                          project.jobNumber
                        )}
                        {project.invoiceState === 'PARTLY_INVOICED' && (
                          <div className="mt-1">
                            <InvoiceStateBadge state={project.invoiceState} />
                          </div>
                        )}
                      </td>
                      <td className={`${TABLE.td} ${TABLE.text}`}>{project.client.name}</td>
                      <td className={`${TABLE.td} ${TABLE.text}`}>{project.description}</td>
                      <td className={`${TABLE.td} whitespace-nowrap`}>{formatDate(project.completedDate)}</td>
                      <td className={`${TABLE.td} text-right`}>
                        <Money value={project.jobValue} />
                      </td>
                      <td className={`${TABLE.td} text-right`}>
                        <Money value={project.invoicedValue} />
                      </td>
                      <td className={`${TABLE.td} text-right font-medium`}>
                        <Money value={project.uninvoicedValue} />
                      </td>
                      <td className={`${TABLE.td} whitespace-nowrap text-right`}>
                        {canCreate && (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Record invoice for ${project.jobNumber}`}
                            onClick={() =>
                              setDialog({
                                kind: 'create',
                                preset: { client: project.client, key: `project:${project.id}`, amount: project.uninvoicedValue },
                              })
                            }
                          >
                            Record invoice
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      <Card className="mt-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-6 py-4">
          <h2 className="text-base font-semibold text-slate-900">Invoices recorded</h2>
          {canExport && <ExportButtons what="invoices" fileStem="invoice-tracking" size="sm" path={invoicesExportPath} onError={setExportError} />}
        </div>
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
              placeholder="Invoice number, client, Zoho reference or job number"
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
                setStatus(event.target.value as InvoiceStatus | '')
                setPage(1)
              }}
              className={FILTER_INPUT}
            >
              <option value="">All</option>
              <option value="ISSUED">Issued</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </div>
          <div>
            <label htmlFor={fromId} className={FILTER_LABEL}>
              From
            </label>
            <input
              id={fromId}
              type="date"
              value={dateFrom}
              onChange={(event) => {
                setDateFrom(event.target.value)
                setPage(1)
              }}
              className={FILTER_INPUT}
            />
          </div>
          <div>
            <label htmlFor={toId} className={FILTER_LABEL}>
              To
            </label>
            <input
              id={toId}
              type="date"
              value={dateTo}
              onChange={(event) => {
                setDateTo(event.target.value)
                setPage(1)
              }}
              className={FILTER_INPUT}
            />
          </div>
          {projectId !== '' && (
            <div className="pb-1">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setSearchParams({}, { replace: true })
                  setPage(1)
                }}
              >
                Showing one project — show all
              </Button>
            </div>
          )}
        </div>

        {invoices.isPending && <Spinner label="Loading invoices" />}
        {invoices.isError && <LoadError error={invoices.error} onRetry={() => void invoices.refetch()} />}

        {data && data.items.length === 0 && (
          <EmptyState
            title={filtered ? 'No invoices match your search' : 'No invoices recorded yet'}
            description={filtered ? 'Try a different search or filter.' : 'Record each Zoho invoice against the completed work it covers.'}
          />
        )}

        {data && data.items.length > 0 && (
          <>
            <InvoicesTable
              items={data.items}
              showClient
              linkProject={linkProject}
              canEdit={canEdit}
              onDialog={setDialog}
              startAt={(data.page - 1) * data.pageSize}
            />
            <Pager page={data.page} pageSize={data.pageSize} shown={data.items.length} total={data.total} onPage={setPage}>
              <p className="font-medium text-slate-900">
                {filtered ? 'Total of matching invoices' : 'Total invoiced'}, excl. VAT:{' '}
                <span data-testid="invoices-total">
                  <Money value={data.totals.amountExclVat} />
                </span>
              </p>
            </Pager>
          </>
        )}
      </Card>

      <p className="mt-3 text-xs text-slate-500">
        The total covers every invoice that matches the filters, on all pages. Cancelled invoices are never counted. Invoice references from the
        earlier Excel registers are not invoices and are shown under Historical Data.
      </p>

      <InvoiceDialogs dialog={dialog} setDialog={setDialog} canEdit={canEdit} onNotice={setNotice} />
    </>
  )
}

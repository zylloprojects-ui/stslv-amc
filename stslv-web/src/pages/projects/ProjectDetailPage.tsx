import { useQuery } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../../auth/context'
import { DetailRow, InvoiceStateBadge, LoadError, Money, OrDash, ProjectStatusBadge } from '../../components/records'
import { Alert, Button, Card, EmptyState, PageHeader, Spinner } from '../../components/ui'
import { api, ApiError } from '../../lib/api'
import { formatDate, formatDateTime, formatJobDate } from '../../lib/format'
import { formatRate } from '../../lib/money'
import type { PagedExpenses, ProcurementRequest, Project, ProjectStatus } from '../../lib/projectTypes'
import type { Paged } from '../../lib/types'
import { ExpenseDialogs, type ExpenseDialog } from '../expenses/ExpenseDialogs'
import { ExpensesTable } from '../expenses/ExpensesTable'
import { ProcurementDialogs, type ProcurementDialog } from '../procurement/ProcurementDialogs'
import { ProcurementTable } from '../procurement/ProcurementTable'
import { ProjectFormModal } from './ProjectFormModal'
import { ProjectStatusDialog } from './ProjectStatusDialog'
import { statusActionLabel } from './statusActions'

// The project page shows the latest records; the full, filterable lists are on their own pages.
const SECTION_SIZE = 50

function Figure({ label, hint, children, strong = false }: { label: string; hint?: string; children: ReactNode; strong?: boolean }) {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
      <dt className="text-sm font-bold text-slate-800">{label}</dt>
      <dd className={`mt-1 text-right text-lg ${strong ? 'font-semibold text-slate-900' : 'text-slate-800'}`}>{children}</dd>
      {hint && <p className="mt-1 text-right text-xs text-slate-500">{hint}</p>}
    </div>
  )
}

export function ProjectDetailPage() {
  const { id = '' } = useParams()
  const auth = useAuth()
  const [editing, setEditing] = useState(false)
  const [statusTarget, setStatusTarget] = useState<ProjectStatus | null>(null)
  const [procurementDialog, setProcurementDialog] = useState<ProcurementDialog>({ kind: 'none' })
  const [expenseDialog, setExpenseDialog] = useState<ExpenseDialog>({ kind: 'none' })
  const [notice, setNotice] = useState<string | null>(null)

  const canEdit = auth.can('PROJECTS', 'EDIT')
  const showProcurement = auth.can('PROCUREMENT', 'VIEW')
  // Recorded costs are returned only to roles that may view expenses.
  const showCosts = auth.can('EXPENSES', 'VIEW')

  const query = useQuery({ queryKey: ['projects', 'detail', id], queryFn: () => api.get<Project>(`/projects/${id}`) })
  const procurement = useQuery({
    queryKey: ['procurement', 'project', id],
    queryFn: () => api.get<Paged<ProcurementRequest>>(`/procurement?projectId=${id}&pageSize=${SECTION_SIZE}`),
    enabled: showProcurement && query.isSuccess,
  })
  const expenses = useQuery({
    queryKey: ['expenses', 'project', id],
    queryFn: () => api.get<PagedExpenses>(`/expenses?projectId=${id}&pageSize=${SECTION_SIZE}`),
    enabled: showCosts && query.isSuccess,
  })

  const back = (
    <Link to="/projects" className="text-sm font-medium text-blue-700 hover:underline">
      ← All projects
    </Link>
  )

  if (query.isPending) {
    return <Spinner label="Loading project" />
  }

  if (query.isError) {
    const missing = query.error instanceof ApiError && query.error.status === 404

    return (
      <>
        <div className="mb-4">{back}</div>
        <Card>
          {missing ? (
            <EmptyState title="Project not found" description="It may have been opened from an old link." />
          ) : (
            <LoadError error={query.error} onRetry={() => void query.refetch()} />
          )}
        </Card>
      </>
    )
  }

  const project = query.data
  const historical = project.status === 'HISTORICAL'
  // A cancelled or historical project cannot be edited and takes no new records.
  const open = project.status !== 'CANCELLED' && !historical
  const fixedProject = { id: project.id, jobNumber: project.jobNumber, clientName: project.clientName, description: project.description }

  return (
    <>
      <div className="mb-4">{back}</div>

      <PageHeader
        title={`Project ${project.jobNumber}`}
        description={`${project.clientName} — ${project.description}`}
        actions={
          canEdit && (
            <>
              {open && (
                <Button variant="secondary" onClick={() => setEditing(true)}>
                  Edit
                </Button>
              )}
              {project.allowedStatuses.map((target) => (
                <Button
                  key={target}
                  variant={target === 'CANCELLED' ? 'secondary' : 'primary'}
                  className={target === 'CANCELLED' ? 'text-red-700' : undefined}
                  onClick={() => setStatusTarget(target)}
                >
                  {statusActionLabel(project.status, target)}
                </Button>
              ))}
            </>
          )
        }
      />

      {notice && (
        <div className="mb-4">
          <Alert tone="success">{notice}</Alert>
        </div>
      )}

      {historical && (
        <div className="mb-4">
          <Alert tone="info">
            <strong>Historical record.</strong> This job was imported from an earlier job register and is shown as that register recorded it. It
            cannot be edited here and is not counted as current work or as ready for invoice.
          </Alert>
        </div>
      )}
      {project.invoiceState === 'READY_FOR_INVOICE' && (
        <div className="mb-4">
          <Alert tone="info">
            <strong>Ready for invoice.</strong> This project is completed and has a job value. Raise the invoice in Zoho; recording the invoice
            details here will be possible once Invoice Tracking is available.
          </Alert>
        </div>
      )}
      {project.invoiceState === 'NO_INVOICE_REQUIRED' && (
        <div className="mb-4">
          <Alert tone="info">
            <strong>No invoice required.</strong> This project is completed with a job value of zero, so it is not waiting for an invoice.
          </Alert>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <h2 className="border-b border-slate-200 px-6 py-4 text-base font-semibold text-slate-900">Job details</h2>
          <dl className="divide-y divide-slate-100 px-6 py-2">
            <DetailRow label="Job number">{project.jobNumber}</DetailRow>
            <DetailRow label="Status">
              <span className="flex flex-wrap gap-2">
                <ProjectStatusBadge status={project.status} />
                <InvoiceStateBadge state={project.invoiceState} />
              </span>
            </DetailRow>
            {project.legacyStatus !== null && <DetailRow label="Status in the earlier register">{project.legacyStatus}</DetailRow>}
            <DetailRow label="Client">{project.clientName}</DetailRow>
            <DetailRow label="Job description">{project.description}</DetailRow>
            <DetailRow label="Job date">
              {formatJobDate(project)}
              {project.jobDatePrecision === 'MONTH' && <span className="text-slate-500"> (day not recorded)</span>}
            </DetailRow>
            <DetailRow label="LPO number">
              <OrDash value={project.lpoNumber} />
            </DetailRow>
            <DetailRow label="LPO date">{formatDate(project.lpoDate)}</DetailRow>
            <DetailRow label="Completed">
              {historical ? <span className="text-slate-500">Not recorded</span> : formatDate(project.completedDate)}
            </DetailRow>
            <DetailRow label="Notes">
              <OrDash value={project.notes} />
            </DetailRow>
            <DetailRow label="Created">{formatDateTime(project.createdAt)}</DetailRow>
            <DetailRow label="Last updated">{formatDateTime(project.updatedAt)}</DetailRow>
          </dl>
        </Card>

        <Card className="lg:col-span-3">
          <h2 className="border-b border-slate-200 px-6 py-4 text-base font-semibold text-slate-900">Financial summary</h2>
          <div className="px-6 py-5">
            <dl aria-label="Financial summary" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <Figure label="Job value" hint="Excluding VAT">
                <Money value={project.jobValue} />
              </Figure>
              <Figure label="VAT amount" hint={`VAT rate ${formatRate(project.vatRate)}`}>
                <Money value={project.vatAmount} />
              </Figure>
              <Figure label="Grand job value" hint="Job value plus VAT" strong>
                <Money value={project.grandValue} />
              </Figure>
              {showCosts && (
                <>
                  <Figure label="Tracked expenses" hint="Expenses recorded against this job">
                    <Money value={project.trackedExpenses} />
                  </Figure>
                  <Figure label="Operational job margin" hint="Job value excluding VAT minus tracked expenses" strong>
                    <Money value={project.operationalJobMargin} />
                  </Figure>
                </>
              )}
              <Figure label="Budget" hint="Planned cost">
                <Money value={project.budgetAmount} />
              </Figure>
              {showCosts && project.budgetAmount !== null && (
                <Figure label="Budget remaining" hint="Budget minus tracked expenses">
                  <Money value={project.budgetRemaining} />
                </Figure>
              )}
            </dl>
            <p className="mt-4 text-xs text-slate-500">
              {showCosts
                ? 'Operational job margin counts only the expenses recorded here. It is not accounting profit. Every figure is calculated by the server from the stored records.'
                : 'Recorded costs and margin are shown to roles that may view expenses.'}
            </p>
          </div>
        </Card>
      </div>

      {showProcurement && (
        <Card className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-6 py-4">
            <h2 className="text-base font-semibold text-slate-900">Procurement</h2>
            <div className="flex flex-wrap items-center gap-3">
              <Link to={`/procurement?projectId=${project.id}`} className="text-sm font-medium text-blue-700 hover:underline">
                Open in Procurement
              </Link>
              {open && auth.can('PROCUREMENT', 'CREATE') && (
                <Button size="sm" onClick={() => setProcurementDialog({ kind: 'create' })}>
                  Add procurement request
                </Button>
              )}
            </div>
          </div>
          {procurement.isPending && <Spinner size="sm" label="Loading procurement" />}
          {procurement.isError && <LoadError error={procurement.error} onRetry={() => void procurement.refetch()} />}
          {procurement.data && procurement.data.items.length === 0 && (
            <EmptyState title="No procurement requests for this project" />
          )}
          {procurement.data && procurement.data.items.length > 0 && (
            <ProcurementTable
              items={procurement.data.items}
              showProject={false}
              linkProject={false}
              canEdit={auth.can('PROCUREMENT', 'EDIT')}
              onDialog={setProcurementDialog}
            />
          )}
        </Card>
      )}

      {showCosts && (
        <Card className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-6 py-4">
            <h2 className="text-base font-semibold text-slate-900">Expenses</h2>
            <div className="flex flex-wrap items-center gap-3">
              <Link to={`/expenses?projectId=${project.id}`} className="text-sm font-medium text-blue-700 hover:underline">
                Open in Expenses
              </Link>
              {open && auth.can('EXPENSES', 'CREATE') && (
                <Button size="sm" onClick={() => setExpenseDialog({ kind: 'create' })}>
                  Record expense
                </Button>
              )}
            </div>
          </div>
          {expenses.isPending && <Spinner size="sm" label="Loading expenses" />}
          {expenses.isError && <LoadError error={expenses.error} onRetry={() => void expenses.refetch()} />}
          {expenses.data && expenses.data.items.length === 0 && <EmptyState title="No expenses recorded for this project" />}
          {expenses.data && expenses.data.items.length > 0 && (
            <>
              <ExpensesTable
                items={expenses.data.items}
                showProject={false}
                linkProject={false}
                canEdit={auth.can('EXPENSES', 'EDIT')}
                canVoid={auth.can('EXPENSES', 'DELETE')}
                onDialog={setExpenseDialog}
              />
              <p className="border-t border-slate-200 px-6 py-3 text-right text-sm font-medium text-slate-900">
                Total tracked expenses: <Money value={expenses.data.totalAmount} />
              </p>
            </>
          )}
        </Card>
      )}

      {editing && (
        <ProjectFormModal
          project={project}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setNotice(`Project ${saved.jobNumber} was updated.`)
            setEditing(false)
          }}
        />
      )}

      {statusTarget && (
        <ProjectStatusDialog
          project={project}
          target={statusTarget}
          onClose={() => setStatusTarget(null)}
          onChanged={(updated) => {
            setNotice(`Project ${updated.jobNumber} is now ${updated.status === 'IN_PROGRESS' ? 'in progress' : updated.status.toLowerCase()}.`)
            setStatusTarget(null)
          }}
        />
      )}

      <ProcurementDialogs
        dialog={procurementDialog}
        setDialog={setProcurementDialog}
        fixedProject={fixedProject}
        canEdit={auth.can('PROCUREMENT', 'EDIT')}
        onNotice={setNotice}
      />
      <ExpenseDialogs
        dialog={expenseDialog}
        setDialog={setExpenseDialog}
        fixedProject={fixedProject}
        canEdit={auth.can('EXPENSES', 'EDIT')}
        onNotice={setNotice}
      />
    </>
  )
}

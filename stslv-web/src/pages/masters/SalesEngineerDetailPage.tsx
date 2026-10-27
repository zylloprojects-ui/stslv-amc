import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../../auth/context'
import { LinkedContracts } from '../../components/LinkedContracts'
import { DetailRow, LoadError, OrDash } from '../../components/records'
import { RecordHistory } from '../../components/RecordHistory'
import { TABLE } from '../../components/table'
import { Alert, Button, Card, ConfirmDialog, EmptyState, PageHeader, Spinner } from '../../components/ui'
import { api, ApiError, errorMessage } from '../../lib/api'
import { formatCount, formatDate, formatDateTime } from '../../lib/format'
import { formatMoney } from '../../lib/money'
import { VisitStatusPill } from '../amc/components'
import type { VisitStatus } from '../amc/types'
import { AssignmentWarning, SalesEngineerFormModal } from './SalesEngineerFormModal'
import { EngineerStatusBadge } from './SalesEngineersPage'
import { ENGINEER_STATUS_LABELS, isFeatureUnavailable, type EngineerSummary, type EngineerRecord } from './masterTypes'

const ACTION_LABELS: Record<string, string> = {
  'sales_engineer.created': 'Sales engineer added',
  'sales_engineer.updated': 'Sales engineer updated',
  'sales_engineer.deactivated': 'Sales engineer disabled',
  'sales_engineer.reactivated': 'Sales engineer enabled',
}

const FIELD_LABELS: Record<string, string> = {
  name: 'Engineer name',
  employeeNo: 'Employee number',
  email: 'Email',
  phone: 'Phone',
  departmentId: 'Department',
  userId: 'User account',
  notes: 'Notes',
  isActive: 'Active',
}

const NO_ACCESS = (module: string) => `Your role does not include ${module}.`

function Section({ id, title, description, children }: { id: string; title: string; description?: string; children: ReactNode }) {
  return (
    <Card>
      <section aria-labelledby={id}>
        <div className="border-b border-slate-200 px-6 py-4">
          <h2 id={id} className="text-base font-semibold text-slate-900">
            {title}
          </h2>
          {description && <p className="mt-0.5 text-sm text-slate-600">{description}</p>}
        </div>
        {children}
      </section>
    </Card>
  )
}

/**
 * One Engineer 360 figure. `value` null shows "Not available" with the reason in
 * `hint`, so a figure the viewer may not see is never shown as a zero.
 */
function Metric({ label, value, hint, tone = 'default' }: { label: string; value: ReactNode | null; hint?: ReactNode; tone?: 'default' | 'warn' }) {
  const unavailable = value === null

  return (
    <div className={`rounded-xl border bg-white p-4 shadow-sm ${unavailable ? 'border-dashed border-slate-200' : tone === 'warn' ? 'border-amber-200' : 'border-slate-200'}`}>
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className={`mt-1 text-xl font-bold tabular-nums ${unavailable ? 'text-base font-semibold text-slate-400' : 'text-[#0b3b66]'}`}>{unavailable ? 'Not available' : value}</dd>
      {hint && <dd className={`mt-1 text-xs ${tone === 'warn' && !unavailable ? 'text-amber-700' : 'text-slate-500'}`}>{hint}</dd>}
    </div>
  )
}

function SummaryStrip({ summary }: { summary: EngineerSummary }) {
  const { contracts, visits } = summary

  return (
    <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5" aria-label="Engineer figures">
      <Metric
        label="Assigned AMC contracts"
        value={contracts ? formatCount(contracts.total) : null}
        hint={contracts ? `${contracts.draft} draft · ${contracts.expired} expired · ${contracts.cancelled} cancelled` : NO_ACCESS('AMC contracts')}
      />
      <Metric label="Active AMC contracts" value={contracts ? formatCount(contracts.active) : null} hint={contracts ? undefined : NO_ACCESS('AMC contracts')} />
      <Metric
        label="Active AMC value"
        value={contracts ? formatMoney(contracts.activeValue) : null}
        hint={contracts ? 'Contract value of active contracts, as on the dashboard' : NO_ACCESS('AMC contracts')}
      />
      <Metric
        label="Upcoming visits"
        value={visits ? formatCount(visits.upcoming) : null}
        hint={visits ? (visits.nextVisitDate ? `Next on ${formatDate(visits.nextVisitDate)}` : 'None scheduled') : NO_ACCESS('the AMC schedule')}
      />
      <Metric
        label="Overdue visits"
        value={visits ? formatCount(visits.overdue) : null}
        tone={visits && visits.overdue > 0 ? 'warn' : 'default'}
        hint={visits ? 'Open visits dated before today' : NO_ACCESS('the AMC schedule')}
      />
    </dl>
  )
}

function UpcomingSchedule({ upcoming }: { upcoming: NonNullable<EngineerSummary['upcoming']> }) {
  if (upcoming.items.length === 0) return <EmptyState title="No upcoming visits" description="No open visit is scheduled from today on this engineer’s contracts." />

  return (
    <>
      <div className={TABLE.wrapper}>
        <table className={TABLE.table}>
          <caption className="sr-only">Upcoming work schedule</caption>
          <thead>
            <tr>
              {['Scheduled date', 'Client', 'System', 'Visit', 'Assigned to', 'Status'].map((label) => (
                <th key={label} scope="col" className={TABLE.th}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {upcoming.items.map((visit) => (
              <tr key={visit.id}>
                <td className={`${TABLE.td} whitespace-nowrap`}>{formatDate(visit.scheduledDate)}</td>
                <td className={TABLE.td}>{visit.contract.clientName}</td>
                <td className={TABLE.td}>
                  <Link to={`/amc/contracts/${visit.contract.id}`} className="font-medium text-blue-700 hover:underline">
                    {visit.contract.systemDescription}
                  </Link>
                </td>
                <td className={`${TABLE.td} whitespace-nowrap tabular-nums`}>No. {visit.sequenceNo}</td>
                <td className={TABLE.td}>
                  <OrDash value={visit.assignedTo} />
                </td>
                <td className={TABLE.td}>
                  <VisitStatusPill status={visit.status as VisitStatus} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {upcoming.total > upcoming.items.length && (
        <p className="border-t border-slate-200 px-6 py-3 text-sm text-slate-600">
          Showing the next {upcoming.items.length} of {upcoming.total} upcoming visits. The full list is in the AMC Schedule.
        </p>
      )}
    </>
  )
}

/** Engineer 360: details, figures from the linked AMC contracts and their visits, the contracts, the upcoming work and history. */
export function SalesEngineerDetailPage() {
  const { id = '' } = useParams()
  const auth = useAuth()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [confirmStatus, setConfirmStatus] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const query = useQuery({ queryKey: ['masters', 'sales-engineers', 'detail', id], queryFn: () => api.get<EngineerRecord>(`/masters/sales-engineers/${id}`), retry: false })
  const summary = useQuery({
    queryKey: ['masters', 'sales-engineers', 'summary', id],
    queryFn: () => api.get<EngineerSummary>(`/masters/sales-engineers/${id}/summary`),
    enabled: query.isSuccess,
    retry: false,
  })
  const toggle = useMutation({
    mutationFn: (engineer: EngineerRecord) => api.post<EngineerRecord>(`/masters/sales-engineers/${engineer.id}/status`, { isActive: !engineer.isActive }),
    onSuccess: async (saved) => {
      setConfirmStatus(false)
      await queryClient.invalidateQueries({ queryKey: ['masters'] })
      setNotice(`${saved.name} is now ${ENGINEER_STATUS_LABELS[saved.isActive ? 'active' : 'inactive']}.`)
    },
  })

  const back = (
    <Link to="/master-data/sales-engineers" className="text-sm font-medium text-blue-700 hover:underline">
      ← All sales engineers
    </Link>
  )

  if (query.isPending) return <Spinner label="Loading sales engineer" />

  if (query.isError) {
    const missing = query.error instanceof ApiError && query.error.status === 404

    return (
      <>
        <div className="mb-4">{back}</div>
        <Card>
          {isFeatureUnavailable(query.error) ? (
            <div className="p-5">
              <Alert tone="info">Sales engineers need a database update that has not been applied to this database yet (migration 0070).</Alert>
            </div>
          ) : missing ? (
            <EmptyState title="Sales engineer not found" description="It may have been opened from an old link." />
          ) : (
            <LoadError error={query.error} onRetry={() => void query.refetch()} />
          )}
        </Card>
      </>
    )
  }

  const engineer = query.data
  const canEdit = auth.can('SETTINGS', 'EDIT')

  return (
    <>
      <div className="mb-4">{back}</div>
      <PageHeader
        title={engineer.name}
        description={`${engineer.code} · Engineer 360: details, assigned AMC contracts, upcoming work and history.`}
        actions={
          canEdit && (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setConfirmStatus(true)}>
                {engineer.isActive ? 'Disable' : 'Enable'}
              </Button>
              <Button variant="secondary" onClick={() => setEditing(true)}>
                Edit
              </Button>
            </div>
          )
        }
      />

      {notice && (
        <div className="mb-4">
          <Alert tone="success" onDismiss={() => setNotice(null)}>
            {notice}
          </Alert>
        </div>
      )}

      <div className="space-y-6">
        <Section id="engineer-details-heading" title="Details">
          <dl className="grid gap-x-8 px-6 py-4 lg:grid-cols-2">
            <div>
              <DetailRow label="Engineer code">
                <span className="font-mono text-sm font-semibold">{engineer.code}</span>
              </DetailRow>
              <DetailRow label="Engineer name">{engineer.name}</DetailRow>
              <DetailRow label="Employee number">
                <OrDash value={engineer.employeeNo} />
              </DetailRow>
              <DetailRow label="Department">{engineer.department ? `${engineer.department.code} — ${engineer.department.name}` : 'None'}</DetailRow>
              <DetailRow label="Status">
                <EngineerStatusBadge active={engineer.isActive} />
              </DetailRow>
            </div>
            <div>
              <DetailRow label="Email">{engineer.email ? <a href={`mailto:${engineer.email}`} className="text-blue-700 hover:underline">{engineer.email}</a> : <OrDash value={null} />}</DetailRow>
              <DetailRow label="Phone">
                <OrDash value={engineer.phone} />
              </DetailRow>
              <DetailRow label="User account">{engineer.user ? `${engineer.user.fullName} (${engineer.user.email})` : 'Not linked'}</DetailRow>
              <DetailRow label="Notes">
                <OrDash value={engineer.notes} />
              </DetailRow>
              <DetailRow label="Added">{formatDateTime(engineer.createdAt)}</DetailRow>
              <DetailRow label="Last updated">{formatDateTime(engineer.updatedAt)}</DetailRow>
            </div>
          </dl>
        </Section>

        <section aria-label="Engineer figures summary">
          {summary.isPending && <Spinner size="sm" label="Loading figures" />}
          {summary.isError && <LoadError error={summary.error} onRetry={() => void summary.refetch()} />}
          {summary.data && (
            <>
              <SummaryStrip summary={summary.data} />
              <p className="mt-2 text-xs text-slate-500">
                As of {formatDate(summary.data.asOf)}. Counted from contracts linked to this engineer in the master list; contracts that only carry the engineer’s name as typed text are not
                included.
              </p>
            </>
          )}
        </section>

        <Section id="engineer-contracts-heading" title="AMC contracts" description="Assigned to this engineer, every status. Contracts keep their engineer when the engineer is disabled.">
          <LinkedContracts filter={{ salesEngineerId: engineer.id }} emptyTitle="No AMC contracts assigned to this engineer" />
        </Section>

        <Section id="engineer-schedule-heading" title="Upcoming work schedule" description="Open visits from today on this engineer’s contracts, soonest first.">
          {summary.data &&
            (summary.data.upcoming ? <UpcomingSchedule upcoming={summary.data.upcoming} /> : <p className="px-6 py-4 text-sm text-slate-600">{NO_ACCESS('the AMC schedule')}</p>)}
          {summary.isPending && <Spinner size="sm" label="Loading visits" />}
        </Section>

        <Section id="engineer-history-heading" title="History">
          <RecordHistory
            path={`/masters/sales-engineers/${engineer.id}/history`}
            queryKey={['masters', 'sales-engineers', 'history', engineer.id]}
            actionLabels={ACTION_LABELS}
            fieldLabels={FIELD_LABELS}
            emptyTitle="No history recorded for this engineer"
          />
        </Section>
      </div>

      {editing && (
        <SalesEngineerFormModal
          engineer={engineer}
          onClose={() => setEditing(false)}
          onSaved={(message) => {
            setNotice(message)
            setEditing(false)
          }}
        />
      )}
      {confirmStatus && (
        <ConfirmDialog
          title={engineer.isActive ? 'Disable sales engineer' : 'Enable sales engineer'}
          message={engineer.isActive ? <AssignmentWarning engineer={engineer} /> : `${engineer.name} will be offered again for new AMC assignments.`}
          confirmLabel={engineer.isActive ? 'Disable' : 'Enable'}
          danger={engineer.isActive}
          loading={toggle.isPending}
          error={toggle.isError ? errorMessage(toggle.error) : null}
          onConfirm={() => toggle.mutate(engineer)}
          onCancel={() => {
            toggle.reset()
            setConfirmStatus(false)
          }}
        />
      )}
    </>
  )
}

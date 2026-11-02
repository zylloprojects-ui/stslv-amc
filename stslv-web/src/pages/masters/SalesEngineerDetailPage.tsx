import { ContractLink } from '../../components/ContractLink'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../../auth/context'
import { LinkedContracts } from '../../components/LinkedContracts'
import { PageTabs, TabPanel, useTabsLayout } from '../../components/PageTabs'
import { ContactChip } from '../../components/ProfileParts'
import { LoadError, OrDash } from '../../components/records'
import { RecordHistory } from '../../components/RecordHistory'
import { TABLE } from '../../components/table'
import { Alert, BannerButton, Card, ConfirmDialog, EmptyState, PageHeader, Spinner } from '../../components/ui'
import { api, ApiError, errorMessage } from '../../lib/api'
import { cx, formatCount, formatDate, formatDateTime } from '../../lib/format'
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

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')

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
                <td className={`${TABLE.td} whitespace-nowrap font-semibold text-[#0b3b66]`}>{formatDate(visit.scheduledDate)}</td>
                <td className={TABLE.td}>{visit.contract.clientName}</td>
                <td className={TABLE.td}>
                  <ContractLink id={visit.contract.id} className="font-semibold text-[#0b3b66] hover:text-[#1479BD] hover:underline">
                    {visit.contract.systemDescription}
                  </ContractLink>
                </td>
                <td className={`${TABLE.td} whitespace-nowrap tabular-nums`}>
                  <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-700">No. {visit.sequenceNo}</span>
                </td>
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

interface Stat {
  label: string
  value: ReactNode | null
  hint: ReactNode
  warn?: boolean
}

function engineerStats(summary: EngineerSummary): Stat[] {
  const { contracts, visits } = summary

  return [
    { label: 'Assigned AMC contracts', value: contracts ? formatCount(contracts.total) : null, hint: contracts ? `${contracts.draft} draft · ${contracts.expired} expired · ${contracts.cancelled} cancelled` : NO_ACCESS('AMC contracts') },
    { label: 'Active AMC contracts', value: contracts ? formatCount(contracts.active) : null, hint: contracts ? 'Status Active' : NO_ACCESS('AMC contracts') },
    { label: 'Active AMC value', value: contracts ? formatMoney(contracts.activeValue) : null, hint: contracts ? 'Contract value of active contracts' : NO_ACCESS('AMC contracts') },
    { label: 'Upcoming visits', value: visits ? formatCount(visits.upcoming) : null, hint: visits ? (visits.nextVisitDate ? `Next on ${formatDate(visits.nextVisitDate)}` : 'None scheduled') : NO_ACCESS('the AMC schedule') },
    { label: 'Overdue visits', value: visits ? formatCount(visits.overdue) : null, hint: visits ? 'Open visits dated before today' : NO_ACCESS('the AMC schedule'), warn: !!visits && visits.overdue > 0 },
  ]
}

/** The five figures as one slim bar with dividers. A figure the viewer may not see says so, never zero. */
function StatBar({ summary }: { summary: EngineerSummary }) {
  return (
    <dl className="grid grid-cols-2 divide-x divide-y divide-slate-200 lg:grid-cols-5 lg:divide-y-0" aria-label="Engineer figures">
      {engineerStats(summary).map((stat) => (
        <div key={stat.label} className={cx('min-w-0 px-5 py-4', stat.warn && 'bg-amber-50/60')}>
          <dt className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">{stat.label}</dt>
          <dd className={cx('mt-1.5 tabular-nums', stat.value === null ? 'text-base font-bold text-slate-400' : 'text-2xl font-bold leading-none text-[#0b3b66]')}>{stat.value === null ? 'Not available' : stat.value}</dd>
          <dd className={cx('mt-1.5 text-xs leading-snug', stat.warn ? 'text-amber-700' : 'text-slate-500')}>{stat.hint}</dd>
        </div>
      ))}
    </dl>
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
  const [tab, setTab] = useState<'contracts' | 'work' | 'history'>('contracts')
  const layout = useTabsLayout()
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
    <Link to="/master-data/sales-engineers" className="inline-flex items-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-[#0b3b66] shadow-sm hover:bg-sky-50">
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
  const canEdit = auth.can('SALES_ENGINEERS', 'EDIT')

  const PANEL: Record<typeof tab, [string, string]> = {
    contracts: ['AMC contracts', 'Contracts this engineer is responsible for.'],
    work: ['Upcoming work', 'Visits scheduled for this engineer’s contracts.'],
    history: ['History', 'Every change made to this engineer record.'],
  }

  const tabsBlock = (
    <div className={layout.wrapper}>
      <PageTabs
        label="Engineer records"
        idPrefix="engineer-tab"
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'contracts', label: 'AMC contracts', count: summary.data?.contracts?.total },
          { id: 'work', label: 'Upcoming work', count: summary.data?.upcoming?.total },
          { id: 'history', label: 'History' },
        ]}
      />
      <TabPanel idPrefix="engineer-tab" active={tab} title={PANEL[tab][0]} description={PANEL[tab][1]}>
        <div>
          {tab === 'contracts' && <LinkedContracts filter={{ salesEngineerId: engineer.id }} emptyTitle="No AMC contracts assigned to this engineer" />}
          {tab === 'work' && (
            <>
              {summary.data && (summary.data.upcoming ? <UpcomingSchedule upcoming={summary.data.upcoming} /> : <p className="px-6 py-4 text-sm text-slate-600">{NO_ACCESS('the AMC schedule')}</p>)}
              {summary.isPending && <Spinner size="sm" label="Loading visits" />}
            </>
          )}
          {tab === 'history' && (
            <RecordHistory
              path={`/masters/sales-engineers/${engineer.id}/history`}
              queryKey={['masters', 'sales-engineers', 'history', engineer.id]}
              actionLabels={ACTION_LABELS}
              fieldLabels={FIELD_LABELS}
              emptyTitle="No history recorded for this engineer"
            />
          )}
        </div>
      </TabPanel>
    </div>
  )

  const statSection = (
    <section aria-label="Engineer figures summary">
      {summary.isPending && <Spinner size="sm" label="Loading figures" />}
      {summary.isError && <LoadError error={summary.error} onRetry={() => void summary.refetch()} />}
      {summary.data && (
        <Card className="rounded-2xl">
          <StatBar summary={summary.data} />
        </Card>
      )}
    </section>
  )

  return (
    <>
      <div className="mb-4">{back}</div>
      <PageHeader
        title={engineer.name}
        description={`${engineer.code} · Engineer 360: details, assigned AMC contracts, upcoming work and history.`}
        actions={
          canEdit && (
            <>
              <BannerButton onClick={() => setEditing(true)}>Edit</BannerButton>
              <BannerButton danger={engineer.isActive} onClick={() => setConfirmStatus(true)}>
                {engineer.isActive ? 'Disable' : 'Enable'}
              </BannerButton>
            </>
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
        <Card className="rounded-2xl">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-4 p-5">
            <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-[#0a3a66] to-[#2f9bd8] text-xl font-bold tracking-wide text-white shadow-md" aria-hidden="true">
              {initialsOf(engineer.name)}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-md bg-sky-50 px-2 py-0.5 font-mono text-xs font-bold text-[#0b3b66] ring-1 ring-inset ring-sky-200">{engineer.code}</span>
                <EngineerStatusBadge active={engineer.isActive} />
              </div>
              <p className="mt-1.5 text-sm font-semibold text-slate-700">{engineer.department ? `${engineer.department.code} — ${engineer.department.name}` : 'No department'}</p>
            </div>
            <dl className="grid min-w-0 flex-1 basis-[30rem] gap-3 sm:grid-cols-2 2xl:grid-cols-4">
              <ContactChip icon="badge" label="Employee number">
                <OrDash value={engineer.employeeNo} />
              </ContactChip>
              <ContactChip icon="mail" label="Email" wrap>
                {engineer.email ? (
                  <a href={`mailto:${engineer.email}`} title={engineer.email} className="text-[#1479BD] hover:underline">
                    {engineer.email}
                  </a>
                ) : (
                  <OrDash value={null} />
                )}
              </ContactChip>
              <ContactChip icon="phone" label="Phone">
                <OrDash value={engineer.phone} />
              </ContactChip>
              <ContactChip icon="user" label="User account">
                {engineer.user ? engineer.user.fullName : 'Not linked'}
              </ContactChip>
            </dl>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-t border-slate-200 bg-slate-50/70 px-5 py-2.5 text-xs text-slate-600">
            <p className="min-w-0">{engineer.notes ? <><span className="font-bold text-slate-700">Notes:</span> {engineer.notes}</> : <span className="text-slate-400">No notes</span>}</p>
            <p>
              Added {formatDateTime(engineer.createdAt)} · Updated {formatDateTime(engineer.updatedAt)}
            </p>
          </div>
        </Card>

        {statSection}

        {tabsBlock}
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

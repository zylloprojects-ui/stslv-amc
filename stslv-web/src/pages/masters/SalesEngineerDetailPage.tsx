import { useQuery } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../../auth/context'
import { LinkedContracts } from '../../components/LinkedContracts'
import { DetailRow, LoadError, OrDash } from '../../components/records'
import { RecordHistory } from '../../components/RecordHistory'
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Spinner } from '../../components/ui'
import { api, ApiError } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { MasterFormModal, type AnyRecord } from './MasterDataPage'
import { isFeatureUnavailable, type SalesEngineer } from './masterTypes'

const ACTION_LABELS: Record<string, string> = {
  'sales_engineer.created': 'Sales engineer added',
  'sales_engineer.updated': 'Sales engineer updated',
  'sales_engineer.deactivated': 'Sales engineer deactivated',
  'sales_engineer.reactivated': 'Sales engineer reactivated',
}

const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  employeeNo: 'Employee number',
  email: 'Email',
  phone: 'Phone',
  departmentId: 'Department',
  userId: 'Sign-in account',
  notes: 'Notes',
  isActive: 'Active',
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <Card>
      <section aria-labelledby={id}>
        <h2 id={id} className="border-b border-slate-200 px-6 py-4 text-base font-semibold text-slate-900">
          {title}
        </h2>
        {children}
      </section>
    </Card>
  )
}

/** One sales engineer: details, the AMC contracts linked to them, and history. */
export function SalesEngineerDetailPage() {
  const { id = '' } = useParams()
  const auth = useAuth()
  const [editing, setEditing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const query = useQuery({ queryKey: ['masters', 'sales-engineers', 'detail', id], queryFn: () => api.get<SalesEngineer>(`/masters/sales-engineers/${id}`), retry: false })

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

  return (
    <>
      <div className="mb-4">{back}</div>
      <PageHeader
        title={engineer.name}
        description="Sales engineer: details, linked AMC contracts and history."
        actions={
          auth.can('SETTINGS', 'EDIT') && (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Edit
            </Button>
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
              <DetailRow label="Name">{engineer.name}</DetailRow>
              <DetailRow label="Status">
                <Badge tone={engineer.isActive ? 'green' : 'slate'}>{engineer.isActive ? 'Active' : 'Inactive'}</Badge>
              </DetailRow>
              <DetailRow label="Employee number">
                <OrDash value={engineer.employeeNo} />
              </DetailRow>
              <DetailRow label="Department">{engineer.department ? `${engineer.department.code} — ${engineer.department.name}` : <OrDash value={null} />}</DetailRow>
              <DetailRow label="Sign-in account">{engineer.user ? `${engineer.user.fullName} (${engineer.user.email})` : 'Not linked'}</DetailRow>
            </div>
            <div>
              <DetailRow label="Email">
                <OrDash value={engineer.email} />
              </DetailRow>
              <DetailRow label="Phone">
                <OrDash value={engineer.phone} />
              </DetailRow>
              <DetailRow label="Notes">
                <OrDash value={engineer.notes} />
              </DetailRow>
              <DetailRow label="Added">{formatDateTime(engineer.createdAt)}</DetailRow>
              <DetailRow label="Last updated">{formatDateTime(engineer.updatedAt)}</DetailRow>
            </div>
          </dl>
        </Section>

        <Section id="engineer-contracts-heading" title="AMC contracts">
          <p className="px-6 pt-3 text-sm text-slate-600">Contracts linked to this engineer in the master list. Contracts that only have the engineer’s name typed in are not linked automatically.</p>
          <LinkedContracts filter={{ salesEngineerId: engineer.id }} emptyTitle="No AMC contracts linked to this engineer" />
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
        <MasterFormModal
          tab="sales-engineers"
          record={engineer as AnyRecord}
          onClose={() => setEditing(false)}
          onSaved={(message) => {
            setNotice(message)
            setEditing(false)
          }}
        />
      )}
    </>
  )
}

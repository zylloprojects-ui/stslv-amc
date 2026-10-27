import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../../auth/context'
import { LinkedContracts } from '../../components/LinkedContracts'
import { DetailRow, LoadError, OrDash } from '../../components/records'
import { RecordHistory } from '../../components/RecordHistory'
import { Alert, Button, Card, ConfirmDialog, EmptyState, PageHeader, Spinner, StatusBadge } from '../../components/ui'
import { api, ApiError, errorMessage } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { CLIENT_TYPE_LABELS, type Client, type ClientFeatures, type ClientType } from '../../lib/types'
import { ClientFormModal } from './ClientFormModal'

const ACTION_LABELS: Record<string, string> = {
  'client.created': 'Client added',
  'client.updated': 'Client updated',
  'client.deactivated': 'Client deactivated',
  'client.reactivated': 'Client reactivated',
}

const FIELD_LABELS: Record<string, string> = {
  name: 'Client name',
  contactPerson: 'Contact person',
  email: 'Email',
  phone: 'Phone',
  address: 'Address',
  notes: 'Notes',
  clientType: 'Client type',
  vatNumber: 'VAT number',
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

/** One client: details, its AMC contracts and its history, with edit and deactivate. */
export function ClientDetailPage() {
  const { id = '' } = useParams()
  const auth = useAuth()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [confirmToggle, setConfirmToggle] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const query = useQuery({ queryKey: ['clients', 'detail', id], queryFn: () => api.get<Client>(`/clients/${id}`) })
  const features = useQuery({ queryKey: ['clients', 'features'], queryFn: () => api.get<ClientFeatures>('/clients/features'), staleTime: 60_000 })
  const toggle = useMutation({
    mutationFn: (client: Client) => api.post<Client>(`/clients/${client.id}/${client.isActive ? 'deactivate' : 'reactivate'}`),
    onSuccess: async (updated) => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['clients'] }), queryClient.invalidateQueries({ queryKey: ['dashboard'] })])
      setNotice(`${updated.name} was ${updated.isActive ? 'reactivated' : 'deactivated'}.`)
      setConfirmToggle(false)
    },
  })

  const back = (
    <Link to="/clients" className="text-sm font-medium text-blue-700 hover:underline">
      ← All clients
    </Link>
  )

  if (query.isPending) return <Spinner label="Loading client" />

  if (query.isError) {
    const missing = query.error instanceof ApiError && query.error.status === 404

    return (
      <>
        <div className="mb-4">{back}</div>
        <Card>{missing ? <EmptyState title="Client not found" description="It may have been opened from an old link." /> : <LoadError error={query.error} onRetry={() => void query.refetch()} />}</Card>
      </>
    )
  }

  const client = query.data
  const withDetails = features.data?.clientDetails === true

  return (
    <>
      <div className="mb-4">{back}</div>

      <PageHeader
        title={client.name}
        description="Client master record: details, AMC contracts and history."
        actions={
          <>
            {auth.can('CLIENTS', 'EDIT') && (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
            {auth.can('CLIENTS', 'DELETE') && (
              <Button variant={client.isActive ? 'danger' : 'secondary'} onClick={() => setConfirmToggle(true)}>
                {client.isActive ? 'Deactivate' : 'Reactivate'}
              </Button>
            )}
          </>
        }
      />

      {notice && (
        <div className="mb-4">
          <Alert tone="success" onDismiss={() => setNotice(null)}>
            {notice}
          </Alert>
        </div>
      )}
      {!client.isActive && (
        <div className="mb-4">
          <Alert tone="info">This client is inactive. Its contracts and history stay as they are; it cannot be chosen for new contracts or projects.</Alert>
        </div>
      )}

      <div className="space-y-6">
        <Section id="client-details-heading" title="Client details">
          <dl className="grid gap-x-8 px-6 py-4 lg:grid-cols-2">
            <div>
              <DetailRow label="Client name">{client.name}</DetailRow>
              <DetailRow label="Status">
                <StatusBadge active={client.isActive} />
              </DetailRow>
              {withDetails && <DetailRow label="Client type">{client.clientType ? CLIENT_TYPE_LABELS[client.clientType] : <OrDash value={null} />}</DetailRow>}
              {withDetails && (
                <DetailRow label="VAT number">
                  <OrDash value={client.vatNumber ?? null} />
                </DetailRow>
              )}
              <DetailRow label="Contact person">
                <OrDash value={client.contactPerson} />
              </DetailRow>
            </div>
            <div>
              <DetailRow label="Phone">
                <OrDash value={client.phone} />
              </DetailRow>
              <DetailRow label="Email">
                <OrDash value={client.email} />
              </DetailRow>
              <DetailRow label="Address">
                <OrDash value={client.address} />
              </DetailRow>
              <DetailRow label="Notes">
                <OrDash value={client.notes} />
              </DetailRow>
              <DetailRow label="Added">{formatDateTime(client.createdAt)}</DetailRow>
              <DetailRow label="Last updated">{formatDateTime(client.updatedAt)}</DetailRow>
            </div>
          </dl>
        </Section>

        <Section id="client-contracts-heading" title="AMC contracts">
          <LinkedContracts filter={{ clientId: client.id }} emptyTitle="No AMC contracts for this client" />
        </Section>

        <Section id="client-history-heading" title="History">
          <RecordHistory
            path={`/clients/${client.id}/history`}
            queryKey={['clients', 'history', client.id]}
            actionLabels={ACTION_LABELS}
            fieldLabels={FIELD_LABELS}
            formatValue={(field, value) => (field === 'clientType' && typeof value === 'string' ? (CLIENT_TYPE_LABELS[value as ClientType] ?? null) : null)}
            emptyTitle="No history recorded for this client"
          />
        </Section>
      </div>

      {editing && (
        <ClientFormModal
          client={client}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setNotice(`${saved.name} was updated.`)
            setEditing(false)
          }}
        />
      )}
      {confirmToggle && (
        <ConfirmDialog
          title={client.isActive ? 'Deactivate client' : 'Reactivate client'}
          message={
            client.isActive
              ? `${client.name} will no longer be offered for new contracts and projects. Existing contracts, projects and history are kept.`
              : `${client.name} will be offered again for new contracts and projects.`
          }
          confirmLabel={client.isActive ? 'Deactivate' : 'Reactivate'}
          danger={client.isActive}
          loading={toggle.isPending}
          error={toggle.isError ? errorMessage(toggle.error) : null}
          onConfirm={() => toggle.mutate(client)}
          onCancel={() => {
            toggle.reset()
            setConfirmToggle(false)
          }}
        />
      )}
    </>
  )
}

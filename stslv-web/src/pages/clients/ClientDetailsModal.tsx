import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Alert, Button, Modal, Spinner, StatusBadge } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import type { Client } from '../../lib/types'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="gap-4 py-2.5 sm:grid sm:grid-cols-3">
      <dt className="text-sm font-medium text-slate-600">{label}</dt>
      <dd className="mt-0.5 whitespace-pre-wrap break-words text-sm text-slate-900 sm:col-span-2 sm:mt-0">{children}</dd>
    </div>
  )
}

const orDash = (value: string | null) => value ?? <span className="text-slate-400">—</span>

interface ClientDetailsModalProps {
  clientId: string
  canEdit: boolean
  onEdit: (client: Client) => void
  onClose: () => void
}

export function ClientDetailsModal({ clientId, canEdit, onEdit, onClose }: ClientDetailsModalProps) {
  // Always read the record again, so the details shown are the stored values.
  const query = useQuery({ queryKey: ['clients', 'detail', clientId], queryFn: () => api.get<Client>(`/clients/${clientId}`) })
  const client = query.data

  return (
    <Modal
      title="Client details"
      onClose={onClose}
      size="lg"
      footer={
        <>
          {canEdit && client && (
            <Button variant="secondary" onClick={() => onEdit(client)}>
              Edit
            </Button>
          )}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {query.isPending && <Spinner label="Loading client" />}
      {query.isError && <Alert>{errorMessage(query.error)}</Alert>}
      {client && (
        <dl className="divide-y divide-slate-100">
          <Row label="Client name">{client.name}</Row>
          <Row label="Status">
            <StatusBadge active={client.isActive} />
          </Row>
          <Row label="Contact person">{orDash(client.contactPerson)}</Row>
          <Row label="Phone">{orDash(client.phone)}</Row>
          <Row label="Email">{orDash(client.email)}</Row>
          <Row label="Address">{orDash(client.address)}</Row>
          <Row label="Notes">{orDash(client.notes)}</Row>
          <Row label="Created">{formatDateTime(client.createdAt)}</Row>
          <Row label="Last updated">{formatDateTime(client.updatedAt)}</Row>
        </dl>
      )}
    </Modal>
  )
}

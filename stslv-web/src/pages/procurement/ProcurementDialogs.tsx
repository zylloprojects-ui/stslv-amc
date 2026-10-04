import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { DetailRow, Money, OrDash, ProcurementStatusBadge } from '../../components/records'
import { Alert, Button, Modal, SelectField, Spinner, TextField } from '../../components/ui'
import { api, ApiError, errorMessage } from '../../lib/api'
import { formatDate, formatDateTime, todayIso } from '../../lib/format'
import { projectLabel } from '../../lib/projectOptions'
import { PROCUREMENT_STATUSES, PROCUREMENT_STATUS_LABELS, type ProcurementRequest, type ProcurementStatus } from '../../lib/projectTypes'
import { ProcurementFormModal, type FixedProject } from './ProcurementFormModal'

export type ProcurementDialog =
  | { kind: 'none' }
  | { kind: 'create' }
  | { kind: 'edit'; request: ProcurementRequest }
  | { kind: 'view'; requestId: string }
  | { kind: 'status'; request: ProcurementRequest }

interface ProcurementDialogsProps {
  dialog: ProcurementDialog
  setDialog: (dialog: ProcurementDialog) => void
  fixedProject?: FixedProject | undefined
  canEdit: boolean
  onNotice: (message: string) => void
}

/** The add, edit, view and status dialogs, shared by the Procurement page and the project page. */
export function ProcurementDialogs({ dialog, setDialog, fixedProject, canEdit, onNotice }: ProcurementDialogsProps) {
  const close = () => setDialog({ kind: 'none' })

  if (dialog.kind === 'create' || dialog.kind === 'edit') {
    const editing = dialog.kind === 'edit'

    return (
      <ProcurementFormModal
        request={editing ? dialog.request : null}
        fixedProject={fixedProject}
        onClose={close}
        onSaved={(saved) => {
          onNotice(editing ? `Procurement request on ${saved.jobNumber} was updated.` : `Procurement request added to ${saved.jobNumber}.`)
          close()
        }}
      />
    )
  }

  if (dialog.kind === 'view') {
    return (
      <ProcurementDetailsModal
        requestId={dialog.requestId}
        canEdit={canEdit}
        onEdit={(request) => setDialog({ kind: 'edit', request })}
        onClose={close}
      />
    )
  }

  if (dialog.kind === 'status') {
    return (
      <ProcurementStatusDialog
        request={dialog.request}
        onClose={close}
        onChanged={(updated) => {
          onNotice(`Procurement request on ${updated.jobNumber} is now ${PROCUREMENT_STATUS_LABELS[updated.status]}.`)
          close()
        }}
      />
    )
  }

  return null
}

interface ProcurementDetailsModalProps {
  requestId: string
  canEdit: boolean
  onEdit: (request: ProcurementRequest) => void
  onClose: () => void
}

function ProcurementDetailsModal({ requestId, canEdit, onEdit, onClose }: ProcurementDetailsModalProps) {
  // Always read the record again, so the details shown are the stored values.
  const query = useQuery({
    queryKey: ['procurement', 'detail', requestId],
    queryFn: () => api.get<ProcurementRequest>(`/procurement/${requestId}`),
  })
  const request = query.data

  return (
    <Modal
      title="Procurement request"
      onClose={onClose}
      size="lg"
      footer={
        <>
          {canEdit && request && request.status !== 'CANCELLED' && (
            <Button variant="secondary" onClick={() => onEdit(request)}>
              Edit
            </Button>
          )}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {query.isPending && <Spinner size="sm" label="Loading request" />}
      {query.isError && <Alert>{errorMessage(query.error)}</Alert>}
      {request && (
        <dl>
          <DetailRow label="Project / job">
            {projectLabel({ jobNumber: request.jobNumber, clientName: request.clientName, description: request.projectDescription })}
          </DetailRow>
          <DetailRow label="Status">
            <ProcurementStatusBadge status={request.status} />
          </DetailRow>
          <DetailRow label="Requirement">{request.description}</DetailRow>
          <DetailRow label="Request date">{formatDate(request.requestDate)}</DetailRow>
          <DetailRow label="Request reference">
            <OrDash value={request.reference} />
          </DetailRow>
          <DetailRow label="Supplier">
            <OrDash value={request.supplierName} />
          </DetailRow>
          <DetailRow label="Quotation reference">
            <OrDash value={request.quotationReference} />
          </DetailRow>
          <DetailRow label="Quotation date">{formatDate(request.quotationDate)}</DetailRow>
          <DetailRow label="Quotation amount">
            <Money value={request.quotationAmount} />
          </DetailRow>
          <DetailRow label="Order / PO reference">
            <OrDash value={request.poReference} />
          </DetailRow>
          <DetailRow label="Order date">{formatDate(request.orderDate)}</DetailRow>
          <DetailRow label="Expected delivery">{formatDate(request.expectedDeliveryDate)}</DetailRow>
          <DetailRow label="Delivered">{formatDate(request.deliveredDate)}</DetailRow>
          <DetailRow label="Notes">
            <OrDash value={request.notes} />
          </DetailRow>
          <DetailRow label="Created">{formatDateTime(request.createdAt)}</DetailRow>
          <DetailRow label="Last updated">{formatDateTime(request.updatedAt)}</DetailRow>
        </dl>
      )}
    </Modal>
  )
}

interface ProcurementStatusDialogProps {
  request: ProcurementRequest
  onClose: () => void
  onChanged: (request: ProcurementRequest) => void
}

function ProcurementStatusDialog({ request, onClose, onChanged }: ProcurementStatusDialogProps) {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<ProcurementStatus>(request.status)
  const [deliveredDate, setDeliveredDate] = useState(request.deliveredDate ?? todayIso())
  const [dateError, setDateError] = useState<string | null>(null)
  const delivered = status === 'DELIVERED'

  const change = useMutation({
    mutationFn: () =>
      api.post<ProcurementRequest>(`/procurement/${request.id}/status`, delivered ? { status, deliveredDate } : { status }),
    onSuccess: async (updated) => {
      await queryClient.invalidateQueries({ queryKey: ['procurement'] })
      onChanged(updated)
    },
    onError: (error) => {
      const detail = error instanceof ApiError ? error.details.find((item) => item.field === 'deliveredDate') : undefined
      setDateError(detail?.message ?? null)
    },
  })

  const confirm = () => {
    if (delivered && deliveredDate === '') {
      setDateError('Delivered date is required.')
      return
    }
    setDateError(null)
    change.mutate()
  }

  return (
    <Modal
      title="Update procurement status"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={change.isPending}>
            Cancel
          </Button>
          <Button onClick={confirm} loading={change.isPending}>
            Update status
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-slate-700">
        <p>
          <strong>{request.jobNumber}</strong> — {request.description}
        </p>
        <SelectField label="Status" value={status} onChange={(event) => setStatus(event.target.value as ProcurementStatus)}>
          {PROCUREMENT_STATUSES.map((value) => (
            <option key={value} value={value}>
              {PROCUREMENT_STATUS_LABELS[value]}
            </option>
          ))}
        </SelectField>
        {delivered && (
          <TextField
            label="Delivered date"
            type="date"
            required
            value={deliveredDate}
            onChange={(event) => setDeliveredDate(event.target.value)}
            error={dateError ?? undefined}
          />
        )}
        {status === 'CANCELLED' && <p>A cancelled request is kept for the record but can no longer be edited.</p>}
        {change.isError && !dateError && <Alert>{errorMessage(change.error)}</Alert>}
      </div>
    </Modal>
  )
}

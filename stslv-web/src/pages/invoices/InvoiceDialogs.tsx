import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { DetailRow, Money, OrDash } from '../../components/records'
import { Alert, Button, Modal, Spinner, TextAreaField } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { formatDate, formatDateTime } from '../../lib/format'
import { allocationLabel, type Invoice } from '../../lib/invoiceTypes'
import { formatMoney } from '../../lib/money'
import { InvoiceFormModal, type InvoicePreset } from './InvoiceFormModal'
import { InvoiceStatusBadge } from './InvoicesTable'

export type InvoiceDialog =
  | { kind: 'none' }
  | { kind: 'create'; preset?: InvoicePreset }
  | { kind: 'edit'; invoice: Invoice }
  | { kind: 'view'; invoiceId: string }
  | { kind: 'cancel'; invoice: Invoice }

interface InvoiceDialogsProps {
  dialog: InvoiceDialog
  setDialog: (dialog: InvoiceDialog) => void
  canEdit: boolean
  onNotice: (message: string) => void
}

/** The record, edit, view and cancel dialogs, shared by Invoice Tracking and the project page. */
export function InvoiceDialogs({ dialog, setDialog, canEdit, onNotice }: InvoiceDialogsProps) {
  const close = () => setDialog({ kind: 'none' })

  if (dialog.kind === 'create' || dialog.kind === 'edit') {
    const editing = dialog.kind === 'edit'

    return (
      <InvoiceFormModal
        invoice={editing ? dialog.invoice : null}
        preset={editing ? undefined : dialog.preset}
        onClose={close}
        onSaved={(saved) => {
          onNotice(
            editing
              ? `Invoice ${saved.invoiceNumber} was updated.`
              : `Invoice ${saved.invoiceNumber} of ${formatMoney(saved.amountExclVat)} excl. VAT recorded for ${saved.client.name}.`,
          )
          close()
        }}
      />
    )
  }

  if (dialog.kind === 'view') {
    return (
      <InvoiceDetailsModal
        invoiceId={dialog.invoiceId}
        canEdit={canEdit}
        onEdit={(invoice) => setDialog({ kind: 'edit', invoice })}
        onCancel={(invoice) => setDialog({ kind: 'cancel', invoice })}
        onClose={close}
      />
    )
  }

  if (dialog.kind === 'cancel') {
    return (
      <CancelInvoiceDialog
        invoice={dialog.invoice}
        onClose={close}
        onCancelled={(cancelled) => {
          onNotice(`Invoice ${cancelled.invoiceNumber} was cancelled. The work it covered is ready for invoice again.`)
          close()
        }}
      />
    )
  }

  return null
}

interface InvoiceDetailsModalProps {
  invoiceId: string
  canEdit: boolean
  onEdit: (invoice: Invoice) => void
  onCancel: (invoice: Invoice) => void
  onClose: () => void
}

function InvoiceDetailsModal({ invoiceId, canEdit, onEdit, onCancel, onClose }: InvoiceDetailsModalProps) {
  // Always read the record again, so the details shown are the stored values.
  const query = useQuery({ queryKey: ['invoices', 'detail', invoiceId], queryFn: () => api.get<Invoice>(`/invoices/${invoiceId}`) })
  const invoice = query.data
  const active = invoice?.status === 'ISSUED'

  return (
    <Modal
      title="Invoice details"
      onClose={onClose}
      size="lg"
      footer={
        <>
          {canEdit && invoice && active && (
            <>
              <Button variant="secondary" className="text-red-700" onClick={() => onCancel(invoice)}>
                Cancel invoice
              </Button>
              <Button variant="secondary" onClick={() => onEdit(invoice)}>
                Edit
              </Button>
            </>
          )}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {query.isPending && <Spinner size="sm" label="Loading invoice" />}
      {query.isError && <Alert>{errorMessage(query.error)}</Alert>}
      {invoice && (
        <dl>
          <DetailRow label="Invoice number">{invoice.invoiceNumber}</DetailRow>
          <DetailRow label="Status">
            <InvoiceStatusBadge status={invoice.status} />
          </DetailRow>
          <DetailRow label="Client">{invoice.client.name}</DetailRow>
          <DetailRow label="Invoice date">{formatDate(invoice.invoiceDate)}</DetailRow>
          <DetailRow label="Amount excl. VAT">
            <Money value={invoice.amountExclVat} />
          </DetailRow>
          <DetailRow label="VAT amount">
            <Money value={invoice.vatAmount} />
          </DetailRow>
          <DetailRow label="Total incl. VAT">
            <Money value={invoice.totalAmount} />
          </DetailRow>
          <DetailRow label="Covers">
            <ul className="space-y-1">
              {invoice.allocations.map((allocation) => (
                <li key={allocation.id}>
                  {allocationLabel(allocation, formatDate)} · <Money value={allocation.amount} />
                </li>
              ))}
            </ul>
          </DetailRow>
          <DetailRow label="Raised in">Zoho</DetailRow>
          <DetailRow label="Zoho reference">
            <OrDash value={invoice.sourceReference} />
          </DetailRow>
          <DetailRow label="Notes">
            <OrDash value={invoice.notes} />
          </DetailRow>
          {!active && (
            <DetailRow label="Cancelled">
              {formatDateTime(invoice.cancelledAt)}
              {invoice.cancelledBy && ` by ${invoice.cancelledBy.fullName}`} — {invoice.cancellationReason}
            </DetailRow>
          )}
          <DetailRow label="Recorded">
            {formatDateTime(invoice.createdAt)} by {invoice.createdBy.fullName}
          </DetailRow>
          <DetailRow label="Last updated">{formatDateTime(invoice.updatedAt)}</DetailRow>
        </dl>
      )}
    </Modal>
  )
}

interface CancelInvoiceDialogProps {
  invoice: Invoice
  onClose: () => void
  onCancelled: (invoice: Invoice) => void
}

function CancelInvoiceDialog({ invoice, onClose, onCancelled }: CancelInvoiceDialogProps) {
  const queryClient = useQueryClient()
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState<string | null>(null)

  const cancel = useMutation({
    mutationFn: () => api.post<Invoice>(`/invoices/${invoice.id}/cancel`, { reason: reason.trim() }),
    onSuccess: async (cancelled) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['invoices'] }),
        queryClient.invalidateQueries({ queryKey: ['projects'] }),
        queryClient.invalidateQueries({ queryKey: ['amc'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ])
      onCancelled(cancelled)
    },
  })

  const confirm = () => {
    if (reason.trim() === '') {
      setReasonError('Reason is required.')
      return
    }
    setReasonError(null)
    cancel.mutate()
  }

  return (
    <Modal
      title="Cancel invoice"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={cancel.isPending}>
            Keep invoice
          </Button>
          <Button variant="danger" onClick={confirm} loading={cancel.isPending}>
            Cancel invoice
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-slate-700">
        <p>
          Cancel invoice <strong>{invoice.invoiceNumber}</strong> of <strong>{formatMoney(invoice.amountExclVat)}</strong> excl. VAT for{' '}
          <strong>{invoice.client.name}</strong>?
        </p>
        <p>
          The invoice is kept for the record, with your reason, but is left out of every total. The work it covered becomes ready for invoice
          again. This cannot be undone, and it does not cancel the invoice in Zoho.
        </p>
        <TextAreaField
          label="Reason"
          rows={2}
          required
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          error={reasonError ?? undefined}
        />
        {cancel.isError && <Alert>{errorMessage(cancel.error)}</Alert>}
      </div>
    </Modal>
  )
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { DetailRow, Money, OrDash } from '../../components/records'
import { Alert, Badge, Button, Modal, Spinner, TextAreaField } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { formatDate, formatDateTime } from '../../lib/format'
import { formatMoney } from '../../lib/money'
import { projectLabel } from '../../lib/projectOptions'
import type { Expense } from '../../lib/projectTypes'
import type { FixedProject } from '../procurement/ProcurementFormModal'
import { ExpenseFormModal } from './ExpenseFormModal'

export type ExpenseDialog =
  | { kind: 'none' }
  | { kind: 'create' }
  | { kind: 'edit'; expense: Expense }
  | { kind: 'view'; expenseId: string }
  | { kind: 'void'; expense: Expense }

interface ExpenseDialogsProps {
  dialog: ExpenseDialog
  setDialog: (dialog: ExpenseDialog) => void
  fixedProject?: FixedProject | undefined
  canEdit: boolean
  onNotice: (message: string) => void
}

/** The record, edit, view and void dialogs, shared by the Expenses page and the project page. */
export function ExpenseDialogs({ dialog, setDialog, fixedProject, canEdit, onNotice }: ExpenseDialogsProps) {
  const close = () => setDialog({ kind: 'none' })

  if (dialog.kind === 'create' || dialog.kind === 'edit') {
    const editing = dialog.kind === 'edit'

    return (
      <ExpenseFormModal
        expense={editing ? dialog.expense : null}
        fixedProject={fixedProject}
        onClose={close}
        onSaved={(saved) => {
          onNotice(
            editing
              ? `Expense on ${saved.jobNumber} was updated.`
              : `Expense of ${formatMoney(saved.amount)} recorded against ${saved.jobNumber}.`,
          )
          close()
        }}
      />
    )
  }

  if (dialog.kind === 'view') {
    return (
      <ExpenseDetailsModal expenseId={dialog.expenseId} canEdit={canEdit} onEdit={(expense) => setDialog({ kind: 'edit', expense })} onClose={close} />
    )
  }

  if (dialog.kind === 'void') {
    return (
      <VoidExpenseDialog
        expense={dialog.expense}
        onClose={close}
        onVoided={(voided) => {
          onNotice(`Expense of ${formatMoney(voided.amount)} on ${voided.jobNumber} was voided.`)
          close()
        }}
      />
    )
  }

  return null
}

interface ExpenseDetailsModalProps {
  expenseId: string
  canEdit: boolean
  onEdit: (expense: Expense) => void
  onClose: () => void
}

function ExpenseDetailsModal({ expenseId, canEdit, onEdit, onClose }: ExpenseDetailsModalProps) {
  // Always read the record again, so the details shown are the stored values.
  const query = useQuery({ queryKey: ['expenses', 'detail', expenseId], queryFn: () => api.get<Expense>(`/expenses/${expenseId}`) })
  const expense = query.data

  return (
    <Modal
      title="Expense details"
      onClose={onClose}
      size="lg"
      footer={
        <>
          {canEdit && expense && !expense.isVoided && (
            <Button variant="secondary" onClick={() => onEdit(expense)}>
              Edit
            </Button>
          )}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {query.isPending && <Spinner label="Loading expense" />}
      {query.isError && <Alert>{errorMessage(query.error)}</Alert>}
      {expense && (
        <dl className="divide-y divide-slate-100">
          <DetailRow label="Project / job">
            {projectLabel({ jobNumber: expense.jobNumber, clientName: expense.clientName, description: expense.projectDescription })}
          </DetailRow>
          <DetailRow label="Category">{expense.categoryName}</DetailRow>
          <DetailRow label="Expense date">{formatDate(expense.expenseDate)}</DetailRow>
          <DetailRow label="Description">{expense.description}</DetailRow>
          <DetailRow label="Supplier / payee">
            <OrDash value={expense.payeeName} />
          </DetailRow>
          <DetailRow label="Amount">
            <Money value={expense.amount} />
          </DetailRow>
          <DetailRow label="Payment reference">
            <OrDash value={expense.paymentReference} />
          </DetailRow>
          <DetailRow label="Notes">
            <OrDash value={expense.notes} />
          </DetailRow>
          {expense.isVoided && (
            <DetailRow label="Voided">
              <Badge tone="slate">Voided</Badge> {formatDateTime(expense.voidedAt)} — {expense.voidReason}
            </DetailRow>
          )}
          <DetailRow label="Recorded">{formatDateTime(expense.createdAt)}</DetailRow>
          <DetailRow label="Last updated">{formatDateTime(expense.updatedAt)}</DetailRow>
        </dl>
      )}
    </Modal>
  )
}

interface VoidExpenseDialogProps {
  expense: Expense
  onClose: () => void
  onVoided: (expense: Expense) => void
}

function VoidExpenseDialog({ expense, onClose, onVoided }: VoidExpenseDialogProps) {
  const queryClient = useQueryClient()
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState<string | null>(null)

  const voidIt = useMutation({
    mutationFn: () => api.post<Expense>(`/expenses/${expense.id}/void`, { reason: reason.trim() }),
    onSuccess: async (voided) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['expenses'] }),
        queryClient.invalidateQueries({ queryKey: ['projects'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ])
      onVoided(voided)
    },
  })

  const confirm = () => {
    if (reason.trim() === '') {
      setReasonError('Reason is required.')
      return
    }
    setReasonError(null)
    voidIt.mutate()
  }

  return (
    <Modal
      title="Void expense"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={voidIt.isPending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={confirm} loading={voidIt.isPending}>
            Void expense
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-slate-700">
        <p>
          Void the expense of <strong>{formatMoney(expense.amount)}</strong> on <strong>{expense.jobNumber}</strong> ({expense.description})?
        </p>
        <p>The expense is kept for the record, with your reason, but is left out of every total. This cannot be undone.</p>
        <TextAreaField
          label="Reason"
          rows={2}
          required
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          error={reasonError ?? undefined}
        />
        {voidIt.isError && <Alert>{errorMessage(voidIt.error)}</Alert>}
      </div>
    </Modal>
  )
}

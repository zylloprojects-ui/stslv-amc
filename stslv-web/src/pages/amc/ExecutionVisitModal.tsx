import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Alert, Button, Modal, TextAreaField, TextField } from '../../components/ui'
import { api, ApiError, errorMessage } from '../../lib/api'
import { formatDate, todayIso } from './amcFormat'
import { DetailRow, OrDash, SelectField, VisitStatusPill } from './components'
import { VISIT_STATUSES, VISIT_STATUS_LABELS, type ExecutionVisit, type VisitStatus } from './types'

export type ExecutionMode = 'view' | 'complete' | 'update'

interface ExecutionVisitModalProps {
  visit: ExecutionVisit
  mode: ExecutionMode
  /** Reopening a completed visit needs approval permission. */
  canReopen: boolean
  onClose: () => void
  onSaved: (visit: ExecutionVisit) => void
}

const TITLES: Record<ExecutionMode, string> = { view: 'Visit details', complete: 'Complete visit', update: 'Update visit' }

/** One visit for the execution team: read it, complete it, or update its status and work notes. */
export function ExecutionVisitModal({ visit, mode, canReopen, onClose, onSaved }: ExecutionVisitModalProps) {
  const queryClient = useQueryClient()
  const wasCompleted = visit.status === 'COMPLETED'

  const [status, setStatus] = useState<VisitStatus>(mode === 'complete' ? 'COMPLETED' : visit.status)
  const [completedDate, setCompletedDate] = useState(visit.completedDate ?? todayIso())
  const [scheduledDate, setScheduledDate] = useState(visit.scheduledDate)
  const [workPerformed, setWorkPerformed] = useState(visit.workPerformed ?? '')
  const [executionNotes, setExecutionNotes] = useState(visit.executionNotes ?? '')
  const [statusReason, setStatusReason] = useState(visit.statusReason ?? '')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [failure, setFailure] = useState<string | null>(null)

  const completing = status === 'COMPLETED'
  const needsReason = status === 'POSTPONED' || status === 'CANCELLED'
  const canReschedule = status !== 'COMPLETED' && status !== 'CANCELLED'
  // A completed visit keeps its status unless the user may reopen it.
  const statusLocked = wasCompleted && !canReopen

  const save = useMutation({
    mutationFn: () =>
      api.patch<ExecutionVisit>(`/amc/execution/visits/${visit.id}`, {
        status,
        workPerformed,
        executionNotes,
        ...(completing ? { completedDate } : {}),
        ...(canReschedule ? { scheduledDate } : {}),
        ...(needsReason ? { statusReason } : {}),
      }),
    onSuccess: async (saved) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['amc'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ])
      onSaved(saved)
    },
    onError: (error) => {
      const fieldErrors: Record<string, string> = {}

      if (error instanceof ApiError) {
        for (const detail of error.details) {
          fieldErrors[detail.field] = detail.message
        }
      }

      setErrors(fieldErrors)
      setFailure(Object.keys(fieldErrors).length > 0 ? null : errorMessage(error))
    },
  })

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()

    const found: Record<string, string> = {}

    if (completing && !completedDate) found.completedDate = 'Enter the date the visit was completed.'
    if (completing && completedDate > todayIso()) found.completedDate = 'The completion date cannot be in the future.'
    if (canReschedule && !scheduledDate) found.scheduledDate = 'Scheduled date is required.'
    if (workPerformed.length > 4000) found.workPerformed = 'Work performed must be at most 4000 characters.'
    if (executionNotes.length > 4000) found.executionNotes = 'Execution notes must be at most 4000 characters.'
    if (statusReason.length > 500) found.statusReason = 'Reason must be at most 500 characters.'

    setErrors(found)
    setFailure(null)

    if (Object.keys(found).length === 0) {
      save.mutate()
    }
  }

  const summary = (
    <dl className="divide-y divide-slate-100 rounded-md border border-slate-200 px-4">
      <DetailRow label="Client">{visit.client.name}</DetailRow>
      <DetailRow label="System">{visit.contract.systemDescription}</DetailRow>
      <DetailRow label="Visit">
        No. {visit.sequenceNo} · period {formatDate(visit.periodStart)} to {formatDate(visit.periodEnd)}
      </DetailRow>
      <DetailRow label="Planned date">
        {formatDate(visit.scheduledDate)}
        {visit.isRescheduled && <span className="text-slate-500"> (originally {formatDate(visit.originalScheduledDate)})</span>}
      </DetailRow>
      <DetailRow label="Assigned to">
        <OrDash value={visit.assignedTo} />
      </DetailRow>
      <DetailRow label="Status">
        <VisitStatusPill status={visit.status} overdue={visit.isOverdue} />
      </DetailRow>
      {visit.notes && <DetailRow label="Planning notes">{visit.notes}</DetailRow>}
    </dl>
  )

  if (mode === 'view') {
    return (
      <Modal title={TITLES.view} onClose={onClose} size="lg" footer={<Button onClick={onClose}>Close</Button>}>
        <div className="space-y-4">
          {summary}
          <dl className="divide-y divide-slate-100 px-4">
            {visit.statusReason && <DetailRow label="Reason">{visit.statusReason}</DetailRow>}
            <DetailRow label="Completed">
              {visit.completedDate ? (
                <>
                  {formatDate(visit.completedDate)}
                  {visit.completedBy && <span className="text-slate-500"> · recorded by {visit.completedBy.fullName}</span>}
                </>
              ) : (
                <OrDash value={null} />
              )}
            </DetailRow>
            <DetailRow label="Work performed">
              <OrDash value={visit.workPerformed} />
            </DetailRow>
            <DetailRow label="Execution notes">
              <OrDash value={visit.executionNotes} />
            </DetailRow>
          </dl>
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      title={TITLES[mode]}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="amc-execution-form" loading={save.isPending}>
            {mode === 'complete' ? 'Mark as completed' : 'Save changes'}
          </Button>
        </>
      }
    >
      <form id="amc-execution-form" onSubmit={onSubmit} noValidate className="space-y-4">
        {failure && <Alert>{failure}</Alert>}
        {summary}

        {mode === 'update' && (
          <SelectField
            label="Status"
            required
            disabled={statusLocked}
            value={status}
            onChange={(event) => setStatus(event.target.value as VisitStatus)}
            error={errors.status}
            hint={
              statusLocked
                ? 'A completed visit can only be reopened by a user with approval permission.'
                : wasCompleted && !completing
                  ? 'Reopening removes the completion date and takes the visit out of the work ready for invoice.'
                  : undefined
            }
          >
            {VISIT_STATUSES.map((value) => (
              <option key={value} value={value}>
                {VISIT_STATUS_LABELS[value]}
              </option>
            ))}
          </SelectField>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          {completing && (
            <TextField
              label="Completion date"
              type="date"
              required
              max={todayIso()}
              value={completedDate}
              onChange={(event) => setCompletedDate(event.target.value)}
              error={errors.completedDate}
            />
          )}
          {canReschedule && (
            <TextField
              label="Planned date"
              type="date"
              required
              value={scheduledDate}
              onChange={(event) => setScheduledDate(event.target.value)}
              hint={status === 'POSTPONED' ? 'Enter the new date the visit is postponed to.' : undefined}
              error={errors.scheduledDate}
            />
          )}
        </div>

        {needsReason && (
          <TextField
            label={status === 'POSTPONED' ? 'Reason for postponing' : 'Reason for cancelling'}
            value={statusReason}
            onChange={(event) => setStatusReason(event.target.value)}
            error={errors.statusReason}
          />
        )}

        <TextAreaField
          label="Work performed"
          rows={3}
          value={workPerformed}
          onChange={(event) => setWorkPerformed(event.target.value)}
          error={errors.workPerformed}
        />
        <TextAreaField
          label="Execution notes"
          rows={3}
          value={executionNotes}
          onChange={(event) => setExecutionNotes(event.target.value)}
          error={errors.executionNotes}
        />
      </form>
    </Modal>
  )
}

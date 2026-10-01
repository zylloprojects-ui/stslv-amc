import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { Alert, Button, Modal, Spinner, TextAreaField, TextField } from '../../components/ui'
import { api, ApiError, errorMessage } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { formatDate, formatMoney, MONEY_PATTERN } from './amcFormat'
import { DetailRow, EligibilityPill, OrDash, PlannedDate, VisitStatusPill } from './components'
import { FREQUENCY_LABELS, type ScheduleVisit } from './types'

const visitLabel = (visit: ScheduleVisit) => `${visit.client.name} – ${visit.contract.systemDescription}, visit ${visit.sequenceNo}`

interface VisitDetailsModalProps {
  visitId: string
  canEdit: boolean
  onEdit: (visit: ScheduleVisit) => void
  onClose: () => void
}

export function VisitDetailsModal({ visitId, canEdit, onEdit, onClose }: VisitDetailsModalProps) {
  // Always read the record again, so the details shown are the stored values.
  const query = useQuery({ queryKey: ['amc', 'visits', 'detail', visitId], queryFn: () => api.get<ScheduleVisit>(`/amc/visits/${visitId}`) })
  const visit = query.data

  return (
    <Modal
      title="Visit details"
      onClose={onClose}
      size="lg"
      footer={
        <>
          {canEdit && visit && visit.status !== 'HISTORICAL' && (
            <Button variant="secondary" onClick={() => onEdit(visit)}>
              Edit
            </Button>
          )}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {query.isPending && <Spinner label="Loading visit" />}
      {query.isError && <Alert>{errorMessage(query.error)}</Alert>}
      {visit && visit.status === 'HISTORICAL' && (
        <div className="mb-4">
          <Alert tone="info">
            <strong>Historical record.</strong> This period was imported from an earlier schedule. Whether and when the visit took place was not
            recorded, so it is not counted as due, overdue or ready for invoice, and it cannot be changed here.
          </Alert>
        </div>
      )}
      {visit && (
        <dl className="divide-y divide-slate-100">
          <DetailRow label="Client">{visit.client.name}</DetailRow>
          <DetailRow label="System">{visit.contract.systemDescription}</DetailRow>
          <DetailRow label="Visit">
            No. {visit.sequenceNo} · {FREQUENCY_LABELS[visit.contract.maintenanceFrequency]}
          </DetailRow>
          <DetailRow label="Period">
            {formatDate(visit.periodStart)} to {formatDate(visit.periodEnd)}
          </DetailRow>
          <DetailRow label="Scheduled date">
            <PlannedDate visit={visit} format={formatDate} />
            {visit.isRescheduled && <span className="text-slate-500"> (originally {formatDate(visit.originalScheduledDate)})</span>}
          </DetailRow>
          <DetailRow label="Status">
            <VisitStatusPill status={visit.status} overdue={visit.isOverdue} />
          </DetailRow>
          {visit.statusReason && <DetailRow label="Reason">{visit.statusReason}</DetailRow>}
          <DetailRow label="Assigned to">
            <OrDash value={visit.assignedTo} />
          </DetailRow>
          <DetailRow label="Visit amount">
            {formatMoney(visit.visitAmount)}
            {visit.amountIsCustom && <span className="text-slate-500"> (set on this visit)</span>}
          </DetailRow>
          <DetailRow label="Invoicing">
            <EligibilityPill eligibility={visit.invoiceEligibility} />
          </DetailRow>
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
          <DetailRow label="Planning notes">
            <OrDash value={visit.notes} />
          </DetailRow>
          <DetailRow label="Last updated">{formatDateTime(visit.updatedAt)}</DetailRow>
        </dl>
      )}
    </Modal>
  )
}

const editSchema = z.object({
  visitAmount: z
    .string()
    .trim()
    .refine((value) => value === '' || MONEY_PATTERN.test(value), 'Enter an amount of zero or more with at most 3 decimal places.'),
  scheduledDate: z.string().min(1, 'Scheduled date is required.'),
  assignedTo: z.string().trim().max(200, 'Assigned to must be at most 200 characters.'),
  notes: z.string().trim().max(2000, 'Notes must be at most 2000 characters.'),
})

type EditForm = z.infer<typeof editSchema>
const EDIT_FIELDS = ['visitAmount', 'scheduledDate', 'assignedTo', 'notes'] as const

interface VisitEditModalProps {
  visit: ScheduleVisit
  onClose: () => void
  onSaved: (visit: ScheduleVisit) => void
}

/** Planning changes to one visit: its amount, planned date, assignment and notes. */
export function VisitEditModal({ visit, onClose, onSaved }: VisitEditModalProps) {
  const queryClient = useQueryClient()
  const [failure, setFailure] = useState<string | null>(null)
  const dateLocked = visit.status === 'COMPLETED' || visit.status === 'CANCELLED'
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<EditForm>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      visitAmount: visit.visitAmount ?? '',
      scheduledDate: visit.scheduledDate,
      assignedTo: visit.assignedToOverride ?? '',
      notes: visit.notes ?? '',
    },
  })

  const save = useMutation({
    mutationFn: (values: EditForm) => {
      const { scheduledDate, ...rest } = values

      return api.patch<ScheduleVisit>(`/amc/visits/${visit.id}`, dateLocked ? rest : { ...rest, scheduledDate })
    },
    onSuccess: async (saved) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['amc'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ])
      onSaved(saved)
    },
    onError: (error) => {
      let shownOnField = false

      if (error instanceof ApiError) {
        for (const detail of error.details) {
          if ((EDIT_FIELDS as readonly string[]).includes(detail.field)) {
            setError(detail.field as (typeof EDIT_FIELDS)[number], { message: detail.message })
            shownOnField = true
          }
        }
      }

      setFailure(shownOnField ? null : errorMessage(error))
    },
  })

  const onSubmit = handleSubmit((values) => {
    setFailure(null)
    save.mutate(values)
  })

  return (
    <Modal
      title="Edit visit"
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="amc-visit-form" loading={save.isPending}>
            Save changes
          </Button>
        </>
      }
    >
      <form id="amc-visit-form" onSubmit={onSubmit} noValidate className="space-y-4">
        {failure && <Alert>{failure}</Alert>}
        <p className="text-sm text-slate-600">
          {visitLabel(visit)} · period {formatDate(visit.periodStart)} to {formatDate(visit.periodEnd)}
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Visit amount"
            inputMode="decimal"
            hint="Applies to this visit only. Enter 0 for a visit that is not invoiced; leave empty if not yet known."
            error={errors.visitAmount?.message}
            {...register('visitAmount')}
          />
          <TextField
            label="Scheduled date"
            type="date"
            required
            disabled={dateLocked}
            hint={dateLocked ? `A ${visit.status.toLowerCase()} visit cannot be rescheduled.` : `Originally ${formatDate(visit.originalScheduledDate)}.`}
            error={errors.scheduledDate?.message}
            {...register('scheduledDate')}
          />
        </div>

        <TextField
          label="Assigned to"
          hint={`Leave empty to use the contract's responsible engineer${visit.assignedToOverride === null && visit.assignedTo ? ` (${visit.assignedTo})` : ''}.`}
          error={errors.assignedTo?.message}
          {...register('assignedTo')}
        />
        <TextAreaField label="Planning notes" rows={3} error={errors.notes?.message} {...register('notes')} />
      </form>
    </Modal>
  )
}

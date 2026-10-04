import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Alert, Button, Modal, TextField } from '../../components/ui'
import { api, ApiError, errorMessage } from '../../lib/api'
import { todayIso } from '../../lib/format'
import { isZeroAmount } from '../../lib/money'
import type { Project, ProjectStatus } from '../../lib/projectTypes'
import { statusActionLabel } from './statusActions'

interface ProjectStatusDialogProps {
  project: Project
  /** The status the project is being moved to. */
  target: ProjectStatus
  onClose: () => void
  onChanged: (project: Project) => void
}

function explanation(project: Project, target: ProjectStatus): string {
  if (target === 'COMPLETED') {
    return isZeroAmount(project.jobValue)
      ? 'This project has a job value of zero, so it will be marked as needing no invoice.'
      : 'The project will be listed as ready for invoice. The invoice itself is raised in Zoho.'
  }
  if (target === 'CANCELLED') {
    return 'The project is kept, with everything recorded against it, but nothing new can be added. It can be reopened later.'
  }
  if (target === 'IN_PROGRESS' && project.status === 'COMPLETED') {
    return 'The completion date is cleared and the project is no longer listed as ready for invoice.'
  }
  if (target === 'NEW') {
    return 'The project becomes active again.'
  }

  return 'The project is marked as being worked on.'
}

/** Confirms a status change. Completing also asks for the completion date. */
export function ProjectStatusDialog({ project, target, onClose, onChanged }: ProjectStatusDialogProps) {
  const queryClient = useQueryClient()
  const [completedDate, setCompletedDate] = useState(todayIso())
  const [dateError, setDateError] = useState<string | null>(null)
  const completing = target === 'COMPLETED'
  const label = statusActionLabel(project.status, target)

  const change = useMutation({
    mutationFn: () =>
      api.post<Project>(`/projects/${project.id}/status`, completing ? { status: target, completedDate } : { status: target }),
    onSuccess: async (updated) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['projects'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ])
      onChanged(updated)
    },
    onError: (error) => {
      const detail = error instanceof ApiError ? error.details.find((item) => item.field === 'completedDate') : undefined
      setDateError(detail?.message ?? null)
    },
  })

  const confirm = () => {
    if (completing && completedDate === '') {
      setDateError('Completion date is required.')
      return
    }
    setDateError(null)
    change.mutate()
  }

  return (
    <Modal
      title={label}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={change.isPending}>
            Back
          </Button>
          <Button variant={target === 'CANCELLED' ? 'danger' : 'primary'} onClick={confirm} loading={change.isPending}>
            {label}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-slate-700">
        <p>
          {label} for <strong>{project.jobNumber}</strong> ({project.clientName})?
        </p>
        <p>{explanation(project, target)}</p>
        {completing && (
          <TextField
            label="Completion date"
            type="date"
            required
            value={completedDate}
            onChange={(event) => setCompletedDate(event.target.value)}
            error={dateError ?? undefined}
          />
        )}
        {change.isError && !dateError && <Alert>{errorMessage(change.error)}</Alert>}
      </div>
    </Modal>
  )
}

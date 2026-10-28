import { useQuery } from '@tanstack/react-query'
import { Alert, Button, Modal, Spinner } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { ExecutionVisitModal } from './ExecutionVisitModal'
import type { ExecutionVisit } from './types'

interface VisitActionsDialogProps {
  visitId: string
  /** Reopening a completed visit needs AMC_EXECUTION:APPROVE; the API checks it again. */
  canReopen: boolean
  onClose: () => void
  onSaved: (visit: ExecutionVisit) => void
}

/**
 * Start, complete, postpone or cancel one visit, and record its work notes.
 * Loads the visit from the execution API and saves through it, so every rule of
 * PATCH /amc/execution/visits/:id applies unchanged (completion date, reopening
 * needs approval, invoiced work cannot be reopened, historical rows are read-only).
 */
export function VisitActionsDialog({ visitId, canReopen, onClose, onSaved }: VisitActionsDialogProps) {
  const visit = useQuery({
    queryKey: ['amc', 'execution', 'visit', visitId],
    queryFn: () => api.get<ExecutionVisit>(`/amc/execution/visits/${visitId}`),
    // Always the latest copy: the dialog saves against it.
    staleTime: 0,
    gcTime: 0,
  })

  if (visit.data) {
    return <ExecutionVisitModal visit={visit.data} mode="update" canReopen={canReopen} onClose={onClose} onSaved={onSaved} />
  }

  return (
    <Modal title="Visit actions" onClose={onClose} size="lg" footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      {visit.isError ? <Alert>{errorMessage(visit.error)}</Alert> : <Spinner label="Loading visit" />}
    </Modal>
  )
}

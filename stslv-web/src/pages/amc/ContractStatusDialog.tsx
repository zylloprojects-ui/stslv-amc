import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { Alert, Button, Modal } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { CONTRACT_STATUS_LABELS, type Contract, type ContractStatus, type SavedContract } from './types'

interface ContractStatusDialogProps {
  contract: Contract
  status: ContractStatus
  onClose: () => void
  onChanged: (contract: SavedContract) => void
}

const TITLES: Record<ContractStatus, string> = {
  DRAFT: 'Change status',
  ACTIVE: 'Activate contract',
  EXPIRED: 'Mark contract as expired',
  CANCELLED: 'Cancel contract',
}

/** Confirms a contract status change. Ending a contract never cancels its visits unless the user asks. */
export function ContractStatusDialog({ contract, status, onClose, onChanged }: ContractStatusDialogProps) {
  const queryClient = useQueryClient()
  const checkboxId = useId()
  const [cancelOpenVisits, setCancelOpenVisits] = useState(false)
  const ending = status === 'EXPIRED' || status === 'CANCELLED'
  const label = `${contract.client.name} – ${contract.systemDescription}`

  const change = useMutation({
    mutationFn: () => api.post<SavedContract>(`/amc/contracts/${contract.id}/status`, { status, ...(ending ? { cancelOpenVisits } : {}) }),
    onSuccess: async (saved) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['amc'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ])
      onChanged(saved)
    },
  })

  return (
    <Modal
      title={TITLES[status]}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={change.isPending}>
            Back
          </Button>
          <Button variant={status === 'CANCELLED' ? 'danger' : 'primary'} onClick={() => change.mutate()} loading={change.isPending}>
            {TITLES[status]}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-slate-700">
        <p>
          Change <strong>{label}</strong> from {CONTRACT_STATUS_LABELS[contract.status]} to <strong>{CONTRACT_STATUS_LABELS[status]}</strong>?
        </p>
        {status === 'ACTIVE' && (
          <p>
            The maintenance schedule is generated from the validity period and frequency. Visits that already exist are kept; only missing visits are
            added.
          </p>
        )}
        {ending && contract.schedule.openCount > 0 && (
          <>
            <p>
              This contract has <strong>{contract.schedule.openCount}</strong> visit(s) that are not completed. They stay on the schedule unless you
              choose to cancel them. Completed visits and visits in progress are never changed.
            </p>
            <div className="flex items-start gap-2">
              <input
                id={checkboxId}
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-slate-300"
                checked={cancelOpenVisits}
                onChange={(event) => setCancelOpenVisits(event.target.checked)}
              />
              <label htmlFor={checkboxId}>Also cancel the scheduled and postponed visits of this contract</label>
            </div>
          </>
        )}
        {change.isError && <Alert>{errorMessage(change.error)}</Alert>}
      </div>
    </Modal>
  )
}

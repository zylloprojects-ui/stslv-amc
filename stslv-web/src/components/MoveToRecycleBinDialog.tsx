import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { api, errorMessage } from '../lib/api'
import { Alert, Button, Modal, Spinner } from './ui'

// The Delete action of Clients, System Types and Sales Engineers (migration 0106, approved 2026-11-04):
// moves the record to the Recycle Bin, where Super Admin can restore it with the same id and links.
// The counts come from the API when the dialog opens (GET .../usage), never from the list on screen,
// so they are current and count AMC contracts in the Recycle Bin apart: those never block the move.

/** GET /api/clients/:id/usage, /api/masters/system-types/:id/usage, /api/masters/sales-engineers/:id/usage */
export interface RecordUsage {
  contracts: { total: number; byStatus: Record<string, number> }
  recycledContracts: number
  invoices: number | null
  projects: number | null
  importRows: number | null
  canMoveToRecycleBin: boolean
  blockers: string[]
}

interface Props {
  /** "system type", for the title and messages. */
  noun: string
  /** "HVAC — HVAC": what the record is called on screen. */
  label: string
  usagePath: string
  deletePath: string
  /** Query keys whose lists show the record. */
  refresh: readonly (readonly string[])[]
  onClose: () => void
  onMoved: (message: string) => void
  /** Shown beside Close when the move is refused, such as View contracts. */
  blockedAction?: ReactNode
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

export function MoveToRecycleBinDialog({ noun, label, usagePath, deletePath, refresh, onClose, onMoved, blockedAction }: Props) {
  const queryClient = useQueryClient()
  const usage = useQuery({ queryKey: ['recycle-usage', usagePath], queryFn: () => api.get<RecordUsage>(usagePath), staleTime: 0, gcTime: 0 })
  const move = useMutation({
    mutationFn: () => api.delete(deletePath),
    onSuccess: async () => {
      await Promise.all([...refresh, ['security']].map((queryKey) => queryClient.invalidateQueries({ queryKey })))
      onMoved(`${label} was moved to the Recycle Bin. Super Admin can restore it from Admin › Recycle Bin.`)
    },
  })
  const data = usage.data
  const blocked = data !== undefined && !data.canMoveToRecycleBin

  return (
    <Modal
      title={blocked ? `This ${noun} cannot be moved to the Recycle Bin` : `Move ${noun} to the Recycle Bin`}
      onClose={onClose}
      footer={
        blocked ? (
          <>
            {blockedAction}
            <Button onClick={onClose}>OK</Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={move.isPending}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => move.mutate()} loading={move.isPending} disabled={!data}>
              Move to Recycle Bin
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3 break-words text-sm text-slate-700">
        {usage.isPending && <Spinner label={`Checking what uses this ${noun}`} size="sm" />}
        {usage.isError && <Alert>{errorMessage(usage.error)}</Alert>}
        {blocked && (
          <>
            <p>
              <strong>{label}</strong> is used by {data.blockers.join(', ')}. Those records must keep it, so it cannot be moved to the Recycle Bin.
            </p>
            <p>Disable it instead: the records keep it, and it is no longer offered for new ones.</p>
          </>
        )}
        {data && !blocked && (
          <>
            <p>
              Move <strong>{label}</strong> to the Recycle Bin? No live record uses it. Nothing is removed, and Super Admin can restore it with the same code and links.
            </p>
            {data.recycledContracts > 0 && (
              <Alert tone="info">
                {plural(data.recycledContracts, 'AMC contract')} in the Recycle Bin {data.recycledContracts === 1 ? 'refers' : 'refer'} to it. That does not stop the move; to restore{' '}
                {data.recycledContracts === 1 ? 'that contract' : 'those contracts'} later, restore this {noun} first.
              </Alert>
            )}
            <p className="text-slate-500">To keep it in the list but stop offering it for new records, disable it instead.</p>
          </>
        )}
        {move.isError && <Alert>{errorMessage(move.error)}</Alert>}
      </div>
    </Modal>
  )
}

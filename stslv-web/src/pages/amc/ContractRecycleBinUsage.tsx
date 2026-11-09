import { useQuery } from '@tanstack/react-query'
import { Alert, ConfirmDialog } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { ContractLink } from '../../components/ContractLink'

/** GET /api/amc/contracts/:id/usage: what a move to the Recycle Bin keeps, and whether a renewal blocks it. */
export interface ContractUsage {
  services: { total: number; completed: number; open: number; cancelled: number; historical: number }
  paidServices: number
  invoices: number
  documents: number
  renewal: { id: string; reference: string } | null
  renewedFrom: { id: string; reference: string } | null
  blockedReason: string | null
}

/** Read when the dialog opens, from the API, never from the list on screen. */
function useContractUsage(contractId: string) {
  return useQuery({
    queryKey: ['amc', 'contracts', 'usage', contractId],
    queryFn: () => api.get<ContractUsage>(`/amc/contracts/${contractId}/usage`),
    staleTime: 0,
  })
}

const count = (value: number, one: string, many = `${one}s`) => `${value} ${value === 1 ? one : many}`

/** The dependency information of the delete dialog: what is kept with the contract, and any blocker. */
function ContractRecycleBinUsage({ usage }: { usage: ReturnType<typeof useContractUsage> }) {
  if (usage.isPending) {
    return (
      <p className="text-sm text-slate-500" role="status">
        Checking what this contract is linked to…
      </p>
    )
  }
  // The move itself is still checked by the API, so a failed check only says so.
  if (usage.isError) {
    return <p className="text-xs text-slate-500">Could not check what this contract is linked to: {errorMessage(usage.error)}</p>
  }

  const { services, paidServices, invoices, documents, renewal, renewedFrom, blockedReason } = usage.data

  return (
    <div className="space-y-2">
      {blockedReason && (
        <Alert>
          {blockedReason}
          {renewal && (
            <>
              {' '}
              <ContractLink id={renewal.id} className="font-semibold underline" hideWithoutAccess>
                Open {renewal.reference}
              </ContractLink>
            </>
          )}
        </Alert>
      )}
      <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Kept with the contract</p>
        <ul aria-label="Kept with the contract" className="mt-1 space-y-0.5 text-sm text-slate-700">
          <li>
            {count(services.total, 'service')}
            {services.total > 0 && (
              <span className="text-slate-500">
                {' '}
                ({[
                  services.completed > 0 && `${services.completed} completed`,
                  services.open > 0 && `${services.open} open`,
                  services.cancelled > 0 && `${services.cancelled} cancelled`,
                  services.historical > 0 && `${services.historical} historical`,
                ]
                  .filter(Boolean)
                  .join(', ')}
                )
              </span>
            )}
          </li>
          <li>{count(paidServices, 'service')} with an Invoice No. (Paid)</li>
          <li>{count(invoices, 'invoice')} in Invoice Tracking</li>
          <li>{count(documents, 'document')}</li>
          {renewedFrom && <li>It renews {renewedFrom.reference}, which is not changed.</li>}
        </ul>
      </div>
    </div>
  )
}

interface MoveContractDialogProps {
  contract: { id: string }
  name: string
  loading: boolean
  error: string | null
  onConfirm: () => void
  onCancel: () => void
}

/** Move a contract to the Recycle Bin, with what it is linked to. The move stays disabled while a renewal blocks it; the API refuses it too. */
export function MoveContractDialog({ contract, name, loading, error, onConfirm, onCancel }: MoveContractDialogProps) {
  const usage = useContractUsage(contract.id)
  const blocked = usage.data?.blockedReason != null

  return (
    <ConfirmDialog
      title="Move contract to the Recycle Bin"
      message={
        <>
          Move the contract for <strong>{name}</strong> to the Recycle Bin?
          <span className="mt-2 block text-sm">
            It leaves AMC Contracts, schedules, the calendar, Accounts and the dashboard figures. Nothing is removed: its services, service reports,
            quotations, invoices, documents and history are kept, and Super Admin can restore it from Administration &gt; Recycle Bin.
          </span>
          <div className="mt-3">
            <ContractRecycleBinUsage usage={usage} />
          </div>
        </>
      }
      confirmLabel="Move to Recycle Bin"
      danger
      loading={loading}
      confirmDisabled={blocked}
      error={error}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}

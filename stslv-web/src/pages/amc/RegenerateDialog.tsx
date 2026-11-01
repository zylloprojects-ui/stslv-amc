import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { TABLE } from '../../components/table'
import { Alert, Button, Modal, Spinner, TextAreaField } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { refreshOperationalData } from '../../lib/refreshOperationalData'
import { formatDate, formatMoney } from './amcFormat'
import { BILLING_BASIS_LABELS, type Contract } from './types'

interface Preview {
  canApply: boolean
  blockedReason: string | null
  billingBasis: Contract['billingBasis']
  annualAmount: string | null
  servicesPerCycle: number | null
  perServiceAmount: string | null
  lastServiceAmount: string | null
  toCreate: number
  toRemove: number
  changes: { id: string; sequenceNo: number; serviceCode: string | null; scheduledDate: string; from: string | null; to: string }[]
  preserved: { id: string; sequenceNo: number; serviceCode: string | null; scheduledDate: string; amount: string | null; reason: string }[]
  unchanged: number
}

const serviceName = (visit: { serviceCode: string | null; sequenceNo: number }) => visit.serviceCode ?? `No. ${visit.sequenceNo}`

/** The only way existing visit amounts change: shows what would happen first, and asks why. */
export function RegenerateDialog({ contract, onClose }: { contract: Contract; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [reason, setReason] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const preview = useQuery({
    queryKey: ['amc', 'contracts', 'regenerate-preview', contract.id],
    queryFn: () => api.get<Preview>(`/amc/contracts/${contract.id}/schedule/regenerate`),
    // Always what the database says now, never a remembered plan.
    gcTime: 0,
  })
  const apply = useMutation({
    mutationFn: () => api.post(`/amc/contracts/${contract.id}/schedule/regenerate`, { reason: reason.trim() }),
    onSuccess: async () => {
      await refreshOperationalData(queryClient)
      onClose()
    },
    onError: (error) => setFailure(errorMessage(error)),
  })
  const data = preview.data
  const ready = data?.canApply === true && reason.trim().length >= 3

  return (
    <Modal
      title="Regenerate schedule"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={apply.isPending}>
            Cancel
          </Button>
          <Button onClick={() => apply.mutate()} loading={apply.isPending} disabled={!ready}>
            Regenerate
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {failure && <Alert>{failure}</Alert>}
        {preview.isPending && <Spinner label="Working out the changes" />}
        {preview.isError && <Alert>{errorMessage(preview.error)}</Alert>}
        {data && (
          <>
            {data.blockedReason && <Alert>{data.blockedReason}</Alert>}
            {data.annualAmount && data.billingBasis && (
              <p className="text-sm text-slate-700">
                {BILLING_BASIS_LABELS[data.billingBasis]} {formatMoney(data.annualAmount)} a year, excluding VAT, across {data.servicesPerCycle} service(s) a year: {formatMoney(data.perServiceAmount)} each
                {data.lastServiceAmount !== data.perServiceAmount && `, and ${formatMoney(data.lastServiceAmount)} for the last service of each complete year, so the year adds up exactly`}.
              </p>
            )}
            <ul className="list-inside list-disc text-sm text-slate-700">
              <li>{data.changes.length} visit amount(s) recalculated</li>
              <li>{data.preserved.length} visit(s) keep their amount</li>
              <li>{data.unchanged} already at the calculated amount</li>
              {data.toCreate > 0 && <li>{data.toCreate} missing visit(s) added</li>}
              {data.toRemove > 0 && <li>{data.toRemove} untouched visit(s) outside the terms removed</li>}
            </ul>
            {data.changes.length > 0 && (
              <div className={TABLE.wrapper}>
                <table className={TABLE.table}>
                  <caption className="sr-only">Amounts that would change</caption>
                  <thead>
                    <tr>
                      <th scope="col" className={TABLE.th}>Service</th>
                      <th scope="col" className={TABLE.th}>Scheduled</th>
                      <th scope="col" className={`${TABLE.th} text-right`}>Now</th>
                      <th scope="col" className={`${TABLE.th} text-right`}>New</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.changes.map((change) => (
                      <tr key={change.id}>
                        <td className={TABLE.td}>{serviceName(change)}</td>
                        <td className={`${TABLE.td} whitespace-nowrap`}>{formatDate(change.scheduledDate)}</td>
                        <td className={`${TABLE.td} text-right tabular-nums`}>{formatMoney(change.from)}</td>
                        <td className={`${TABLE.td} text-right font-semibold tabular-nums`}>{formatMoney(change.to)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {data.preserved.length > 0 && (
              <details className="text-sm text-slate-700">
                <summary className="cursor-pointer font-semibold text-[#0b3b66]">Visits that keep their amount ({data.preserved.length})</summary>
                <ul className="mt-2 space-y-1">
                  {data.preserved.map((visit) => (
                    <li key={visit.id}>
                      {serviceName(visit)} · {formatDate(visit.scheduledDate)} · {formatMoney(visit.amount)} · {visit.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {data.canApply && <TextAreaField label="Reason for regenerating" required rows={2} maxLength={300} value={reason} onChange={(event) => setReason(event.target.value)} />}
          </>
        )}
      </div>
    </Modal>
  )
}

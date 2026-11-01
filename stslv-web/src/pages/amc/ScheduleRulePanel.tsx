import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { formatDate, formatMoney } from './amcFormat'
import { BILLING_BASIS_LABELS, COLOR_PRIORITY_RULE, frequencyLabel, type Contract } from './types'

interface Generation {
  generation: number
  added: number
  removed: number
  maintenanceFrequency: string | null
  validFrom: string | null
  validTo: string | null
  generatedBy: string | null
  generatedAt: string
}

/** How this contract's schedule is made, and every update of it. Read-only. */
export function ScheduleRulePanel({ contract }: { contract: Contract }) {
  const generations = useQuery({ queryKey: ['amc', 'contracts', 'generations', contract.id], queryFn: () => api.get<Generation[]>(`/amc/contracts/${contract.id}/schedule/generations`) })

  return (
    <div className="border-b border-slate-200 px-6 pb-4">
      <h3 className="text-sm font-semibold text-slate-900">Calculation rule</h3>
      <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex justify-between gap-3">
          <dt className="text-slate-600">Billing basis</dt>
          <dd className="text-right font-medium text-slate-900">{contract.billingBasis ? `${BILLING_BASIS_LABELS[contract.billingBasis]} · ${formatMoney(contract.selectedBillingAmount ?? null)}` : 'Not set'}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-slate-600">Visit amount</dt>
          <dd className="text-right font-medium text-slate-900">Default visit amount · {formatMoney(contract.defaultVisitAmount)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-slate-600">Frequency</dt>
          <dd className="text-right font-medium text-slate-900">{frequencyLabel(contract.maintenanceFrequency)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-slate-600">Validity</dt>
          <dd className="text-right font-medium text-slate-900">{formatDate(contract.validFrom)} to {formatDate(contract.validTo)}</dd>
        </div>
        <div className="flex justify-between gap-3 sm:col-span-2">
          <dt className="text-slate-600">Color priority</dt>
          <dd className="text-right font-medium text-slate-900">{COLOR_PRIORITY_RULE}</dd>
        </div>
      </dl>
      {generations.data && generations.data.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer font-semibold text-[#0b3b66]">Schedule history ({generations.data.length})</summary>
          <ol className="mt-2 space-y-1 text-slate-700">
            {generations.data.map((item) => (
              <li key={item.generation} className="break-words">
                #{item.generation} · {item.added} added, {item.removed} removed · {item.maintenanceFrequency ? frequencyLabel(item.maintenanceFrequency) : '—'} · {item.generatedBy ?? 'System'} · {formatDateTime(item.generatedAt)}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  )
}

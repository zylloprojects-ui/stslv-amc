import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useAuth } from '../../auth/context'
import { Button } from '../../components/ui'
import { api } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { formatDate, formatMoney } from './amcFormat'
import { RegenerateDialog } from './RegenerateDialog'
import { BILLING_BASIS_LABELS, COLOR_PRIORITY_RULE, frequencyLabel, type Contract } from './types'

interface Generation {
  generation: number
  added: number
  removed: number
  maintenanceFrequency: string | null
  reason: string | null
  billingBasis: keyof typeof BILLING_BASIS_LABELS | null
  annualAmount: string | null
  recalculated: number
  preserved: number
  validFrom: string | null
  validTo: string | null
  generatedBy: string | null
  generatedAt: string
}

/** How this contract's schedule is made, and every update of it. Read-only. */
export function ScheduleRulePanel({ contract }: { contract: Contract }) {
  const auth = useAuth()
  const [regenerating, setRegenerating] = useState(false)
  const generations = useQuery({ queryKey: ['amc', 'contracts', 'generations', contract.id], queryFn: () => api.get<Generation[]>(`/amc/contracts/${contract.id}/schedule/generations`) })

  return (
    <div className="border-b border-slate-200 px-6 pb-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">Calculation rule</h3>
        {auth.can('AMC_CONTRACTS', 'EDIT') && contract.status === 'ACTIVE' && (
          <Button variant="secondary" size="sm" onClick={() => setRegenerating(true)}>
            Regenerate
          </Button>
        )}
      </div>
      {regenerating && <RegenerateDialog contract={contract} onClose={() => setRegenerating(false)} />}
      <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex justify-between gap-3">
          <dt className="text-slate-600">Billing basis</dt>
          <dd className="text-right font-medium text-slate-900">{contract.billingBasis ? `${BILLING_BASIS_LABELS[contract.billingBasis]} · ${formatMoney(contract.selectedBillingAmount ?? null)}` : 'Not set'}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-slate-600">Visit amount</dt>
          <dd className="text-right font-medium text-slate-900">
            {contract.schedule.perServiceAmount
              ? `Annual amount ÷ ${contract.schedule.servicesPerCycle} service(s) a year · ${formatMoney(contract.schedule.perServiceAmount)} (OMR, Ex VAT); the last service of a complete year takes any rounding remainder`
              : `Default visit amount · ${formatMoney(contract.defaultVisitAmount)}`}
          </dd>
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
                #{item.generation}{item.reason ? ` · ${item.reason}` : ''}{item.billingBasis ? ` · ${BILLING_BASIS_LABELS[item.billingBasis]} ${formatMoney(item.annualAmount)}` : ''} · {item.added} added, {item.removed} removed{item.recalculated > 0 || item.preserved > 0 ? `, ${item.recalculated} recalculated, ${item.preserved} preserved` : ''} · {item.maintenanceFrequency ? frequencyLabel(item.maintenanceFrequency) : '—'} · {item.generatedBy ?? 'System'} · {formatDateTime(item.generatedAt)}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  )
}

import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Alert, Button, Spinner } from '../../components/ui'
import { api, ApiError, errorMessage } from '../../lib/api'
import { formatDate } from './amcFormat'
import { ContractStatusPill } from './components'
import type { ContractStatus } from './types'

interface ContractSummary {
  id: string
  client: { id: string; name: string }
  systemDescription: string
  validFrom: string
  validTo: string
  status: ContractStatus
  createdAt: string
}

export interface ContractRenewals {
  renewedFrom: ContractSummary | null
  renewals: ContractSummary[]
}

function SummaryLine({ contract }: { contract: ContractSummary }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Link to={`/amc/contracts/${contract.id}`} className="font-medium text-blue-700 hover:underline">
        {formatDate(contract.validFrom)} to {formatDate(contract.validTo)}
      </Link>
      <ContractStatusPill status={contract.status} />
    </span>
  )
}

/**
 * The renewal links of a contract (migration 0072): the contract it renews and
 * the renewals made of it. A renewal is a separate contract; this one is never
 * changed by renewing it. Hidden on a database without the migration.
 */
export function ContractRenewalsPanel({ contractId, canRenew, onRenew }: { contractId: string; canRenew: boolean; onRenew: () => void }) {
  const query = useQuery({
    queryKey: ['amc', 'contracts', 'renewals', contractId],
    queryFn: () => api.get<ContractRenewals>(`/amc/contracts/${contractId}/renewals`),
    retry: false,
  })

  if (query.isError && query.error instanceof ApiError && query.error.code === 'FEATURE_UNAVAILABLE') {
    return <p className="px-6 py-4 text-sm text-slate-600">Renewals need a database update that has not been applied to this database yet (migration 0072).</p>
  }

  const open = query.data?.renewals.find((renewal) => renewal.status !== 'CANCELLED')

  return (
    <div className="px-6 py-4">
      {query.isPending && <Spinner size="sm" label="Loading renewals" />}
      {query.isError && <Alert>{errorMessage(query.error)}</Alert>}
      {query.data && (
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="font-semibold text-slate-700">Renews</dt>
            <dd className="mt-1">{query.data.renewedFrom ? <SummaryLine contract={query.data.renewedFrom} /> : <span className="text-slate-500">Not a renewal</span>}</dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-700">Renewed by</dt>
            <dd className="mt-1 space-y-1">
              {query.data.renewals.length === 0 ? (
                <span className="text-slate-500">No renewal yet</span>
              ) : (
                query.data.renewals.map((renewal) => (
                  <div key={renewal.id}>
                    <SummaryLine contract={renewal} />
                  </div>
                ))
              )}
            </dd>
          </div>
        </dl>
      )}
      {query.data && canRenew && (
        <div className="mt-4">
          {open ? (
            <p className="text-sm text-slate-600">This contract already has a renewal. Open it above, or cancel it to renew again.</p>
          ) : (
            <Button size="sm" onClick={onRenew}>
              Create renewal
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

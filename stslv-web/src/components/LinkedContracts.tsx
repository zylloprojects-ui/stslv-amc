import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/context'
import { api, ApiError } from '../lib/api'
import type { Paged } from '../lib/types'
import { queryString } from '../pages/amc/amcApi'
import { formatDate, formatMoney } from '../pages/amc/amcFormat'
import { ContractStatusPill } from '../pages/amc/components'
import { frequencyLabel, type Contract } from '../pages/amc/types'
import { LoadError } from './records'
import { TABLE } from './table'
import { EmptyState, Spinner } from './ui'

const LIMIT = 50

/**
 * The AMC contracts of a client or of a sales engineer, every status, each
 * linking to its contract page. Needs AMC contract access; read-only.
 */
export function LinkedContracts({ filter, emptyTitle }: { filter: { clientId: string } | { salesEngineerId: string }; emptyTitle: string }) {
  const auth = useAuth()
  const canView = auth.can('AMC_CONTRACTS', 'VIEW')
  const contracts = useQuery({
    queryKey: ['amc', 'contracts', 'linked', filter],
    queryFn: () => api.get<Paged<Contract>>(`/amc/contracts${queryString({ ...filter, status: 'all', pageSize: LIMIT })}`),
    enabled: canView,
    retry: false,
  })

  if (!canView) return <p className="px-6 py-4 text-sm text-slate-600">Your role does not include access to AMC contracts.</p>
  if (contracts.isPending) return <Spinner size="sm" label="Loading contracts" />
  if (contracts.isError) {
    if (contracts.error instanceof ApiError && contracts.error.code === 'FEATURE_UNAVAILABLE') {
      return <p className="px-6 py-4 text-sm text-slate-600">Contracts are linked to sales engineers once the database update (migration 0070) is applied.</p>
    }

    return <LoadError error={contracts.error} onRetry={() => void contracts.refetch()} />
  }
  if (contracts.data.items.length === 0) return <EmptyState title={emptyTitle} />

  const data = contracts.data

  return (
    <>
      <div className={TABLE.wrapper}>
        <table className={TABLE.table}>
          <caption className="sr-only">AMC contracts</caption>
          <thead>
            <tr>
              <th scope="col" className={TABLE.th}>
                Contract
              </th>
              <th scope="col" className={TABLE.th}>
                Validity
              </th>
              <th scope="col" className={TABLE.th}>
                Frequency
              </th>
              <th scope="col" className={`${TABLE.th} text-right`}>
                Contract value
              </th>
              <th scope="col" className={TABLE.th}>
                Status
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.items.map((contract) => (
              <tr key={contract.id}>
                <td className={TABLE.td}>
                  <Link to={`/amc/contracts/${contract.id}`} className="font-semibold text-[#0b3b66] hover:text-[#1479BD] hover:underline">
                    {contract.client.name} — {contract.systemDescription}
                  </Link>
                  {contract.responsibleEngineer && <span className="mt-0.5 block text-xs text-slate-500">Engineer: {contract.responsibleEngineer}</span>}
                </td>
                <td className={`${TABLE.td} whitespace-nowrap text-slate-700`}>
                  {formatDate(contract.validFrom)} – {formatDate(contract.validTo)}
                </td>
                <td className={TABLE.td}>
                  <span className="inline-flex rounded-full bg-sky-50 px-2.5 py-0.5 text-xs font-semibold text-[#0b3b66] ring-1 ring-inset ring-sky-200">{frequencyLabel(contract.maintenanceFrequency)}</span>
                </td>
                <td className={`${TABLE.td} whitespace-nowrap text-right font-bold tabular-nums text-[#0b3b66]`}>{formatMoney(contract.contractValue)}</td>
                <td className={TABLE.td}>
                  <ContractStatusPill status={contract.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.total > data.items.length && (
        <p className="border-t border-slate-200 px-6 py-3 text-sm text-slate-600">
          Showing {data.items.length} of {data.total} contracts. The full list is in AMC Contracts.
        </p>
      )}
    </>
  )
}

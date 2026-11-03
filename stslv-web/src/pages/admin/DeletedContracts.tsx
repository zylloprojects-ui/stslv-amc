import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { LoadError } from '../../components/records'
import { TABLE } from '../../components/table'
import { Alert, Button, Card, ConfirmDialog, Spinner } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { cx, formatDate, formatDateTime } from '../../lib/format'
import { refreshOperationalData } from '../../lib/refreshOperationalData'
import { amcReference } from '../amc/calendar/calendarTypes'

export interface DeletedContract {
  id: string
  client: { id: string; name: string }
  systemDescription: string
  validFrom: string
  validTo: string
  status: string
  contractValue: string | null
  services: number
  invoices: number
  documents: number
  deletedAt: string
  deletedBy: string | null
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

const DELETED_CONTRACTS_KEY = ['security', 'recycle-bin', 'amc-contracts'] as const

/**
 * AMC contracts in the Recycle Bin (migration 0101). Super Admin only: the API refuses everyone else.
 * Nothing was removed from these contracts; Restore brings back the same contract, number and services.
 */
export function DeletedContracts() {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState<DeletedContract | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const list = useQuery({ queryKey: DELETED_CONTRACTS_KEY, queryFn: () => api.get<DeletedContract[]>('/security/recycle-bin/amc-contracts') })
  const restore = useMutation({
    mutationFn: (contract: DeletedContract) => api.post(`/security/recycle-bin/amc-contracts/${contract.id}/restore`),
    onMutate: () => setNotice(null),
    onSuccess: async (_result, contract) => {
      setConfirming(null)
      await Promise.all([refreshOperationalData(queryClient), queryClient.invalidateQueries({ queryKey: ['security'] })])
      setNotice(`${amcReference(contract.id)} (${contract.client.name}, ${contract.systemDescription}) was restored.`)
    },
  })
  const items = list.data ?? []

  return (
    <Card className="mb-4 overflow-hidden rounded-2xl">
      <section aria-labelledby="deleted-contracts-heading">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 bg-gradient-to-r from-red-50 via-white to-white px-5 py-3">
          <h2 id="deleted-contracts-heading" className="text-base font-semibold text-slate-900">
            Deleted AMC contracts
            {list.data && <span className="ml-2 text-sm font-normal text-slate-500">{items.length}</span>}
          </h2>
          <p className="text-xs text-slate-600">Kept in full with their services, invoices and documents. Super Admin can restore them.</p>
        </div>
        {notice && (
          <div role="status" className="border-b border-emerald-200 bg-emerald-50 px-5 py-2.5 text-sm text-emerald-900">
            {notice}
          </div>
        )}
        {list.isPending && <Spinner label="Loading deleted AMC contracts" />}
        {list.isError && <LoadError error={list.error} onRetry={() => void list.refetch()} />}
        {list.data && items.length === 0 && <p className="px-5 py-4 text-sm text-slate-600">No AMC contracts are in the Recycle Bin.</p>}
        {items.length > 0 && (
          <div className={TABLE.wrapper}>
            <table className={cx(TABLE.table, 'table-compact')}>
              <caption className="sr-only">Deleted AMC contracts</caption>
              <thead>
                <tr>
                  {['AMC No.', 'Client and system', 'Validity', 'Status', 'Kept', 'Deleted', 'Action'].map((heading) => (
                    <th key={heading} scope="col" className={TABLE.th}>
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((contract) => (
                  <tr key={contract.id} className={TABLE.row}>
                    <td className={cx(TABLE.td, 'whitespace-nowrap font-mono text-xs font-bold text-slate-700')}>{amcReference(contract.id)}</td>
                    <td className={TABLE.td}>
                      <span className="block font-semibold text-[#0b3b66]">{contract.client.name}</span>
                      <span className="text-xs text-slate-600">{contract.systemDescription}</span>
                    </td>
                    <td className={cx(TABLE.td, 'whitespace-nowrap text-sm')}>
                      {formatDate(contract.validFrom)} – {formatDate(contract.validTo)}
                    </td>
                    <td className={cx(TABLE.td, 'whitespace-nowrap text-sm')}>{contract.status.charAt(0) + contract.status.slice(1).toLowerCase()}</td>
                    <td className={cx(TABLE.td, 'whitespace-nowrap text-xs text-slate-700')}>
                      {plural(contract.services, 'service')} · {plural(contract.invoices, 'invoice')} · {plural(contract.documents, 'document')}
                    </td>
                    <td className={cx(TABLE.td, 'whitespace-nowrap text-xs text-slate-700')}>
                      <time dateTime={contract.deletedAt}>{formatDateTime(contract.deletedAt)}</time>
                      <span className="block text-slate-500">{contract.deletedBy ?? 'Unknown user'}</span>
                    </td>
                    <td className={TABLE.td}>
                      <Button
                        variant="secondary"
                        aria-label={`Restore ${amcReference(contract.id)} ${contract.client.name} ${contract.systemDescription}`}
                        onClick={() => {
                          restore.reset()
                          setConfirming(contract)
                        }}
                      >
                        Restore
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {confirming && (
        <ConfirmDialog
          title="Restore AMC contract"
          message={
            <>
              Restore <strong>{amcReference(confirming.id)}</strong> for <strong>{confirming.client.name}</strong> ({confirming.systemDescription})?
              <span className="mt-2 block text-sm">
                It returns to AMC Contracts, schedules, the calendar, Accounts and the dashboard figures with the same number, services and history.
              </span>
            </>
          }
          confirmLabel="Restore contract"
          loading={restore.isPending}
          error={restore.isError ? errorMessage(restore.error) : null}
          onConfirm={() => restore.mutate(confirming)}
          onCancel={() => {
            restore.reset()
            setConfirming(null)
          }}
        />
      )}
      {restore.isError && !confirming && <Alert>{errorMessage(restore.error)}</Alert>}
    </Card>
  )
}

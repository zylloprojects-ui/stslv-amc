import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/context'
import { Alert, Button, Card, EmptyState, PageHeader, Spinner } from '../../components/ui'
import { TABLE } from '../../components/table'
import { api, errorMessage } from '../../lib/api'
import type { Paged } from '../../lib/types'
import { fetchClients, queryString } from './amcApi'
import { formatDate, formatMoney } from './amcFormat'
import { ContractStatusPill, Filter, Pager, Pill } from './components'
import { ContractDetailsModal } from './ContractDetailsModal'
import { ContractFormModal } from './ContractFormModal'
import { ContractStatusDialog } from './ContractStatusDialog'
import {
  CONTRACT_STATUSES,
  CONTRACT_STATUS_LABELS,
  FREQUENCY_LABELS,
  MAINTENANCE_FREQUENCIES,
  type Contract,
  type ContractStatus,
  type SavedContract,
} from './types'

const PAGE_SIZE = 25

type Dialog =
  | { kind: 'none' }
  | { kind: 'create' }
  | { kind: 'edit'; contract: Contract }
  | { kind: 'view'; contractId: string }
  | { kind: 'status'; contract: Contract; status: ContractStatus }

function scheduleNote(saved: SavedContract): string {
  const change = saved.scheduleChange
  const parts: string[] = []

  if (change && change.created > 0) parts.push(`${change.created} visit(s) added to the schedule`)
  if (change && change.removed > 0) parts.push(`${change.removed} untouched visit(s) removed`)
  if (saved.cancelledVisits) parts.push(`${saved.cancelledVisits} visit(s) cancelled`)

  return parts.length > 0 ? ` ${parts.join(', ')}.` : ''
}

export function AmcContractsPage() {
  const auth = useAuth()

  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<ContractStatus | 'all'>('all')
  const [clientId, setClientId] = useState('')
  const [frequency, setFrequency] = useState('')
  const [page, setPage] = useState(1)
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' })
  const [notice, setNotice] = useState<string | null>(null)

  // Wait for a pause in typing before searching.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 300)

    return () => clearTimeout(timer)
  }, [searchInput])

  const canViewClients = auth.can('CLIENTS', 'VIEW')
  const clients = useQuery({ queryKey: ['clients', 'all'], queryFn: () => fetchClients('all'), enabled: canViewClients })

  const contracts = useQuery({
    queryKey: ['amc', 'contracts', 'list', { search, status, clientId, frequency, page }],
    queryFn: () =>
      api.get<Paged<Contract>>(`/amc/contracts${queryString({ search, status, clientId, frequency, page, pageSize: PAGE_SIZE })}`),
    placeholderData: keepPreviousData,
  })

  const canCreate = auth.can('AMC_CONTRACTS', 'CREATE')
  const canEdit = auth.can('AMC_CONTRACTS', 'EDIT')
  const canCancel = auth.can('AMC_CONTRACTS', 'DELETE')

  const data = contracts.data
  const filtered = search !== '' || status !== 'all' || clientId !== '' || frequency !== ''
  const closeDialog = () => setDialog({ kind: 'none' })
  const label = (contract: Contract) => `${contract.client.name} ${contract.systemDescription}`

  return (
    <>
      <PageHeader
        title="AMC Contracts"
        description="Maintenance contracts. An active contract generates its visit schedule from its validity period and frequency."
        actions={canCreate && <Button onClick={() => setDialog({ kind: 'create' })}>Add Contract</Button>}
      />

      {notice && (
        <div className="mb-4">
          <Alert tone="success">{notice}</Alert>
        </div>
      )}

      <Card>
        <div className="grid gap-4 border-b border-slate-200 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Filter label="Search">
            {(id, className) => (
              <input
                id={id}
                type="search"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Client, system, engineer or description"
                className={className}
              />
            )}
          </Filter>
          {canViewClients && (
            <Filter label="Client">
              {(id, className) => (
                <select
                  id={id}
                  value={clientId}
                  onChange={(event) => {
                    setClientId(event.target.value)
                    setPage(1)
                  }}
                  className={className}
                >
                  <option value="">All clients</option>
                  {(clients.data ?? []).map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.name}
                    </option>
                  ))}
                </select>
              )}
            </Filter>
          )}
          <Filter label="Status">
            {(id, className) => (
              <select
                id={id}
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value as ContractStatus | 'all')
                  setPage(1)
                }}
                className={className}
              >
                <option value="all">All statuses</option>
                {CONTRACT_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {CONTRACT_STATUS_LABELS[value]}
                  </option>
                ))}
              </select>
            )}
          </Filter>
          <Filter label="Frequency">
            {(id, className) => (
              <select
                id={id}
                value={frequency}
                onChange={(event) => {
                  setFrequency(event.target.value)
                  setPage(1)
                }}
                className={className}
              >
                <option value="">All frequencies</option>
                {MAINTENANCE_FREQUENCIES.map((value) => (
                  <option key={value} value={value}>
                    {FREQUENCY_LABELS[value]}
                  </option>
                ))}
              </select>
            )}
          </Filter>
        </div>

        {contracts.isPending && <Spinner label="Loading contracts" />}

        {contracts.isError && (
          <div className="p-4">
            <Alert>
              {errorMessage(contracts.error)}{' '}
              <button type="button" className="font-medium underline" onClick={() => void contracts.refetch()}>
                Try again
              </button>
            </Alert>
          </div>
        )}

        {data && data.items.length === 0 && (
          <EmptyState
            title={filtered ? 'No contracts match your filters' : 'No AMC contracts yet'}
            description={
              filtered ? 'Try a different search or filter.' : 'Add a contract to generate its maintenance schedule automatically.'
            }
            action={!filtered && canCreate ? <Button onClick={() => setDialog({ kind: 'create' })}>Add Contract</Button> : undefined}
          />
        )}

        {data && data.items.length > 0 && (
          <>
            <div className={TABLE.wrapper}>
              <table className={TABLE.table}>
                <caption className="sr-only">AMC contracts</caption>
                <thead>
                  <tr>
                    <th scope="col" className={TABLE.th}>
                      Client
                    </th>
                    <th scope="col" className={TABLE.th}>
                      System
                    </th>
                    <th scope="col" className={TABLE.th}>
                      Engineer
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
                      Visits
                    </th>
                    <th scope="col" className={TABLE.th}>
                      Status
                    </th>
                    <th scope="col" className={`${TABLE.th} text-right`}>
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.items.map((contract) => (
                    <tr key={contract.id} className={TABLE.row}>
                      <td className={`${TABLE.td} min-w-40 font-medium text-slate-900`}>{contract.client.name}</td>
                      <td className={TABLE.td}>{contract.systemDescription}</td>
                      <td className={TABLE.td}>{contract.responsibleEngineer ?? '—'}</td>
                      <td className={`${TABLE.td} whitespace-nowrap`}>
                        {formatDate(contract.validFrom)} – {formatDate(contract.validTo)}
                      </td>
                      <td className={TABLE.td}>{FREQUENCY_LABELS[contract.maintenanceFrequency]}</td>
                      <td className={`${TABLE.td} whitespace-nowrap text-right tabular-nums`}>{formatMoney(contract.contractValue)}</td>
                      <td className={`${TABLE.td} whitespace-nowrap`}>
                        {contract.schedule.visitCount === 0 ? '—' : `${contract.schedule.completedCount} of ${contract.schedule.visitCount} completed`}
                      </td>
                      <td className={TABLE.td}>
                        <span className="inline-flex flex-wrap items-center gap-1">
                          <ContractStatusPill status={contract.status} />
                          {contract.isPastValidity && contract.status === 'ACTIVE' && <Pill tone="amber">Validity ended</Pill>}
                        </span>
                      </td>
                      <td className={`${TABLE.td} whitespace-nowrap text-right`}>
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`View ${label(contract)}`}
                            onClick={() => setDialog({ kind: 'view', contractId: contract.id })}
                          >
                            View
                          </Button>
                          {canEdit && (
                            <Button variant="ghost" size="sm" aria-label={`Edit ${label(contract)}`} onClick={() => setDialog({ kind: 'edit', contract })}>
                              Edit
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} shown={data.items.length} onPage={setPage} />
          </>
        )}
      </Card>

      {(dialog.kind === 'create' || dialog.kind === 'edit') && (
        <ContractFormModal
          contract={dialog.kind === 'edit' ? dialog.contract : null}
          onClose={closeDialog}
          onSaved={(saved) => {
            setNotice(`The contract for ${label(saved)} was ${dialog.kind === 'edit' ? 'updated' : 'added'}.${scheduleNote(saved)}`)
            closeDialog()
          }}
        />
      )}

      {dialog.kind === 'view' && (
        <ContractDetailsModal
          contractId={dialog.contractId}
          canEdit={canEdit}
          canCancel={canCancel}
          canViewSchedule={auth.can('AMC_SCHEDULE', 'VIEW')}
          onEdit={(contract) => setDialog({ kind: 'edit', contract })}
          onChangeStatus={(contract, next) => setDialog({ kind: 'status', contract, status: next })}
          onClose={closeDialog}
        />
      )}

      {dialog.kind === 'status' && (
        <ContractStatusDialog
          contract={dialog.contract}
          status={dialog.status}
          onClose={() => setDialog({ kind: 'view', contractId: dialog.contract.id })}
          onChanged={(saved) => {
            setNotice(`The contract for ${label(saved)} is now ${CONTRACT_STATUS_LABELS[saved.status]}.${scheduleNote(saved)}`)
            setDialog({ kind: 'view', contractId: saved.id })
          }}
        />
      )}
    </>
  )
}

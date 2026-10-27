import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Pager } from '../../components/records'
import { TABLE } from '../../components/table'
import { Alert, Badge, Button, ConfirmDialog, EmptyState, Modal, Spinner, TableScroll } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { formatDate } from '../../lib/format'
import { CONTRACT_STATUS_LABELS, type ContractStatus } from '../amc/types'
import type { MasterList, SystemType } from './masterTypes'

// The dialogs of the System Types page: the AMC contracts that use a type
// (read only), and the confirmation before an unused type is deleted.

const PAGE_SIZE = 10

/** GET /api/masters/system-types/:id/contracts */
export interface LinkedContract {
  id: string
  client: { id: string; name: string }
  systemDescription: string
  validFrom: string
  validTo: string
  status: ContractStatus
}

const STATUS_TONES: Record<ContractStatus, 'green' | 'slate' | 'blue' | 'amber'> = { ACTIVE: 'green', DRAFT: 'blue', EXPIRED: 'amber', CANCELLED: 'slate' }

export function LinkedContractsModal({ type, onClose }: { type: SystemType; onClose: () => void }) {
  const [page, setPage] = useState(1)
  const contracts = useQuery({
    queryKey: ['masters', 'system-types', type.id, 'contracts', page],
    queryFn: () => api.get<MasterList<LinkedContract>>(`/masters/system-types/${type.id}/contracts?page=${page}&pageSize=${PAGE_SIZE}`),
    placeholderData: keepPreviousData,
  })
  const data = contracts.data

  return (
    <Modal
      title={`AMC contracts using ${type.code} — ${type.name}`}
      size="lg"
      onClose={onClose}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      {contracts.isPending && <Spinner label="Loading contracts" />}
      {contracts.isError && <Alert>{errorMessage(contracts.error)}</Alert>}
      {data && data.items.length === 0 && <EmptyState title="No AMC contracts use this system type" />}
      {data && data.items.length > 0 && (
        <>
          <TableScroll label="Linked AMC contracts">
            <table className={TABLE.table}>
              <caption className="sr-only">AMC contracts using {type.name}</caption>
              <thead>
                <tr>
                  <th scope="col" className={TABLE.th}>
                    Client
                  </th>
                  <th scope="col" className={TABLE.th}>
                    System
                  </th>
                  <th scope="col" className={TABLE.th}>
                    Validity
                  </th>
                  <th scope="col" className={TABLE.th}>
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.items.map((contract) => (
                  <tr key={contract.id} className={TABLE.row}>
                    <td className={`${TABLE.td} ${TABLE.text}`}>
                      <Link to={`/amc/contracts/${contract.id}`} className="font-semibold text-slate-900 hover:text-[#1479BD] hover:underline">
                        {contract.client.name}
                      </Link>
                    </td>
                    <td className={`${TABLE.td} ${TABLE.text}`}>{contract.systemDescription}</td>
                    <td className={`${TABLE.td} whitespace-nowrap`}>
                      {formatDate(contract.validFrom)} – {formatDate(contract.validTo)}
                    </td>
                    <td className={TABLE.td}>
                      <Badge tone={STATUS_TONES[contract.status] ?? 'slate'}>{CONTRACT_STATUS_LABELS[contract.status] ?? contract.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
          <Pager page={data.page} pageSize={data.pageSize} shown={data.items.length} total={data.total} onPage={setPage} />
        </>
      )}
    </Modal>
  )
}

/**
 * Confirms deleting an unused type. The page offers it only when no contract
 * uses the type; the API checks again and explains a refusal, which shows here.
 */
export function DeleteSystemTypeModal({ type, onClose, onDeleted }: { type: SystemType; onClose: () => void; onDeleted: (message: string) => void }) {
  const queryClient = useQueryClient()
  const remove = useMutation({
    mutationFn: () => api.delete(`/masters/system-types/${type.id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['masters'] })
      onDeleted(`The system type "${type.name}" was deleted.`)
    },
  })

  return (
    <ConfirmDialog
      title="Delete system type"
      message={
        <>
          <p>
            Delete <strong>{type.code} — {type.name}</strong>? No AMC contract uses it. This cannot be undone; the activity log keeps a record of it.
          </p>
          <p className="mt-2 text-slate-500">To stop offering it for new contracts but keep it, disable it instead.</p>
        </>
      }
      confirmLabel="Delete"
      danger
      loading={remove.isPending}
      error={remove.isError ? errorMessage(remove.error) : null}
      onConfirm={() => remove.mutate()}
      onCancel={onClose}
    />
  )
}

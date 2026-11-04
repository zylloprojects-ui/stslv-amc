import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Pager } from '../../components/records'
import { TABLE } from '../../components/table'
import { Alert, Badge, Button, EmptyState, Modal, Spinner, TableScroll } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { formatDate } from '../../lib/format'
import { CONTRACT_STATUS_LABELS, type ContractStatus } from '../amc/types'
import type { MasterList, SystemType } from './masterTypes'

// The AMC contracts that use a system type (read only). Delete is the shared
// MoveToRecycleBinDialog (components/MoveToRecycleBinDialog.tsx).

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

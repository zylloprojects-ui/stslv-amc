import { Link } from 'react-router-dom'
import { Money, ProcurementStatusBadge } from '../../components/records'
import { TABLE } from '../../components/table'
import { Button } from '../../components/ui'
import { formatDate } from '../../lib/format'
import type { ProcurementRequest } from '../../lib/projectTypes'
import type { ProcurementDialog } from './ProcurementDialogs'

interface ProcurementTableProps {
  items: ProcurementRequest[]
  /** Hidden on a project's own page, where every row belongs to that project. */
  showProject: boolean
  canEdit: boolean
  /** Whether the job number links to the project page. */
  linkProject: boolean
  onDialog: (dialog: ProcurementDialog) => void
}

export function ProcurementTable({ items, showProject, canEdit, linkProject, onDialog }: ProcurementTableProps) {
  return (
    <div className={TABLE.wrapper}>
      <table className={TABLE.table}>
        <caption className="sr-only">Procurement requests</caption>
        <thead>
          <tr>
            {showProject && (
              <th scope="col" className={TABLE.th}>
                Job number
              </th>
            )}
            <th scope="col" className={TABLE.th}>
              Requirement
            </th>
            <th scope="col" className={TABLE.th}>
              Request date
            </th>
            <th scope="col" className={TABLE.th}>
              Supplier
            </th>
            <th scope="col" className={TABLE.th}>
              Quotation ref.
            </th>
            <th scope="col" className={`${TABLE.th} text-right`}>
              Quotation amount
            </th>
            <th scope="col" className={TABLE.th}>
              Expected delivery
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
          {items.map((request) => (
            <tr key={request.id} className={TABLE.row}>
              {showProject && (
                <td className={`${TABLE.td} whitespace-nowrap font-medium`}>
                  {linkProject ? (
                    <Link to={`/projects/${request.projectId}`} className="text-blue-700 hover:underline">
                      {request.jobNumber}
                    </Link>
                  ) : (
                    request.jobNumber
                  )}
                  <div className="text-xs font-normal text-slate-500">{request.clientName}</div>
                </td>
              )}
              <td className={`${TABLE.td} min-w-56`}>{request.description}</td>
              <td className={`${TABLE.td} whitespace-nowrap`}>{formatDate(request.requestDate)}</td>
              <td className={TABLE.td}>{request.supplierName ?? '—'}</td>
              <td className={TABLE.td}>{request.quotationReference ?? '—'}</td>
              <td className={`${TABLE.td} text-right`}>
                <Money value={request.quotationAmount} />
              </td>
              <td className={`${TABLE.td} whitespace-nowrap`}>{formatDate(request.expectedDeliveryDate)}</td>
              <td className={TABLE.td}>
                <ProcurementStatusBadge status={request.status} />
              </td>
              <td className={`${TABLE.td} whitespace-nowrap text-right`}>
                <div className="flex justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`View request ${request.description}`}
                    onClick={() => onDialog({ kind: 'view', requestId: request.id })}
                  >
                    View
                  </Button>
                  {canEdit && request.status !== 'CANCELLED' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Edit request ${request.description}`}
                      onClick={() => onDialog({ kind: 'edit', request })}
                    >
                      Edit
                    </Button>
                  )}
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Update status of request ${request.description}`}
                      onClick={() => onDialog({ kind: 'status', request })}
                    >
                      Status
                    </Button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

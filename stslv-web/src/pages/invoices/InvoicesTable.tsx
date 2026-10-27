import { Money } from '../../components/records'
import { TABLE } from '../../components/table'
import { Badge, Button } from '../../components/ui'
import { cx, formatDate } from '../../lib/format'
import { allocationLabel, INVOICE_STATUS_LABELS, type Invoice } from '../../lib/invoiceTypes'
import type { InvoiceDialog } from './InvoiceDialogs'

interface InvoicesTableProps {
  items: Invoice[]
  /** Hidden on a project's own page, where every row belongs to that project's client. */
  showClient: boolean
  canEdit: boolean
  onDialog: (dialog: InvoiceDialog) => void
  /** How many rows come before the first one shown (earlier pages), so the serial numbers carry on. */
  startAt?: number
}

export function InvoiceStatusBadge({ status }: { status: Invoice['status'] }) {
  return <Badge tone={status === 'ISSUED' ? 'green' : 'slate'}>{INVOICE_STATUS_LABELS[status]}</Badge>
}

export function InvoicesTable({ items, showClient, canEdit, onDialog, startAt = 0 }: InvoicesTableProps) {
  return (
    <div className={TABLE.wrapper}>
      <table className={TABLE.table}>
        <caption className="sr-only">Invoices</caption>
        <thead>
          <tr>
            <th scope="col" className={TABLE.snHead}>
              #
            </th>
            <th scope="col" className={TABLE.th}>
              Invoice no.
            </th>
            <th scope="col" className={TABLE.th}>
              Invoice date
            </th>
            {showClient && (
              <th scope="col" className={TABLE.th}>
                Client
              </th>
            )}
            <th scope="col" className={TABLE.th}>
              Covers
            </th>
            <th scope="col" className={`${TABLE.th} text-right`}>
              Excl. VAT
            </th>
            <th scope="col" className={`${TABLE.th} text-right`}>
              VAT
            </th>
            <th scope="col" className={`${TABLE.th} text-right`}>
              Total
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
          {items.map((invoice, index) => {
            const cancelled = invoice.status === 'CANCELLED'

            return (
              <tr key={invoice.id} className={cx(TABLE.row, cancelled && 'bg-slate-50 text-slate-400')}>
                <td className={TABLE.sn}>{startAt + index + 1}</td>
                <td className={`${TABLE.td} whitespace-nowrap font-medium`}>{invoice.invoiceNumber}</td>
                <td className={`${TABLE.td} whitespace-nowrap`}>{formatDate(invoice.invoiceDate)}</td>
                {showClient && <td className={`${TABLE.td} ${TABLE.text}`}>{invoice.client.name}</td>}
                <td className={`${TABLE.td} min-w-56`}>
                  <ul className="space-y-1">
                    {invoice.allocations.map((allocation) => (
                      <li key={allocation.id}>
                        {allocationLabel(allocation, formatDate)}
                        {invoice.allocations.length > 1 && (
                          <span className="text-slate-500">
                            {' '}
                            · <Money value={allocation.amount} />
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                  {cancelled && <p className="mt-1 text-xs text-slate-500">Cancelled: {invoice.cancellationReason}</p>}
                </td>
                <td className={cx(TABLE.td, 'text-right font-medium', cancelled && 'line-through')}>
                  <Money value={invoice.amountExclVat} />
                </td>
                <td className={cx(TABLE.td, 'text-right', cancelled && 'line-through')}>
                  <Money value={invoice.vatAmount} />
                </td>
                <td className={cx(TABLE.td, 'text-right', cancelled && 'line-through')}>
                  <Money value={invoice.totalAmount} />
                </td>
                <td className={`${TABLE.td} whitespace-nowrap`}>
                  <InvoiceStatusBadge status={invoice.status} />
                </td>
                <td className={`${TABLE.td} whitespace-nowrap text-right`}>
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`View invoice ${invoice.invoiceNumber}`}
                      onClick={() => onDialog({ kind: 'view', invoiceId: invoice.id })}
                    >
                      View
                    </Button>
                    {canEdit && !cancelled && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Edit invoice ${invoice.invoiceNumber}`}
                          onClick={() => onDialog({ kind: 'edit', invoice })}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-700 hover:bg-red-50"
                          aria-label={`Cancel invoice ${invoice.invoiceNumber}`}
                          onClick={() => onDialog({ kind: 'cancel', invoice })}
                        >
                          Cancel
                        </Button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

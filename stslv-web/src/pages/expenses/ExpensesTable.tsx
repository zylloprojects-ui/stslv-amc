import { ActionButton, ActionGroup } from '../../components/IconActions'
import { Money } from '../../components/records'
import { TABLE } from '../../components/table'
import { Badge } from '../../components/ui'
import { cx, formatDate } from '../../lib/format'
import type { Expense } from '../../lib/projectTypes'
import type { ExpenseDialog } from './ExpenseDialogs'

interface ExpensesTableProps {
  items: Expense[]
  /** Hidden on a project's own page, where every row belongs to that project. */
  showProject: boolean
  canEdit: boolean
  canVoid: boolean
  onDialog: (dialog: ExpenseDialog) => void
  /** How many rows come before the first one shown (earlier pages), so the serial numbers carry on. */
  startAt?: number
}

export function ExpensesTable({ items, showProject, canEdit, canVoid, onDialog, startAt = 0 }: ExpensesTableProps) {
  return (
    <div className={TABLE.wrapper}>
      <table className={TABLE.table}>
        <caption className="sr-only">Project expenses</caption>
        <thead>
          <tr>
            <th scope="col" className={TABLE.snHead}>
              #
            </th>
            <th scope="col" className={TABLE.th}>
              Date
            </th>
            {showProject && (
              <th scope="col" className={TABLE.th}>
                Job number
              </th>
            )}
            <th scope="col" className={TABLE.th}>
              Category
            </th>
            <th scope="col" className={TABLE.th}>
              Description
            </th>
            <th scope="col" className={TABLE.th}>
              Supplier / payee
            </th>
            <th scope="col" className={TABLE.th}>
              Reference
            </th>
            <th scope="col" className={`${TABLE.th} text-right`}>
              Amount
            </th>
            <th scope="col" className={`${TABLE.th} text-right`}>
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {items.map((expense, index) => (
            <tr key={expense.id} className={cx(TABLE.row, expense.isVoided && 'bg-slate-50 text-slate-400')}>
              <td className={TABLE.sn}>{startAt + index + 1}</td>
              <td className={`${TABLE.td} whitespace-nowrap`}>{formatDate(expense.expenseDate)}</td>
              {showProject && (
                <td className={`${TABLE.td} whitespace-nowrap font-medium`}>
                  {expense.jobNumber}
                  <div className="text-xs font-normal text-slate-500">{expense.clientName}</div>
                </td>
              )}
              <td className={`${TABLE.td} whitespace-nowrap`}>{expense.categoryName}</td>
              <td className={`${TABLE.td} min-w-56`}>
                {expense.description}
                {expense.isVoided && (
                  <div className="mt-1">
                    <Badge tone="slate">Voided</Badge> <span className="text-xs text-slate-500">{expense.voidReason}</span>
                  </div>
                )}
              </td>
              <td className={TABLE.td}>{expense.payeeName ?? '—'}</td>
              <td className={TABLE.td}>{expense.paymentReference ?? '—'}</td>
              <td className={cx(TABLE.td, 'text-right font-medium', expense.isVoided && 'line-through')}>
                <Money value={expense.amount} />
              </td>
              <td className={`${TABLE.td} whitespace-nowrap text-right`}>
                <ActionGroup>
                  <ActionButton label={`View expense ${expense.description}`} icon="view" onClick={() => onDialog({ kind: 'view', expenseId: expense.id })} />
                  {canEdit && !expense.isVoided && <ActionButton label={`Edit expense ${expense.description}`} icon="edit" onClick={() => onDialog({ kind: 'edit', expense })} />}
                  {canVoid && !expense.isVoided && <ActionButton danger label={`Void expense ${expense.description}`} icon="void" onClick={() => onDialog({ kind: 'void', expense })} />}
                </ActionGroup>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

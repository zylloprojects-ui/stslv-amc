import { useQuery } from '@tanstack/react-query'
import { Alert, Button, Modal, Spinner } from '../../components/ui'
import { TABLE } from '../../components/table'
import { api, errorMessage } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { formatDate, formatMoney, isZeroMoney } from './amcFormat'
import { ContractStatusPill, DetailRow, EligibilityPill, OrDash, PlannedDate, VisitStatusPill } from './components'
import { FREQUENCY_LABELS, type Contract, type ContractStatus, type VisitList } from './types'

interface ContractDetailsModalProps {
  contractId: string
  canEdit: boolean
  /** Cancelling a contract needs its own permission. */
  canCancel: boolean
  /** Whether the user may see the schedule (visit dates and amounts). */
  canViewSchedule: boolean
  onEdit: (contract: Contract) => void
  onChangeStatus: (contract: Contract, status: ContractStatus) => void
  onClose: () => void
}

export function ContractDetailsModal({ contractId, canEdit, canCancel, canViewSchedule, onEdit, onChangeStatus, onClose }: ContractDetailsModalProps) {
  // Always read the record again, so the details shown are the stored values.
  const query = useQuery({ queryKey: ['amc', 'contracts', 'detail', contractId], queryFn: () => api.get<Contract>(`/amc/contracts/${contractId}`) })
  const visits = useQuery({
    queryKey: ['amc', 'visits', 'contract', contractId],
    queryFn: () => api.get<VisitList>(`/amc/visits?contractId=${contractId}&pageSize=200`),
    enabled: canViewSchedule,
  })
  const contract = query.data

  return (
    <Modal
      title="AMC contract details"
      onClose={onClose}
      size="xl"
      footer={
        <>
          {contract && canEdit && contract.status === 'DRAFT' && <Button onClick={() => onChangeStatus(contract, 'ACTIVE')}>Activate</Button>}
          {contract && canEdit && contract.status === 'ACTIVE' && (
            <Button variant="secondary" onClick={() => onChangeStatus(contract, 'EXPIRED')}>
              Mark as expired
            </Button>
          )}
          {contract && canEdit && (contract.status === 'EXPIRED' || contract.status === 'CANCELLED') && (
            <Button variant="secondary" onClick={() => onChangeStatus(contract, 'ACTIVE')}>
              Reactivate
            </Button>
          )}
          {contract && canEdit && canCancel && (contract.status === 'DRAFT' || contract.status === 'ACTIVE') && (
            <Button variant="danger" onClick={() => onChangeStatus(contract, 'CANCELLED')}>
              Cancel contract
            </Button>
          )}
          {contract && canEdit && (
            <Button variant="secondary" onClick={() => onEdit(contract)}>
              Edit
            </Button>
          )}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {query.isPending && <Spinner size="sm" label="Loading contract" />}
      {query.isError && <Alert>{errorMessage(query.error)}</Alert>}

      {contract && (
        <div className="space-y-6">
          {contract.isPastValidity && contract.status === 'ACTIVE' && (
            <Alert tone="info">The validity period of this contract ended on {formatDate(contract.validTo)}. It is still marked Active.</Alert>
          )}

          <div className="grid gap-x-8 lg:grid-cols-2">
            <dl>
              <DetailRow label="Client">
                {contract.client.name}
                {!contract.client.isActive && ' (inactive)'}
              </DetailRow>
              <DetailRow label="System">{contract.systemDescription}</DetailRow>
              <DetailRow label="Status">
                <ContractStatusPill status={contract.status} />
              </DetailRow>
              <DetailRow label="Responsible engineer">
                <OrDash value={contract.responsibleEngineer} />
              </DetailRow>
              <DetailRow label="Validity">
                {formatDate(contract.validFrom)} to {formatDate(contract.validTo)}
              </DetailRow>
              <DetailRow label="Frequency">{FREQUENCY_LABELS[contract.maintenanceFrequency]}</DetailRow>
              <DetailRow label="Description">
                <OrDash value={contract.description} />
              </DetailRow>
              <DetailRow label="Notes">
                <OrDash value={contract.notes} />
              </DetailRow>
            </dl>
            <dl>
              <DetailRow label="Contract value">{formatMoney(contract.contractValue)}</DetailRow>
              <DetailRow label="Default visit amount">{formatMoney(contract.defaultVisitAmount)}</DetailRow>
              <DetailRow label="Final credit">{formatMoney(contract.finalCredit)}</DetailRow>
              <DetailRow label="Visits">
                {contract.schedule.visitCount} ({contract.schedule.completedCount} completed, {contract.schedule.openCount} open
                {contract.schedule.historicalCount > 0 && `, ${contract.schedule.historicalCount} historical`}
                {contract.schedule.cancelledCount > 0 && `, ${contract.schedule.cancelledCount} cancelled`})
              </DetailRow>
              <DetailRow label="Total of visit amounts">{formatMoney(contract.schedule.scheduledTotal)}</DetailRow>
              <DetailRow label="Contract value less visit amounts">{formatMoney(contract.schedule.valueDifference)}</DetailRow>
              <DetailRow label="Created">{formatDateTime(contract.createdAt)}</DetailRow>
              <DetailRow label="Last updated">{formatDateTime(contract.updatedAt)}</DetailRow>
            </dl>
          </div>

          {contract.schedule.visitCount > 0 && (!isZeroMoney(contract.schedule.valueDifference) || contract.schedule.amountMissingCount > 0) && (
            <p className="text-xs text-slate-500">
              {!isZeroMoney(contract.schedule.valueDifference) && 'The visit amounts do not add up to the contract value. This is shown for information; it is not treated as an error. '}
              {contract.schedule.amountMissingCount > 0 && `${contract.schedule.amountMissingCount} visit(s) have no amount yet.`}
            </p>
          )}

          <section aria-labelledby="contract-schedule-heading">
            <h3 id="contract-schedule-heading" className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-600">
              Maintenance schedule
            </h3>
            {contract.scheduleCutoverDate !== null && (
              <p className="mb-2 text-sm text-slate-600">
                This contract was imported from an earlier register. Visits are generated only for periods starting on or after{' '}
                {formatDate(contract.scheduleCutoverDate)}. Earlier periods are shown as historical where the earlier schedule listed them, and are
                not created otherwise.
              </p>
            )}
            {contract.status === 'DRAFT' && (
              <p className="mb-2 text-sm text-slate-600">
                {contract.schedule.historicalCount > 0
                  ? 'A draft has no generated schedule. New visits are generated when the contract is activated.'
                  : 'A draft has no schedule. The visits are generated when the contract is activated.'}
              </p>
            )}
            {contract.status !== 'DRAFT' && !canViewSchedule && (
              <p className="text-sm text-slate-600">Your role does not include access to the AMC schedule.</p>
            )}
            {canViewSchedule && visits.isPending && contract.status !== 'DRAFT' && <Spinner size="sm" label="Loading visits" />}
            {visits.isError && <Alert>{errorMessage(visits.error)}</Alert>}
            {visits.data && visits.data.items.length > 0 && (
              <div className={`${TABLE.wrapper} rounded-md border border-slate-200`}>
                <table className={TABLE.table}>
                  <caption className="sr-only">Visits of this contract</caption>
                  <thead>
                    <tr>
                      <th scope="col" className={TABLE.th}>
                        No.
                      </th>
                      <th scope="col" className={TABLE.th}>
                        Scheduled
                      </th>
                      <th scope="col" className={TABLE.th}>
                        Period
                      </th>
                      <th scope="col" className={TABLE.th}>
                        Status
                      </th>
                      <th scope="col" className={`${TABLE.th} text-right`}>
                        Amount
                      </th>
                      <th scope="col" className={TABLE.th}>
                        Invoicing
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {visits.data.items.map((visit) => (
                      <tr key={visit.id}>
                        <td className={TABLE.td}>{visit.sequenceNo}</td>
                        <td className={`${TABLE.td} whitespace-nowrap`}>
                          <PlannedDate visit={visit} format={formatDate} />
                        </td>
                        <td className={`${TABLE.td} whitespace-nowrap`}>
                          {formatDate(visit.periodStart)} – {formatDate(visit.periodEnd)}
                        </td>
                        <td className={TABLE.td}>
                          <VisitStatusPill status={visit.status} overdue={visit.isOverdue} />
                        </td>
                        <td className={`${TABLE.td} whitespace-nowrap text-right tabular-nums`}>{formatMoney(visit.visitAmount)}</td>
                        <td className={TABLE.td}>
                          <EligibilityPill eligibility={visit.invoiceEligibility} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </Modal>
  )
}

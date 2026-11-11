import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Alert, Button, Modal, SelectField, Spinner } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { isFeatureUnavailable, type ContractMasters, type SalesEngineer, type SystemType } from '../masters/masterTypes'
import { DetailRow } from './components'

/**
 * The contract's links to the Sales Engineer and System Type master lists. The
 * typed engineer stays as entered; the contract's system follows the linked type.
 * A recorded link can be changed but not removed (2026-11-03); an older contract
 * without one can be linked here. Hidden on a database without migration 0070.
 */
export function ContractMastersPanel({ contractId, canEdit }: { contractId: string; canEdit: boolean }) {
  const [editing, setEditing] = useState(false)
  const query = useQuery({
    queryKey: ['amc', 'contracts', 'masters', contractId],
    queryFn: () => api.get<ContractMasters>(`/amc/contracts/${contractId}/masters`),
    retry: false,
  })

  if (query.isError && isFeatureUnavailable(query.error)) {
    return null
  }

  return (
    <div className="px-6 pb-4">
      <div className="mb-2 mt-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-700">Master records</h3>
        {canEdit && query.data && (
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
            Link master records
          </Button>
        )}
      </div>
      {query.isPending && <Spinner size="sm" label="Loading master records" />}
      {query.isError && <Alert>{errorMessage(query.error)}</Alert>}
      {query.data && (
        <dl>
          <DetailRow label="Service engineer">
            {query.data.salesEngineer ? (
              <>
                {query.data.salesEngineer.name}
                {query.data.salesEngineer.employeeNo && ` (${query.data.salesEngineer.employeeNo})`}
                {!query.data.salesEngineer.isActive && ' (inactive)'}
              </>
            ) : (
              <span className="text-slate-500">Not linked</span>
            )}
          </DetailRow>
          <DetailRow label="System type">
            {query.data.systemType ? (
              <>
                {query.data.systemType.code} — {query.data.systemType.name}
                {!query.data.systemType.isActive && ' (inactive)'}
              </>
            ) : (
              <span className="text-slate-500">Not linked</span>
            )}
          </DetailRow>
        </dl>
      )}
      {editing && query.data && <LinkMastersModal contractId={contractId} current={query.data} onClose={() => setEditing(false)} />}
    </div>
  )
}

function LinkMastersModal({ contractId, current, onClose }: { contractId: string; current: ContractMasters; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [engineerId, setEngineerId] = useState(current.salesEngineer?.id ?? '')
  const [typeId, setTypeId] = useState(current.systemType?.id ?? '')
  const engineers = useQuery({ queryKey: ['masters', 'sales-engineers', 'options'], queryFn: () => api.get<SalesEngineer[]>('/masters/sales-engineers/options') })
  const types = useQuery({ queryKey: ['masters', 'system-types', 'options'], queryFn: () => api.get<SystemType[]>('/masters/system-types/options') })

  const changed = engineerId !== (current.salesEngineer?.id ?? '') || typeId !== (current.systemType?.id ?? '')
  const save = useMutation({
    // Only what changed is sent; an empty choice is offered only where nothing is linked yet.
    mutationFn: () =>
      api.put<ContractMasters>(`/amc/contracts/${contractId}/masters`, {
        ...(engineerId !== (current.salesEngineer?.id ?? '') ? { salesEngineerId: engineerId || null } : {}),
        ...(typeId !== (current.systemType?.id ?? '') ? { systemTypeId: typeId || null } : {}),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['amc'] })
      await queryClient.invalidateQueries({ queryKey: ['masters'] })
      onClose()
    },
  })

  return (
    <Modal
      title="Link master records"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => (changed ? save.mutate() : onClose())} loading={save.isPending}>
            Save links
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          The typed engineer stays as entered. The contract’s system becomes the name of the linked system type. A link that is recorded can be changed, not removed.
        </p>
        {save.isError && <Alert>{errorMessage(save.error)}</Alert>}
        {(engineers.isError || types.isError) && <Alert>{errorMessage(engineers.error ?? types.error)}</Alert>}
        <SelectField label="Service engineer" value={engineerId} onChange={(event) => setEngineerId(event.target.value)}>
          {current.salesEngineer ? (
            <option value="" disabled>
              Select a service engineer…
            </option>
          ) : (
            <option value="">Not linked</option>
          )}
          {current.salesEngineer && !current.salesEngineer.isActive && <option value={current.salesEngineer.id}>{current.salesEngineer.name} (inactive)</option>}
          {(engineers.data ?? []).map((engineer) => (
            <option key={engineer.id} value={engineer.id}>
              {engineer.name}
              {engineer.employeeNo ? ` (${engineer.employeeNo})` : ''}
            </option>
          ))}
        </SelectField>
        <SelectField label="System type" value={typeId} onChange={(event) => setTypeId(event.target.value)}>
          {current.systemType ? (
            <option value="" disabled>
              Select a system...
            </option>
          ) : (
            <option value="">Not linked</option>
          )}
          {current.systemType && !current.systemType.isActive && (
            <option value={current.systemType.id}>
              {current.systemType.code} — {current.systemType.name} (inactive)
            </option>
          )}
          {(types.data ?? []).map((type) => (
            <option key={type.id} value={type.id}>
              {type.code} — {type.name}
            </option>
          ))}
        </SelectField>
      </div>
    </Modal>
  )
}

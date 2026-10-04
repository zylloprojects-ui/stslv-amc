import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { z } from 'zod'
import { Alert, Button, Modal, Spinner, TextAreaField, TextField } from '../../components/ui'
import { api, ApiError, errorMessage } from '../../lib/api'
import { fetchClients, queryString } from './amcApi'
import { formatDate, MONEY_PATTERN } from './amcFormat'
import { SelectField } from './components'
import { FREQUENCY_LABELS, MAINTENANCE_FREQUENCIES, type Contract, type SavedContract, type SchedulePreview } from './types'

// Mirrors the API's rules so most problems are caught before a request is sent.
// The API validates again and remains the authority.
const MONEY_MESSAGE = 'Enter an amount of zero or more with at most 3 decimal places.'
const optionalMoney = z
  .string()
  .trim()
  .refine((value) => value === '' || MONEY_PATTERN.test(value), MONEY_MESSAGE)

const contractSchema = z
  .object({
    clientId: z.string().min(1, 'Select a client.'),
    systemDescription: z.string().trim().min(1, 'System is required.').max(200, 'System must be at most 200 characters.'),
    responsibleEngineer: z.string().trim().max(200, 'Responsible engineer must be at most 200 characters.'),
    validFrom: z.string().min(1, 'Valid from is required.'),
    validTo: z.string().min(1, 'Valid to is required.'),
    maintenanceFrequency: z.enum(MAINTENANCE_FREQUENCIES, { error: 'Select a maintenance frequency.' }),
    contractValue: z.string().trim().min(1, 'Contract value is required.').regex(MONEY_PATTERN, MONEY_MESSAGE),
    defaultVisitAmount: optionalMoney,
    finalCredit: optionalMoney,
    description: z.string().trim().max(2000, 'Description must be at most 2000 characters.'),
    notes: z.string().trim().max(2000, 'Notes must be at most 2000 characters.'),
    status: z.enum(['DRAFT', 'ACTIVE']),
  })
  .refine((value) => !value.validFrom || !value.validTo || value.validTo >= value.validFrom, {
    path: ['validTo'],
    message: 'Valid to must be on or after Valid from.',
    // Checked even while other fields are still invalid, so the user sees it at once.
    when: () => true,
  })

type ContractForm = z.infer<typeof contractSchema>

const FIELDS = [
  'clientId',
  'systemDescription',
  'responsibleEngineer',
  'validFrom',
  'validTo',
  'maintenanceFrequency',
  'contractValue',
  'defaultVisitAmount',
  'finalCredit',
  'description',
  'notes',
  'status',
] as const

interface ContractFormModalProps {
  /** The contract to edit, or null to add a new one. */
  contract: Contract | null
  onClose: () => void
  onSaved: (contract: SavedContract) => void
}

export function ContractFormModal({ contract, onClose, onSaved }: ContractFormModalProps) {
  const queryClient = useQueryClient()
  const systemsId = useId()
  const [failure, setFailure] = useState<string | null>(null)
  // Set when an active contract's terms change: the user confirms the effect on its schedule first.
  const [review, setReview] = useState<{ values: ContractForm; preview: SchedulePreview } | null>(null)

  const clients = useQuery({ queryKey: ['clients', 'selectable'], queryFn: () => fetchClients('active') })
  const systems = useQuery({ queryKey: ['amc', 'systems'], queryFn: () => api.get<string[]>('/amc/contracts/systems') })

  const {
    register,
    handleSubmit,
    setError,
    control,
    formState: { errors },
  } = useForm<ContractForm>({
    resolver: zodResolver(contractSchema),
    defaultValues: {
      clientId: contract?.client.id ?? '',
      systemDescription: contract?.systemDescription ?? '',
      responsibleEngineer: contract?.responsibleEngineer ?? '',
      validFrom: contract?.validFrom ?? '',
      validTo: contract?.validTo ?? '',
      maintenanceFrequency: contract?.maintenanceFrequency ?? ('' as ContractForm['maintenanceFrequency']),
      contractValue: contract?.contractValue ?? '',
      defaultVisitAmount: contract?.defaultVisitAmount ?? '',
      finalCredit: contract?.finalCredit ?? '',
      description: contract?.description ?? '',
      notes: contract?.notes ?? '',
      status: 'ACTIVE',
    },
  })

  const save = useMutation({
    mutationFn: (values: ContractForm) => {
      const { status, ...fields } = values

      return contract
        ? api.patch<SavedContract>(`/amc/contracts/${contract.id}`, fields)
        : api.post<SavedContract>('/amc/contracts', { ...fields, status })
    },
    onSuccess: async (saved) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['amc'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ])
      onSaved(saved)
    },
    onError: (error) => {
      let shownOnField = false

      if (error instanceof ApiError) {
        for (const detail of error.details) {
          if ((FIELDS as readonly string[]).includes(detail.field)) {
            setError(detail.field as (typeof FIELDS)[number], { message: detail.message })
            shownOnField = true
          }
        }
      }

      setReview(null)
      setFailure(shownOnField ? null : errorMessage(error))
    },
  })

  const preview = useMutation({
    mutationFn: (values: ContractForm) =>
      api.get<SchedulePreview>(
        `/amc/contracts/${contract?.id}/schedule/preview${queryString({
          validFrom: values.validFrom,
          validTo: values.validTo,
          maintenanceFrequency: values.maintenanceFrequency,
        })}`,
      ),
    onSuccess: (result, values) => {
      if (!result.canApply) {
        setFailure(result.blockedReason ?? 'These terms cannot be applied to the existing schedule.')
      } else if (result.toCreate.length === 0 && result.toRemove.length === 0) {
        save.mutate(values)
      } else {
        setReview({ values, preview: result })
      }
    },
    onError: (error) => setFailure(errorMessage(error)),
  })

  const onSubmit = handleSubmit((values) => {
    setFailure(null)

    const termsChanged =
      contract !== null &&
      (values.validFrom !== contract.validFrom ||
        values.validTo !== contract.validTo ||
        values.maintenanceFrequency !== contract.maintenanceFrequency)

    // Changing the terms of an active contract changes its schedule: show what will happen first.
    if (contract?.status === 'ACTIVE' && termsChanged) {
      preview.mutate(values)
    } else {
      save.mutate(values)
    }
  })

  const busy = save.isPending || preview.isPending
  const termsLocked = contract !== null && contract.status !== 'DRAFT' && contract.status !== 'ACTIVE'
  const options = clients.data ?? []
  // The contract's own client stays selectable even if it has since been deactivated.
  const currentMissing = contract !== null && !options.some((client) => client.id === contract.client.id)
  const newStatus = useWatch({ control, name: 'status' })

  const plan = review?.preview ?? null

  return (
    <Modal
      title={review ? 'Confirm schedule change' : contract ? 'Edit AMC Contract' : 'Add AMC Contract'}
      onClose={onClose}
      size="xl"
      footer={
        review ? (
          <>
            <Button variant="secondary" onClick={() => setReview(null)} disabled={save.isPending}>
              Back
            </Button>
            <Button onClick={() => save.mutate(review.values)} loading={save.isPending}>
              Save and update schedule
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" form="amc-contract-form" loading={busy} disabled={clients.isPending}>
              {contract ? 'Save changes' : 'Add contract'}
            </Button>
          </>
        )
      }
    >
      {plan && (
        <div className="space-y-4 text-sm text-slate-700">
          <p>
            The new terms ({formatDate(plan.validFrom)} to {formatDate(plan.validTo)}, {FREQUENCY_LABELS[plan.maintenanceFrequency].toLowerCase()}) change this
            contract&apos;s schedule:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>{plan.toCreate.length}</strong> visit(s) will be added
              {plan.toCreate.length > 0 && <>: {plan.toCreate.map((period) => formatDate(period.scheduledDate)).join(', ')}</>}
            </li>
            <li>
              <strong>{plan.toRemove.length}</strong> untouched visit(s) will be removed
              {plan.toRemove.length > 0 && <>: {plan.toRemove.map((visit) => formatDate(visit.periodStart)).join(', ')}</>}
            </li>
            <li>
              <strong>{plan.keptCount}</strong> visit(s) will be kept exactly as they are
            </li>
          </ul>
          <Alert tone="info">
            Visits that have been completed, started, postponed, cancelled, rescheduled or given their own amount or notes are never changed or removed.
          </Alert>
        </div>
      )}

      {/* The form stays mounted while the change is reviewed, so Back returns to the entered values. */}
      {clients.isPending && <Spinner size="sm" label="Loading clients" />}
      {clients.isError && <Alert>{errorMessage(clients.error)}</Alert>}

      {clients.data && (
        <form id="amc-contract-form" onSubmit={onSubmit} noValidate hidden={review !== null} className="space-y-4">
          {failure && <Alert>{failure}</Alert>}

          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label="Client"
              required
              error={errors.clientId?.message}
              hint={options.length === 0 ? 'No active clients. Add the client in Clients first.' : undefined}
              {...register('clientId')}
            >
              <option value="">Select a client…</option>
              {currentMissing && contract && <option value={contract.client.id}>{contract.client.name} (inactive)</option>}
              {options.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </SelectField>
            <TextField
              label="System"
              required
              list={systemsId}
              placeholder="For example FIRE or CCTV"
              error={errors.systemDescription?.message}
              {...register('systemDescription')}
            />
            <datalist id={systemsId}>
              {(systems.data ?? []).map((system) => (
                <option key={system} value={system} />
              ))}
            </datalist>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Responsible engineer" error={errors.responsibleEngineer?.message} {...register('responsibleEngineer')} />
            <SelectField
              label="Maintenance frequency"
              required
              disabled={termsLocked}
              error={errors.maintenanceFrequency?.message}
              {...register('maintenanceFrequency')}
            >
              <option value="">Select a frequency…</option>
              {MAINTENANCE_FREQUENCIES.map((frequency) => (
                <option key={frequency} value={frequency}>
                  {FREQUENCY_LABELS[frequency]}
                </option>
              ))}
            </SelectField>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Valid from" type="date" required disabled={termsLocked} error={errors.validFrom?.message} {...register('validFrom')} />
            <TextField label="Valid to" type="date" required disabled={termsLocked} error={errors.validTo?.message} {...register('validTo')} />
          </div>
          {termsLocked && (
            <p className="text-xs text-slate-500">
              The validity period and frequency of a {contract?.status.toLowerCase()} contract cannot be changed. Reactivate the contract first.
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <TextField label="Contract value" required inputMode="decimal" error={errors.contractValue?.message} {...register('contractValue')} />
            <TextField
              label="Default visit amount"
              inputMode="decimal"
              hint="Starting amount for each generated visit. Each visit can be changed afterwards."
              error={errors.defaultVisitAmount?.message}
              {...register('defaultVisitAmount')}
            />
            <TextField
              label="Final credit"
              inputMode="decimal"
              hint="Recorded as entered. Not used in any calculation."
              error={errors.finalCredit?.message}
              {...register('finalCredit')}
            />
          </div>

          <TextAreaField label="Description" rows={2} error={errors.description?.message} {...register('description')} />
          <TextAreaField label="Notes" rows={2} error={errors.notes?.message} {...register('notes')} />

          {!contract && (
            <SelectField
              label="Status"
              required
              hint={
                newStatus === 'ACTIVE'
                  ? 'The maintenance schedule is generated as soon as the contract is added.'
                  : 'A draft has no schedule. It is generated when the contract is activated.'
              }
              {...register('status')}
            >
              <option value="ACTIVE">Active</option>
              <option value="DRAFT">Draft</option>
            </SelectField>
          )}
        </form>
      )}
    </Modal>
  )
}

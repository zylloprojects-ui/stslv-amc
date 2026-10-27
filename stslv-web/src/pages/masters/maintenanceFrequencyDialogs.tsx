import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Pager } from '../../components/records'
import { TABLE } from '../../components/table'
import { Alert, Badge, Button, ConfirmDialog, EmptyState, Modal, SelectField, Spinner, TableScroll, TextField } from '../../components/ui'
import { api, ApiError, errorMessage } from '../../lib/api'
import { formatDate } from '../../lib/format'
import { CONTRACT_STATUS_LABELS, type ContractStatus } from '../amc/types'
import type { MasterList } from './masterTypes'
import { engineCanGenerate, FREQUENCY_STATUS_LABELS, VALID_INTERVALS, type FrequencyLinkedContract, type FrequencyStatus, type MaintenanceFrequencyRule } from './maintenanceFrequencyTypes'

// The dialogs of the Maintenance Frequencies page: the create/edit form, the
// AMC contracts that use a frequency (read only), and the warning before a
// frequency that active contracts use is disabled or archived.

const ENGINE_PENDING = 'The schedule engine cannot generate visits for this rule yet, so it can only be saved as Disabled. It can be activated once the engine supports it.'

/** "every 4-months" -> "EVERY_4_MONTHS", as the API stores it. */
const normalizeCode = (value: string) => value.toUpperCase().replace(/[\s-]+/g, '_')

type FieldErrors = Partial<Record<'name' | 'code' | 'codePrefix' | 'serviceCount' | 'intervalMonths' | 'sortOrder' | 'status', string>>

function validate(values: { name: string; code: string; codePrefix: string; isCustom: boolean; serviceCount: string; intervalMonths: string; sortOrder: string }): FieldErrors {
  const errors: FieldErrors = {}
  const code = values.code.trim()
  const prefix = values.codePrefix.trim()

  if (values.name.trim() === '') errors.name = 'Enter a name.'
  if (code === '') errors.code = 'Enter an internal code.'
  else if (!/^[A-Z][A-Z0-9_]{1,29}$/.test(code)) errors.code = 'Use 2-30 letters, digits and underscores, starting with a letter (for example EVERY_4_MONTHS).'
  if (prefix === '') errors.codePrefix = 'Enter a service code prefix.'
  else if (!/^[A-Z]{1,4}$/.test(prefix)) errors.codePrefix = 'Use 1-4 letters (for example Q or BM).'
  if (values.sortOrder.trim() !== '' && !/^\d{1,4}$/.test(values.sortOrder.trim())) errors.sortOrder = 'Enter a whole number from 0 to 9999.'

  if (!values.isCustom) {
    const interval = Number(values.intervalMonths)
    const count = Number(values.serviceCount)

    if (values.intervalMonths === '') errors.intervalMonths = 'Select the months between services.'
    if (values.serviceCount.trim() === '') errors.serviceCount = 'Enter the number of services per year.'
    else if (!/^\d{1,2}$/.test(values.serviceCount.trim()) || count < 1 || count > 12) errors.serviceCount = 'Enter a whole number from 1 to 12.'
    else if (values.intervalMonths !== '' && count * interval !== 12) errors.serviceCount = `With a ${interval}-month interval, services per year must be ${12 / interval}.`
  }

  return errors
}

/**
 * Create or edit a frequency. In custom mode the services per year and the
 * interval do not apply: they are hidden and sent as null, so no stale value
 * can be saved. Once a contract uses the frequency, its code and scheduling
 * rule are locked; only the name and sort order can change.
 */
export function FrequencyFormModal({ frequency, onClose, onSaved }: { frequency: MaintenanceFrequencyRule | null; onClose: () => void; onSaved: (message: string) => void }) {
  const queryClient = useQueryClient()
  const editing = frequency !== null
  const locked = frequency?.ruleLocked ?? false

  const [name, setName] = useState(frequency?.name ?? '')
  const [code, setCode] = useState(frequency?.code ?? '')
  const [codePrefix, setCodePrefix] = useState(frequency?.codePrefix ?? '')
  const [isCustom, setIsCustom] = useState(frequency?.isCustom ?? false)
  const [serviceCount, setServiceCount] = useState(frequency?.serviceCount?.toString() ?? '')
  const [intervalMonths, setIntervalMonths] = useState(frequency?.intervalMonths?.toString() ?? '')
  const [sortOrder, setSortOrder] = useState(frequency?.sortOrder.toString() ?? '')
  const [status, setStatus] = useState<'active' | 'disabled'>('active')
  const [errors, setErrors] = useState<FieldErrors>({})

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      frequency ? api.patch<MaintenanceFrequencyRule>(`/masters/maintenance-frequencies/${frequency.id}`, body) : api.post<MaintenanceFrequencyRule>('/masters/maintenance-frequencies', body),
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ['masters'] })
      onSaved(editing ? `${saved.name} was updated.` : `${saved.name} was added as ${FREQUENCY_STATUS_LABELS[saved.status]}.`)
    },
    onError: (error) => {
      if (error instanceof ApiError && error.details.length > 0) {
        setErrors(Object.fromEntries(error.details.map((detail) => [detail.field, detail.message])) as FieldErrors)
      }
    },
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const values = { name, code, codePrefix, isCustom, serviceCount, intervalMonths, sortOrder }
    // A locked rule is not edited, so only the name and sort order are checked.
    const found = locked && frequency ? validate({ ...values, isCustom: true, code: frequency.code, codePrefix: frequency.codePrefix }) : validate(values)
    const rule = { isCustom, intervalMonths: isCustom || intervalMonths === '' ? null : Number(intervalMonths) }

    if (!frequency && status === 'active' && Object.keys(found).length === 0 && !engineCanGenerate(rule)) found.status = ENGINE_PENDING
    if (frequency && frequency.isActive && !locked && Object.keys(found).length === 0 && !engineCanGenerate(rule)) found.intervalMonths = ENGINE_PENDING

    setErrors(found)
    if (Object.keys(found).length > 0) return

    // Custom mode sends null for both numbers, so values typed before switching are never saved.
    const ruleFields = {
      code: code.trim(),
      codePrefix: codePrefix.trim(),
      isCustom,
      serviceCount: isCustom ? null : Number(serviceCount),
      intervalMonths: isCustom ? null : Number(intervalMonths),
    }
    const body: Record<string, unknown> = { name: name.trim(), ...(sortOrder.trim() === '' ? {} : { sortOrder: Number(sortOrder) }) }

    if (!frequency) {
      save.mutate({ ...body, ...ruleFields, status })
      return
    }

    // An edit sends only what changed; a locked rule is never sent.
    const changed: Record<string, unknown> = {}
    if (body.name !== frequency.name) changed.name = body.name
    if (body.sortOrder !== undefined && body.sortOrder !== frequency.sortOrder) changed.sortOrder = body.sortOrder
    if (!locked) {
      for (const [key, value] of Object.entries(ruleFields)) {
        if (value !== frequency[key as keyof typeof ruleFields]) changed[key] = value
      }
    }
    if (Object.keys(changed).length === 0) {
      onClose()
      return
    }
    save.mutate(changed)
  }

  const formError = save.isError && !(save.error instanceof ApiError && save.error.details.length > 0) ? errorMessage(save.error) : null
  const formId = 'maintenance-frequency-form'

  return (
    <Modal
      title={frequency ? `Edit ${frequency.name}` : 'Add Maintenance Frequency'}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={save.isPending}>
            {editing ? 'Save changes' : 'Add frequency'}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={submit} className="space-y-4">
        {formError && <Alert>{formError}</Alert>}
        {save.isError && save.error instanceof ApiError && save.error.details.length > 0 && <Alert>{save.error.message}</Alert>}

        {locked && frequency && (
          <Alert tone="info">
            {frequency.contractCount} AMC {frequency.contractCount === 1 ? 'contract uses' : 'contracts use'} this frequency, so its internal code and scheduling rule are locked: changing them would change how
            those contracts&apos; visits are planned or labelled. The name and sort order can still be changed. For a different rule, add a new frequency.
          </Alert>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Frequency name" required value={name} maxLength={50} onChange={(event) => setName(event.target.value)} error={errors.name} />
          <TextField
            label="Internal code"
            required
            value={code}
            maxLength={30}
            disabled={locked}
            onChange={(event) => setCode(normalizeCode(event.target.value))}
            error={errors.code}
            hint={editing ? 'The stable key stored on each contract.' : 'Upper case with underscores, for example EVERY_4_MONTHS. The key stored on each contract.'}
          />
          <TextField
            label="Service code prefix"
            required
            value={codePrefix}
            maxLength={4}
            disabled={locked}
            onChange={(event) => setCodePrefix(event.target.value.toUpperCase())}
            error={errors.codePrefix}
            hint="1-4 letters, unique to this frequency. Visits are labelled with it, for example Q3."
          />
          <TextField label="Sort order" inputMode="numeric" value={sortOrder} onChange={(event) => setSortOrder(event.target.value)} error={errors.sortOrder} hint={editing ? undefined : 'Leave blank to add it at the end.'} />
        </div>

        <fieldset className="rounded-xl border border-slate-200 p-4">
          <legend className="px-1 text-sm font-semibold text-slate-800">Scheduling rule</legend>
          <label className="flex items-start gap-2.5 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={isCustom}
              disabled={locked}
              onChange={(event) => {
                setIsCustom(event.target.checked)
                setErrors((current) => ({ ...current, serviceCount: undefined, intervalMonths: undefined }))
              }}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-[#1479BD]"
            />
            <span>
              <span className="font-medium">Custom month-selection frequency</span>
              <span className="block text-xs text-slate-500">The service months are chosen on each AMC contract, not here.</span>
            </span>
          </label>

          {isCustom ? (
            <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
              Services per year and interval do not apply to a custom frequency and are saved as blank. Each contract on this frequency chooses its own months (1 to 11).
            </p>
          ) : (
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SelectField
                label="Interval (months)"
                required
                value={intervalMonths}
                disabled={locked}
                onChange={(event) => {
                  setIntervalMonths(event.target.value)
                  // The only consistent count: services divide the year evenly.
                  if (event.target.value !== '') setServiceCount(String(12 / Number(event.target.value)))
                }}
                error={errors.intervalMonths}
              >
                <option value="">Select…</option>
                {VALID_INTERVALS.map((interval) => (
                  <option key={interval} value={interval}>
                    Every {interval === 1 ? 'month' : `${interval} months`}
                  </option>
                ))}
              </SelectField>
              <TextField
                label="Services per year"
                required
                inputMode="numeric"
                value={serviceCount}
                disabled={locked}
                onChange={(event) => setServiceCount(event.target.value)}
                error={errors.serviceCount}
                hint="Services per year × interval must equal 12 months."
              />
            </div>
          )}
        </fieldset>

        {!editing && (
          <SelectField label="Status" value={status} onChange={(event) => setStatus(event.target.value as 'active' | 'disabled')} error={errors.status} hint="Only active frequencies are offered for new AMC contracts.">
            <option value="active">{FREQUENCY_STATUS_LABELS.active}</option>
            <option value="disabled">{FREQUENCY_STATUS_LABELS.disabled}</option>
          </SelectField>
        )}

        {frequency && (
          <p className="text-xs text-slate-500">
            Added {formatDate(frequency.createdAt.slice(0, 10))} · Last updated {formatDate(frequency.updatedAt.slice(0, 10))}
          </p>
        )}
      </form>
    </Modal>
  )
}

const PAGE_SIZE = 10

const STATUS_TONES: Record<ContractStatus, 'green' | 'slate' | 'blue' | 'amber'> = { ACTIVE: 'green', DRAFT: 'blue', EXPIRED: 'amber', CANCELLED: 'slate' }

export function FrequencyContractsModal({ frequency, onClose }: { frequency: MaintenanceFrequencyRule; onClose: () => void }) {
  const [page, setPage] = useState(1)
  const contracts = useQuery({
    queryKey: ['masters', 'maintenance-frequencies', frequency.id, 'contracts', page],
    queryFn: () => api.get<MasterList<FrequencyLinkedContract> & { activeTotal: number }>(`/masters/maintenance-frequencies/${frequency.id}/contracts?page=${page}&pageSize=${PAGE_SIZE}`),
    placeholderData: keepPreviousData,
  })
  const data = contracts.data

  return (
    <Modal
      title={`AMC contracts using ${frequency.name}`}
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
      {data && data.items.length === 0 && <EmptyState title="No AMC contracts use this frequency" />}
      {data && data.items.length > 0 && (
        <>
          <p className="mb-3 text-sm text-slate-600">
            {data.total} {data.total === 1 ? 'contract' : 'contracts'}, {data.activeTotal} active.
          </p>
          <TableScroll label="Linked AMC contracts">
            <table className={TABLE.table}>
              <caption className="sr-only">AMC contracts using {frequency.name}</caption>
              <thead>
                <tr>
                  <th scope="col" className={TABLE.th}>
                    Contract
                  </th>
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
                    <td className={`${TABLE.td} whitespace-nowrap`}>
                      <Link to={`/amc/contracts/${contract.id}`} className="font-semibold text-[#1479BD] hover:underline">
                        Contract #{contract.id}
                      </Link>
                    </td>
                    <td className={`${TABLE.td} ${TABLE.text}`}>{contract.client.name}</td>
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
 * Shown before a frequency that active contracts use is disabled or archived.
 * The contracts keep it and no visit changes; it is only no longer offered.
 */
export function FrequencyStatusWarning({
  frequency,
  status,
  loading,
  error,
  onConfirm,
  onCancel,
}: {
  frequency: MaintenanceFrequencyRule
  status: Exclude<FrequencyStatus, 'active'>
  loading: boolean
  error: string | null
  onConfirm: () => void
  onCancel: () => void
}) {
  const count = frequency.activeContractCount
  const verb = status === 'archived' ? 'Archive' : 'Disable'

  return (
    <ConfirmDialog
      title={`${verb} ${frequency.name}?`}
      message={
        <>
          <p>
            <strong>
              {count} active AMC {count === 1 ? 'contract uses' : 'contracts use'} this frequency
            </strong>
            {frequency.contractCount > count ? ` (${frequency.contractCount} contracts in total)` : ''}.
          </p>
          <p className="mt-2">
            {count === 1 ? 'That contract keeps' : 'Those contracts keep'} it, and no scheduled or completed visit changes. It will no longer be offered for new contracts or renewals
            {status === 'archived' ? ', and it will be hidden from the default list' : ''}.
          </p>
        </>
      }
      confirmLabel={verb}
      loading={loading}
      error={error}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}

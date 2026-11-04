import { refreshOperationalData } from '../../lib/refreshOperationalData'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useRef, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { z } from 'zod'
import { Alert, Button, Modal, Spinner, TextAreaField, TextField } from '../../components/ui'
import { api, ApiError, errorMessage, isForbidden } from '../../lib/api'
import type { SystemType } from '../masters/masterTypes'
import { queryString } from './amcApi'
import { contractEndDate, formatDate, MONEY_PATTERN } from './amcFormat'
import { SelectField } from './components'
import { CONTRACT_DOCUMENT_ACCEPT, contractDocumentProblem, DEFAULT_MAX_MB, formatFileSize, readAsBase64 } from './contractDocument'
import { MONTH_NAMES, useFrequencyOptions } from './frequencyOptions'
import { frequencyLabel, type Contract, type SavedContract, type SchedulePreview } from './types'

const DURATION_YEARS = [1, 2, 3, 4, 5, 6]

/** The System choice of an older contract whose typed system is not linked to the System Types list: kept as it is. */
const CURRENT_SYSTEM = '__current__'

// Mirrors the API's rules so most problems are caught before a request is sent.
// The API validates again and remains the authority.
const MONEY_MESSAGE = 'Enter an amount of zero or more with at most 3 decimal places.'
const optionalMoney = z
  .string()
  .trim()
  .refine((value) => value === '' || MONEY_PATTERN.test(value), MONEY_MESSAGE)

/** The API's AMC Reference Number rule (migration 0105): typed, never generated; read-only after creation. */
const AMC_REFERENCE_MAX = 50
const amcReferenceRule = z
  .string()
  .trim()
  .min(1, 'AMC Reference Number is required.')
  .max(AMC_REFERENCE_MAX, `AMC Reference Number must be at most ${AMC_REFERENCE_MAX} characters.`)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 _./&-]*$/, 'AMC Reference Number may use letters, digits, spaces and - _ . / & only, and must start with a letter or digit.')

/** `creating`: a new contract or renewal, which must be given its AMC Reference Number. An edit never sends it. */
const buildContractSchema = (creating: boolean) =>
  z
  .object({
    amcReference: creating ? amcReferenceRule : z.string(),
    clientId: z.string().min(1, 'Select a client.'),
    responsibleEngineer: z.string().trim().max(200, 'Responsible engineer must be at most 200 characters.'),
    validFrom: z.string().min(1, 'Valid from is required.'),
    validTo: z.string().min(1, 'Valid to is required.'),
    maintenanceFrequency: z.string().min(1, 'Select a maintenance frequency.'),
    // Months (1 = January) of a custom frequency; checked against the chosen frequency on submit.
    customMonths: z.array(z.number()),
    contractValue: z.string().trim().min(1, 'AMC Value / Year is required.').regex(MONEY_PATTERN, MONEY_MESSAGE),
    defaultVisitAmount: optionalMoney,
    // Required on a new contract (checked on submit); an older contract may have none.
    finalCredit: optionalMoney,
    billingBasis: z.enum(['', 'CONTRACT_VALUE', 'FINAL_CREDIT', 'CUSTOM']),
    customBillingValue: optionalMoney,
    description: z.string().trim().max(2000, 'Description must be at most 2000 characters.'),
    notes: z.string().trim().max(2000, 'Notes must be at most 2000 characters.'),
    renewalNotes: z.string().trim().max(1000, 'Renewal notes must be at most 1000 characters.'),
    status: z.enum(['DRAFT', 'ACTIVE']),
  })
  .refine((value) => !value.validFrom || !value.validTo || value.validTo >= value.validFrom, {
    path: ['validTo'],
    message: 'Valid to must be on or after Valid from.',
    // Checked even while other fields are still invalid, so the user sees it at once.
    when: () => true,
  })

const CREATE_SCHEMA = buildContractSchema(true)
const EDIT_SCHEMA = buildContractSchema(false)

type ContractForm = z.infer<typeof CREATE_SCHEMA>

const FIELDS = [
  'amcReference',
  'clientId',
  'responsibleEngineer',
  'validFrom',
  'validTo',
  'maintenanceFrequency',
  'customMonths',
  'contractValue',
  'defaultVisitAmount',
  'finalCredit',
  'billingBasis',
  'customBillingValue',
  'description',
  'notes',
  'renewalNotes',
  'status',
] as const

interface ContractFormModalProps {
  /** The contract to edit, or null to add a new one. */
  contract: Contract | null
  /**
   * With contract null: add the new contract as the renewal of this one. The
   * form starts from its details (not its validity); the source stays unchanged.
   */
  renewalOf?: Contract
  /**
   * The new contract is always added as a draft, with no status to choose: on
   * AMC Renewal a renewal waits for client approval and is activated from there.
   */
  draftOnly?: boolean
  onClose: () => void
  onSaved: (contract: SavedContract) => void
}

export function ContractFormModal({ contract, renewalOf, draftOnly = false, onClose, onSaved }: ContractFormModalProps) {
  // The details a new contract starts from: the contract being edited, or the one being renewed (without its validity).
  const start = contract ?? renewalOf ?? null
  // Add AMC Contract (2026-11-03): a new contract that is not a renewal needs Final Credit and a contract document.
  const isNew = contract === null && !renewalOf
  const queryClient = useQueryClient()
  const documentInputId = useId()
  const documentInput = useRef<HTMLInputElement>(null)
  const [failure, setFailure] = useState<string | null>(null)
  // Set when an active contract's terms change: the user confirms the effect on its schedule first.
  const [review, setReview] = useState<{ values: ContractForm; preview: SchedulePreview } | null>(null)

  // Names only, on the permission to save this form; opens none of the Clients pages (the API checks the same).
  const clients = useQuery({ queryKey: ['amc', 'contracts', 'client-options'], queryFn: () => api.get<{ id: string; code?: string; name: string }[]>('/amc/contracts/client-options') })
  // Active system types, the only systems a contract can be saved with (readable with AMC Contracts access).
  const systemTypes = useQuery({ queryKey: ['masters', 'system-types', 'options'], queryFn: () => api.get<SystemType[]>('/masters/system-types/options'), retry: false })

  const {
    register,
    handleSubmit,
    setError,
    setValue,
    getValues,
    control,
    formState: { errors },
  } = useForm<ContractForm>({
    resolver: zodResolver(contract ? EDIT_SCHEMA : CREATE_SCHEMA),
    defaultValues: {
      // Never prefilled: a new contract or renewal gets the number the user types. An edit shows the stored one, read-only.
      amcReference: contract?.amcReference ?? '',
      clientId: start?.client.id ?? '',
      responsibleEngineer: start?.responsibleEngineer ?? '',
      validFrom: contract?.validFrom ?? '',
      validTo: contract?.validTo ?? '',
      maintenanceFrequency: start?.maintenanceFrequency ?? '',
      customMonths: start?.customMonths ?? [],
      contractValue: start?.contractValue ?? '',
      defaultVisitAmount: start?.defaultVisitAmount ?? '',
      finalCredit: start?.finalCredit ?? '',
      billingBasis: start?.billingBasis ?? '',
      customBillingValue: start?.customBillingValue ?? '',
      description: start?.description ?? '',
      notes: contract?.notes ?? '',
      renewalNotes: '',
      // A renewal starts as a draft, so nothing is scheduled until it is activated.
      status: renewalOf || draftOnly ? 'DRAFT' : 'ACTIVE',
    },
  })

  // The Sales Engineer master list (migration 0070): active engineers only.
  const engineers = useQuery({
    queryKey: ['masters', 'sales-engineers', 'options'],
    queryFn: () => api.get<{ id: string; name: string; employeeNo: string | null }[]>('/masters/sales-engineers/options'),
    retry: false,
  })
  // The links of the contract being edited, or of the contract being renewed.
  const currentLinks = useQuery({
    queryKey: ['amc', 'contracts', 'masters', start?.id],
    queryFn: () =>
      api.get<{ salesEngineer: { id: string; name: string; isActive: boolean } | null; systemType: { id: string; code: string; name: string; isActive: boolean } | null }>(
        `/amc/contracts/${start?.id}/masters`,
      ),
    enabled: Boolean(start),
    retry: false,
  })
  const currentEngineer = contract ? (currentLinks.data?.salesEngineer ?? null) : null
  const currentEngineerId = currentEngineer?.id ?? ''
  // A renewal starts with the renewed contract's engineer, like the other copied details, while that engineer is active.
  const renewedEngineer = renewalOf ? (currentLinks.data?.salesEngineer ?? null) : null
  const initialEngineerId = renewedEngineer?.isActive ? renewedEngineer.id : currentEngineerId
  const [chosenEngineerId, setChosenEngineerId] = useState<string | null>(null)
  const engineerId = chosenEngineerId ?? initialEngineerId
  const engineerPicker = engineers.isSuccess && (!start || currentLinks.isSuccess)
  // A new contract and a renewal name an active sales engineer, chosen by the user ("Not linked" is not offered).
  // An existing contract keeps its link; one that has an engineer cannot lose it, and an older contract without one
  // stays valid. When the renewed contract's engineer is no longer active, that assignment is shown but cannot be chosen.
  const engineerRequired = contract === null || currentEngineer !== null
  const previousInactive = renewedEngineer !== null && !renewedEngineer.isActive ? renewedEngineer : null
  // A new contract cannot be saved without the engineer list: say so instead of failing on save.
  const engineerListUnavailable = contract === null && (engineers.isError || currentLinks.isError)
  const [engineerError, setEngineerError] = useState<string | null>(null)
  const chooseEngineer = (id: string) => {
    setChosenEngineerId(id)
    setEngineerError(null)
    const engineer = engineers.data?.find((item) => item.id === id)
    // Fills the typed engineer only when it is empty; a typed name is never overwritten.
    if (engineer && !getValues('responsibleEngineer').trim()) {
      setValue('responsibleEngineer', engineer.name)
    }
  }

  // System: an active System Types record. The contract's system text is that type's name (set by the API).
  // An existing contract keeps its linked type even when it has since been disabled; an older contract whose
  // typed system was never linked keeps it until another system is chosen.
  const linkedType = currentLinks.data?.systemType ?? null
  // A renewal's creation rules are unchanged: it may keep the renewed contract's system as typed when that contract
  // has no active system type to copy (an older contract), exactly as before the System became a list.
  const legacySystem =
    contract !== null
      ? currentLinks.isSuccess && linkedType === null
        ? contract.systemDescription
        : null
      : renewalOf && (currentLinks.isError || (currentLinks.isSuccess && !linkedType?.isActive))
        ? renewalOf.systemDescription
        : null
  const initialSystem = contract
    ? (linkedType?.id ?? (legacySystem !== null ? CURRENT_SYSTEM : ''))
    : renewalOf && linkedType?.isActive
      ? linkedType.id
      : legacySystem !== null
        ? CURRENT_SYSTEM
        : ''
  const [chosenSystem, setChosenSystem] = useState<string | null>(null)
  const systemChoice = chosenSystem ?? initialSystem
  const [systemError, setSystemError] = useState<string | null>(null)
  const activeTypes = systemTypes.data ?? []
  const inactiveLinkedType = contract && linkedType && !linkedType.isActive ? linkedType : null
  // Until the contract's own link is known, its current system cannot be shown correctly.
  const systemReady = systemTypes.isSuccess && (!start || currentLinks.isSuccess || currentLinks.isError)
  const systemUnavailable = systemTypes.isError
  const chooseSystem = (value: string) => {
    setChosenSystem(value)
    setSystemError(null)
  }

  // The contract document of a new contract: chosen here, sent with the contract, saved with it or not at all.
  const limits = useQuery({
    queryKey: ['attachments', 'limits', 'amc_contracts'],
    queryFn: () => api.get<{ maxMb: number; allowedTypes: string[]; storageAvailable?: boolean }>('/attachments/limits?entityType=amc_contracts'),
    enabled: isNew,
    retry: false,
  })
  const maxMb = limits.data?.maxMb ?? DEFAULT_MAX_MB
  // A server without file storage cannot keep the mandatory document, so a new contract cannot be added there.
  const storageMissing = isNew && limits.data?.storageAvailable === false
  const [documentFile, setDocumentFile] = useState<File | null>(null)
  const [documentError, setDocumentError] = useState<string | null>(null)
  const chooseDocument = (file: File | undefined) => {
    if (!file) return

    const problem = contractDocumentProblem(file, maxMb)

    setDocumentError(problem)
    setDocumentFile(problem ? null : file)
  }
  const removeDocument = () => {
    setDocumentFile(null)
    setDocumentError(null)
    if (documentInput.current) documentInput.current.value = ''
  }
  // Editing never asks for a new upload: the contract's documents are managed on its page. Shown so the user knows.
  const documents = useQuery({
    queryKey: ['attachments', 'amc_contracts', contract?.id],
    queryFn: () => api.get<{ id: string; category: string }[]>(`/attachments?entityType=amc_contracts&entityId=${contract?.id}`),
    enabled: contract !== null,
    retry: false,
  })

  // The frequencies a contract can choose (frequency master, or the four built-in ones).
  const frequencies = useFrequencyOptions()
  const chosenFrequency = useWatch({ control, name: 'maintenanceFrequency' })
  const chosenMonths = useWatch({ control, name: 'customMonths' })
  const isCustom = (code: string) => frequencies.options.some((option) => option.code === code && option.isCustom) || (code === contract?.maintenanceFrequency && (contract.customMonths ?? []).length > 0)
  const customChosen = isCustom(chosenFrequency)
  // A contract keeps a frequency that has since been disabled; it stays selectable on that contract.
  const currentFrequencyMissing = start !== null && start.maintenanceFrequency !== '' && !frequencies.options.some((option) => option.code === start.maintenanceFrequency)
  const toggleMonth = (month: number) => {
    const next = chosenMonths.includes(month) ? chosenMonths.filter((item) => item !== month) : [...chosenMonths, month].sort((a, b) => a - b)
    setValue('customMonths', next, { shouldValidate: false })
  }

  const [durationYears, setDurationYears] = useState('')
  const chooseDuration = (value: string) => {
    setDurationYears(value)
    const from = getValues('validFrom')

    if (value && from) setValue('validTo', contractEndDate(from, Number(value)), { shouldValidate: true })
  }

  // Final Credit is required on a new contract, and on a contract that already has one (it cannot be cleared).
  const finalCreditRequired = isNew || (contract !== null && contract.finalCredit !== null)

  const save = useMutation({
    mutationFn: async (values: ContractForm) => {
      // The AMC Reference Number is sent only when creating; it cannot be changed afterwards.
      const { status, customMonths, billingBasis, customBillingValue, renewalNotes, amcReference, ...rest } = values
      // Months are sent only for a custom frequency; for a fixed one the API clears them.
      const fields = { ...(isCustom(values.maintenanceFrequency) ? { ...rest, customMonths } : rest), billingBasis: billingBasis === '' ? null : billingBasis, ...(billingBasis === 'CUSTOM' ? { customBillingValue } : {}) }

      // The Sales Engineer master link is sent only when the picker is offered and its value changed.
      const link = engineerPicker && engineerId !== currentEngineerId ? { salesEngineerId: engineerId || null } : {}
      // The system: a chosen type (the API sets the system text to its name). An existing contract sends it only when it changed.
      const chosenType = activeTypes.find((type) => type.id === systemChoice) ?? (inactiveLinkedType?.id === systemChoice ? inactiveLinkedType : null)
      const system =
        systemChoice === CURRENT_SYSTEM && renewalOf
          ? { systemDescription: renewalOf.systemDescription }
          : systemChoice === CURRENT_SYSTEM || !chosenType
          ? {}
          : contract
            ? chosenType.id !== linkedType?.id
              ? { systemTypeId: chosenType.id }
              : {}
            : { systemTypeId: chosenType.id, systemDescription: chosenType.name }

      if (contract) {
        return api.patch<SavedContract>(`/amc/contracts/${contract.id}`, { ...fields, ...link, ...system })
      }
      if (renewalOf) {
        return api.post<SavedContract>(`/amc/contracts/${renewalOf.id}/renewals`, { amcReference, ...fields, status, ...link, ...system, ...(renewalNotes ? { renewalNotes } : {}) })
      }

      const file = documentFile as File
      const contractDocument = { fileName: file.name, contentBase64: await readAsBase64(file) }

      return api.post<SavedContract>('/amc/contracts', { amcReference, ...fields, status, ...link, ...system, contractDocument })
    },
    onSuccess: async (saved) => {
      await refreshOperationalData(queryClient)
      onSaved(saved)
    },
    onError: (error) => {
      let shownOnField = false

      if (error instanceof ApiError) {
        for (const detail of error.details) {
          if (detail.field === 'salesEngineerId' && engineerPicker) {
            setEngineerError(detail.message)
            shownOnField = true
          } else if (detail.field === 'systemTypeId' || detail.field === 'systemDescription') {
            setSystemError(detail.message)
            shownOnField = true
          } else if (detail.field === 'contractDocument' || detail.field.startsWith('contractDocument.')) {
            setDocumentError(detail.message)
            shownOnField = true
          } else if ((FIELDS as readonly string[]).includes(detail.field)) {
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
          customMonths: isCustom(values.maintenanceFrequency) ? values.customMonths.join(',') : undefined,
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

  /** The checks outside the form library: system, engineer, Final Credit and the document. True when all pass. */
  const checkRequiredChoices = (values: ContractForm): boolean => {
    let ok = true

    if (!systemChoice) {
      setSystemError('Select a system.')
      ok = false
    }
    if (engineerRequired && engineerPicker && !engineerId) {
      setEngineerError(
        previousInactive
          ? `Select an active sales engineer. ${previousInactive.name}, the previous engineer, is no longer active.`
          : renewalOf
            ? 'Select an active sales engineer for the renewal.'
            : 'Select a sales engineer.',
      )
      ok = false
    }
    if (finalCreditRequired && values.finalCredit.trim() === '') {
      setError('finalCredit', { message: contract ? 'Final credit is required. Enter 0 when there is none.' : 'Final credit is required.' })
      ok = false
    }
    if (isNew && !documentFile) {
      setDocumentError(documentError ?? 'Attach the contract document.')
      ok = false
    }

    return ok
  }

  const onSubmit = handleSubmit(
    (values) => {
      setFailure(null)

      // Every problem is shown at once, not one at a time.
      const choicesOk = checkRequiredChoices(values)
      const monthsOk = !isCustom(values.maintenanceFrequency) || (values.customMonths.length > 0 && values.customMonths.length <= 11)

      if (!monthsOk) {
        setError('customMonths', {
          message: values.customMonths.length === 0 ? 'Select the months in which visits take place.' : 'Select at most 11 months. For a visit every month, choose the monthly frequency.',
        })
      }
      if (!choicesOk || !monthsOk) {
        return
      }

      const termsChanged =
        contract !== null &&
        (values.validFrom !== contract.validFrom ||
          values.validTo !== contract.validTo ||
          values.maintenanceFrequency !== contract.maintenanceFrequency ||
          (isCustom(values.maintenanceFrequency) && values.customMonths.join(',') !== (contract.customMonths ?? []).join(',')))

      // Changing the terms of an active contract changes its schedule: show what will happen first.
      if (contract?.status === 'ACTIVE' && termsChanged) {
        preview.mutate(values)
      } else {
        save.mutate(values)
      }
    },
    // The other required choices are flagged at the same time as the form's own errors.
    () => checkRequiredChoices(getValues()),
  )

  const busy = save.isPending || preview.isPending
  const termsLocked = contract !== null && contract.status !== 'DRAFT' && contract.status !== 'ACTIVE'
  const options = clients.data ?? []
  // The contract's own client stays shown even if it has since been deactivated. Editing keeps it; a renewal cannot be
  // saved for it (the API refuses an inactive client), so the field says why instead of showing an empty choice.
  const currentMissing = start !== null && !options.some((client) => client.id === start.client.id)
  const newStatus = useWatch({ control, name: 'status' })
  const chosenBasis = useWatch({ control, name: 'billingBasis' })
  // A new contract or renewal cannot be saved without a system from the list (an existing one keeps its own).
  const systemBlocking = contract === null && systemUnavailable

  const plan = review?.preview ?? null
  const documentCount = documents.data?.length ?? null

  return (
    <Modal
      title={review ? 'Confirm schedule change' : contract ? 'Edit AMC Contract' : renewalOf ? 'Renew AMC Contract' : 'Add AMC Contract'}
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
            <Button
              type="submit"
              form="amc-contract-form"
              loading={busy}
              disabled={clients.isPending || (engineerRequired && !engineerPicker) || systemBlocking || engineerListUnavailable || storageMissing}
            >
              {contract ? 'Save changes' : renewalOf ? 'Create renewal' : 'Add contract'}
            </Button>
          </>
        )
      }
    >
      {plan && (
        <div className="space-y-4 text-sm text-slate-700">
          <p>
            The new terms ({formatDate(plan.validFrom)} to {formatDate(plan.validTo)}, {frequencyLabel(plan.maintenanceFrequency).toLowerCase()}
            {plan.customMonths && plan.customMonths.length > 0 ? ` (${plan.customMonths.map((month) => MONTH_NAMES[month - 1]).join(', ')})` : ''}) change this
            contract&apos;s schedule:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>{plan.toCreate.length}</strong> visit(s) will be added
              {plan.toCreate.length > 0 && (
                <>: {plan.toCreate.map((period) => `${formatDate(period.scheduledDate)}${period.serviceCode ? ` (${period.serviceCode})` : ''}`).join(', ')}</>
              )}
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
            {contract ? (
              <TextField
                label="AMC Reference Number"
                value={contract.amcReference}
                readOnly
                aria-readonly="true"
                hint="Set when the contract was created. It cannot be changed."
                className="bg-slate-50 font-mono font-semibold text-slate-800"
              />
            ) : (
              <TextField
                label="AMC Reference Number"
                required
                autoComplete="off"
                spellCheck={false}
                maxLength={AMC_REFERENCE_MAX}
                placeholder="For example AMC-2026-001"
                hint={
                  renewalOf
                    ? `A renewal needs its own new number; ${renewalOf.amcReference} stays with the contract being renewed. It cannot be changed later.`
                    : 'Enter the contract number. Each number can be used only once and cannot be changed later.'
                }
                error={errors.amcReference?.message}
                className="font-mono"
                {...register('amcReference')}
              />
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label="Client"
              required
              error={errors.clientId?.message}
              hint={
                renewalOf
                  ? currentMissing
                    ? 'This client is inactive. Reactivate it in Clients before renewing the contract.'
                    : 'A renewal is for the same client as the contract it renews.'
                  : options.length === 0
                    ? 'No active clients. Add the client in Clients first.'
                    : undefined
              }
              {...register('clientId')}
            >
              <option value="">Select a client…</option>
              {currentMissing && start && <option value={start.client.id}>{start.client.name} (inactive)</option>}
              {options.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                  {client.code ? ` (${client.code})` : ''}
                </option>
              ))}
            </SelectField>
            <SelectField
              label="System"
              required
              disabled={!systemReady && !systemUnavailable}
              error={systemError ?? undefined}
              hint={
                systemUnavailable
                  ? isForbidden(systemTypes.error)
                    ? 'Your role cannot read the System Types list, so a system cannot be chosen. Ask an administrator for access.'
                    : contract
                      ? 'The System Types list could not be loaded. The contract keeps its current system; close the form and try again to change it.'
                      : 'The System Types list could not be loaded, and a contract needs a system. Close this form and try again.'
                  : !systemReady
                    ? 'Loading systems…'
                    : activeTypes.length === 0
                      ? 'No active system types. Add one in Master Data → System Types first.'
                      : legacySystem !== null && systemChoice === CURRENT_SYSTEM
                        ? renewalOf
                          ? 'Kept as typed on the renewed contract, which has no active system type. You can choose one from the list instead.'
                          : 'This older contract’s system is not linked to the System Types list. It is kept unless you choose a system.'
                        : 'From the System Types master list. Only active systems are offered.'
              }
              value={systemChoice}
              onChange={(event) => chooseSystem(event.target.value)}
            >
              <option value="" disabled={contract !== null && systemChoice !== ''}>
                Select a system...
              </option>
              {legacySystem !== null && (
                <option value={CURRENT_SYSTEM}>
                  {legacySystem} {renewalOf ? '(as on the renewed contract)' : '(current, not in the list)'}
                </option>
              )}
              {inactiveLinkedType && <option value={inactiveLinkedType.id}>{inactiveLinkedType.name} (inactive)</option>}
              {activeTypes.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                  {type.code && type.code !== type.name ? ` (${type.code})` : ''}
                </option>
              ))}
            </SelectField>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Responsible engineer" error={errors.responsibleEngineer?.message} {...register('responsibleEngineer')} />
            {engineerListUnavailable && (
              <Alert>
                {isForbidden(engineers.error) || isForbidden(currentLinks.error)
                  ? `${renewalOf ? 'A renewal' : 'A new contract'} needs a sales engineer, but your role cannot read the sales engineer list. Ask an administrator to grant access.`
                  : `The sales engineer list could not be loaded, and ${renewalOf ? 'a renewal' : 'a new contract'} needs one. Close this form and try again.`}
              </Alert>
            )}
            {engineerPicker && (
              <SelectField
                label="Sales engineer (master list)"
                required={engineerRequired}
                error={engineerError ?? undefined}
                hint={
                  previousInactive
                    ? `Previously assigned: ${previousInactive.name} (inactive). Select an active sales engineer for the renewal.`
                    : renewalOf
                      ? renewedEngineer
                        ? 'Kept from the contract being renewed. A renewal needs an active sales engineer; you can choose another.'
                        : 'A renewal needs an active sales engineer.'
                      : (engineers.data ?? []).length === 0 && engineerRequired
                        ? 'No active sales engineers. Add one in Master Data → Sales Engineers first.'
                        : contract === null
                          ? "Required. Links the contract to the engineer's master record; the typed name stays as entered."
                          : "Links the contract to the engineer's master record. The typed name stays as entered."
                }
                value={engineerId}
                onChange={(event) => chooseEngineer(event.target.value)}
              >
                {engineerRequired ? (
                  <option value="" disabled>
                    Select a sales engineer…
                  </option>
                ) : (
                  <option value="">Not linked</option>
                )}
                {currentEngineer && !currentEngineer.isActive && <option value={currentEngineer.id}>{currentEngineer.name} (inactive)</option>}
                {(engineers.data ?? []).map((engineer) => (
                  <option key={engineer.id} value={engineer.id}>
                    {engineer.name}
                    {engineer.employeeNo ? ` (${engineer.employeeNo})` : ''}
                  </option>
                ))}
              </SelectField>
            )}
            <SelectField
              label="Maintenance frequency"
              required
              disabled={termsLocked}
              error={errors.maintenanceFrequency?.message}
              hint={frequencies.failed ? 'The frequency list could not be loaded, so only the built-in frequencies are offered.' : 'Only active frequencies are offered.'}
              {...register('maintenanceFrequency')}
            >
              <option value="">Select a frequency…</option>
              {currentFrequencyMissing && start && <option value={start.maintenanceFrequency}>{frequencyLabel(start.maintenanceFrequency)} (not active)</option>}
              {frequencies.options.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.name}
                  {option.ruleSummary ? ` — ${option.ruleSummary}` : ''}
                </option>
              ))}
            </SelectField>
          </div>

          {customChosen && (
            <fieldset className="rounded-xl border border-slate-200 p-4" aria-describedby="custom-months-help">
              <legend className="px-1 text-sm font-semibold text-slate-800">
                Service months <span className="text-red-600" aria-hidden="true">*</span>
              </legend>
              <p id="custom-months-help" className="mb-3 text-xs text-slate-500">
                One visit in each selected month of every contract year, on the contract start&apos;s day of the month. Select 1 to 11 months.
              </p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {MONTH_NAMES.map((name, index) => (
                  <label key={name} className="flex items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={chosenMonths.includes(index + 1)}
                      disabled={termsLocked}
                      onChange={() => toggleMonth(index + 1)}
                      className="h-4 w-4 rounded border-slate-300 accent-[#1479BD]"
                    />
                    {name}
                  </label>
                ))}
              </div>
              {errors.customMonths?.message && (
                <p role="alert" className="mt-2 text-xs font-medium text-red-700">
                  {errors.customMonths.message}
                </p>
              )}
            </fieldset>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <TextField
              label="Valid from"
              type="date"
              required
              disabled={termsLocked}
              error={errors.validFrom?.message}
              {...register('validFrom', { onChange: () => chooseDuration(durationYears) })}
            />
            <SelectField
              label="Contract duration"
              hint="Fills Valid to. You can still change it."
              disabled={termsLocked}
              value={durationYears}
              onChange={(event) => chooseDuration(event.target.value)}
            >
              <option value="">Enter dates</option>
              {DURATION_YEARS.map((years) => (
                <option key={years} value={years}>
                  {years} {years === 1 ? 'year' : 'years'}
                </option>
              ))}
            </SelectField>
            <TextField label="Valid to" type="date" required disabled={termsLocked} error={errors.validTo?.message} {...register('validTo')} />
          </div>
          {termsLocked && (
            <p className="text-xs text-slate-500">
              The validity period and frequency of a {contract?.status.toLowerCase()} contract cannot be changed. Reactivate the contract first.
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <TextField label="AMC Value / Year" hint="Annual amount in OMR, excluding VAT." required inputMode="decimal" error={errors.contractValue?.message} {...register('contractValue')} />
            <TextField
              label="Default visit amount"
              inputMode="decimal"
              hint={chosenBasis ? 'Not used while a billing basis is selected: visit amounts are calculated from the basis.' : 'Amount for each generated visit when no billing basis is selected. Each visit can be changed afterwards.'}
              error={errors.defaultVisitAmount?.message}
              {...register('defaultVisitAmount')}
            />
            <TextField
              label="Final credit"
              required={finalCreditRequired}
              inputMode="decimal"
              hint={
                finalCreditRequired
                  ? 'Annual amount in OMR, excluding VAT; 0 when there is none. Used for visit amounts only when it is the selected billing basis.'
                  : 'Not recorded on this older contract. Annual amount; used for visit amounts only when it is the selected billing basis.'
              }
              error={errors.finalCredit?.message}
              {...register('finalCredit')}
            />
          </div>

          <SelectField label="Billing basis" hint="An annual amount, divided across each year's services. New visits use it; existing visits change only through Regenerate on the contract page." error={errors.billingBasis?.message} {...register('billingBasis')}>
            <option value="">Not set</option>
            <option value="CONTRACT_VALUE">AMC Value / Year</option>
            <option value="FINAL_CREDIT">Final Credit Value</option>
            <option value="CUSTOM">Custom Billing Value</option>
          </SelectField>
          {chosenBasis === 'CUSTOM' && <TextField label="Custom Billing Value" hint="Annual amount in OMR, excluding VAT." required inputMode="decimal" error={errors.customBillingValue?.message} {...register('customBillingValue')} />}

          {storageMissing && (
            <Alert>
              A new contract needs its contract document, but this server has no file storage configured, so contracts cannot be added yet. Ask the system administrator to configure document storage.
            </Alert>
          )}
          {isNew && (
            <div>
              <span id={`${documentInputId}-label`} className="mb-1 block text-sm font-medium text-slate-700">
                Contract document
                <span className="text-red-600" aria-hidden="true">
                  {' '}
                  *
                </span>
              </span>
              <input
                ref={documentInput}
                id={documentInputId}
                type="file"
                accept={CONTRACT_DOCUMENT_ACCEPT}
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(event) => chooseDocument(event.target.files?.[0])}
              />
              <div
                className={`flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-3 py-3 ${documentError ? 'border-red-500 bg-red-50/40' : 'border-slate-300 bg-slate-50'}`}
              >
                <Button
                  variant="secondary"
                  aria-labelledby={`${documentInputId}-label ${documentInputId}-action`}
                  aria-describedby={`${documentInputId}-${documentError ? 'error' : 'hint'}`}
                  aria-required="true"
                  aria-invalid={documentError ? true : undefined}
                  onClick={() => documentInput.current?.click()}
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="m20.5 11.5-8.2 8.2a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" />
                  </svg>
                  <span id={`${documentInputId}-action`}>{documentFile ? 'Replace file' : 'Attach file'}</span>
                </Button>
                {documentFile ? (
                  <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <span className="min-w-0 break-all font-medium text-slate-800">{documentFile.name}</span>
                    <span className="text-slate-500">{formatFileSize(documentFile.size)}</span>
                    <Button variant="ghost" size="sm" onClick={removeDocument} aria-label={`Remove ${documentFile.name}`}>
                      Remove
                    </Button>
                  </span>
                ) : (
                  <span className="text-sm text-slate-500">No file chosen</span>
                )}
              </div>
              {documentError ? (
                <p id={`${documentInputId}-error`} role="alert" className="mt-1 text-xs font-medium text-red-700">
                  {documentError}
                </p>
              ) : (
                <p id={`${documentInputId}-hint`} className="mt-1 text-xs text-slate-500">
                  The signed contract: PDF or Word (.doc, .docx), at most {maxMb} MB. Saved with the contract as its Signed contract document.
                </p>
              )}
            </div>
          )}
          {contract && (
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
              {documentCount === null
                ? 'Contract documents are managed in the Documents section of the contract page. Saving changes here does not ask for a new upload.'
                : documentCount === 0
                  ? 'No document is on file for this contract. Saving changes here does not require one; upload the contract document from the Documents section of the contract page.'
                  : `${documentCount} ${documentCount === 1 ? 'document is' : 'documents are'} on file. Saving changes here does not ask for a new upload; replace documents from the Documents section of the contract page.`}
            </p>
          )}

          <TextAreaField label="Description" rows={2} error={errors.description?.message} {...register('description')} />
          <TextAreaField label="Notes" rows={2} error={errors.notes?.message} {...register('notes')} />
          {renewalOf && <TextAreaField label="Renewal notes" rows={2} hint="Optional. Kept in the new contract's history." error={errors.renewalNotes?.message} {...register('renewalNotes')} />}

          {!contract && draftOnly && (
            <p className="rounded-lg bg-sky-50 px-3 py-2 text-sm text-slate-700">
              Saved as a draft, under client approval. It has no schedule until it is approved, which activates it.
            </p>
          )}
          {!contract && !draftOnly && (
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

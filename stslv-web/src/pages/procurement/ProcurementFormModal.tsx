import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { z } from 'zod'
import { ProjectPickerField } from '../../components/records'
import { Alert, Button, Modal, Spinner, TextAreaField, TextField } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { applyApiErrors } from '../../lib/formErrors'
import { todayIso } from '../../lib/format'
import { isMoney, MONEY_MESSAGE } from '../../lib/money'
import { projectLabel, useProjectOptions } from '../../lib/projectOptions'
import type { ProcurementRequest, ProjectOption } from '../../lib/projectTypes'

// Mirrors the API's rules so most problems are caught before a request is sent.
// The API validates again and remains the authority.
const procurementSchema = z.object({
  projectId: z.string().min(1, 'Select a project.'),
  reference: z.string().trim().max(100, 'Request reference must be at most 100 characters.'),
  description: z.string().trim().min(1, 'Requirement is required.').max(1000, 'Requirement must be at most 1000 characters.'),
  requestDate: z.string().min(1, 'Request date is required.'),
  supplierName: z.string().trim().max(200, 'Supplier must be at most 200 characters.'),
  quotationReference: z.string().trim().max(100, 'Quotation reference must be at most 100 characters.'),
  quotationDate: z.string(),
  quotationAmount: z
    .string()
    .trim()
    .refine((value) => value === '' || isMoney(value), MONEY_MESSAGE),
  poReference: z.string().trim().max(100, 'Order / PO reference must be at most 100 characters.'),
  orderDate: z.string(),
  expectedDeliveryDate: z.string(),
  notes: z.string().trim().max(2000, 'Notes must be at most 2000 characters.'),
})

type ProcurementForm = z.infer<typeof procurementSchema>
const FIELDS = [
  'projectId',
  'reference',
  'description',
  'requestDate',
  'supplierName',
  'quotationReference',
  'quotationDate',
  'quotationAmount',
  'poReference',
  'orderDate',
  'expectedDeliveryDate',
  'notes',
] as const

export interface FixedProject {
  id: string
  jobNumber: string
  clientName: string
  description: string
}

interface ProcurementFormModalProps {
  /** The request to edit, or null to add a new one. */
  request: ProcurementRequest | null
  /** Set when the form is opened from a project: the new request belongs to it. */
  fixedProject?: FixedProject | undefined
  onClose: () => void
  onSaved: (request: ProcurementRequest) => void
}

export function ProcurementFormModal({ request, fixedProject, onClose, onSaved }: ProcurementFormModalProps) {
  // The project is chosen only for a new request that was not opened from a project.
  const needsPicker = request === null && fixedProject === undefined
  const options = useProjectOptions()
  const title = request ? 'Edit Procurement Request' : 'New Procurement Request'

  if (needsPicker && !options.data) {
    return (
      <Modal title={title} onClose={onClose} size="lg" footer={<Button onClick={onClose}>Close</Button>}>
        {options.isError ? <Alert>{errorMessage(options.error)}</Alert> : <Spinner label="Loading form" />}
      </Modal>
    )
  }

  return (
    <ProcurementFormBody
      title={title}
      request={request}
      fixedProject={fixedProject}
      options={needsPicker ? (options.data ?? []) : null}
      onClose={onClose}
      onSaved={onSaved}
    />
  )
}

interface ProcurementFormBodyProps extends ProcurementFormModalProps {
  title: string
  /** Null when the project is already decided. */
  options: ProjectOption[] | null
}

function ProcurementFormBody({ title, request, fixedProject, options, onClose, onSaved }: ProcurementFormBodyProps) {
  const queryClient = useQueryClient()
  const [failure, setFailure] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    setError,
    control,
    formState: { errors },
  } = useForm<ProcurementForm>({
    resolver: zodResolver(procurementSchema),
    defaultValues: {
      projectId: request?.projectId ?? fixedProject?.id ?? '',
      reference: request?.reference ?? '',
      description: request?.description ?? '',
      requestDate: request?.requestDate ?? todayIso(),
      supplierName: request?.supplierName ?? '',
      quotationReference: request?.quotationReference ?? '',
      quotationDate: request?.quotationDate ?? '',
      quotationAmount: request?.quotationAmount ?? '',
      poReference: request?.poReference ?? '',
      orderDate: request?.orderDate ?? '',
      expectedDeliveryDate: request?.expectedDeliveryDate ?? '',
      notes: request?.notes ?? '',
    },
  })

  const save = useMutation({
    mutationFn: ({ projectId, ...fields }: ProcurementForm) =>
      request
        ? api.patch<ProcurementRequest>(`/procurement/${request.id}`, fields)
        : api.post<ProcurementRequest>('/procurement', { projectId, ...fields }),
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ['procurement'] })
      onSaved(saved)
    },
    onError: (error) => setFailure(applyApiErrors(error, FIELDS, setError)),
  })

  const onSubmit = handleSubmit((values) => {
    setFailure(null)
    save.mutate(values)
  })

  const selectedId = useWatch({ control, name: 'projectId' })
  // On an edit, or when opened from a project, the project is already decided.
  const decidedLabel = request
    ? projectLabel({ jobNumber: request.jobNumber, clientName: request.clientName, description: request.projectDescription })
    : fixedProject
      ? projectLabel(fixedProject)
      : null

  return (
    <Modal
      title={title}
      onClose={onClose}
      size="xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="procurement-form" loading={save.isPending}>
            {request ? 'Save changes' : 'Add request'}
          </Button>
        </>
      }
    >
      <form id="procurement-form" onSubmit={onSubmit} noValidate className="space-y-4">
        {failure && <Alert>{failure}</Alert>}

        {options ? (
          <ProjectPickerField
            options={options}
            registration={register('projectId')}
            selectedId={selectedId}
            error={errors.projectId?.message}
          />
        ) : (
          decidedLabel && (
            <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              <span className="font-medium">Project / job: </span>
              {decidedLabel}
            </div>
          )
        )}

        <TextAreaField label="Requirement" rows={2} required hint="What is needed." error={errors.description?.message} {...register('description')} />

        <div className="grid gap-4 sm:grid-cols-3">
          <TextField label="Request date" type="date" required error={errors.requestDate?.message} {...register('requestDate')} />
          <TextField label="Request reference" error={errors.reference?.message} {...register('reference')} />
          <TextField label="Supplier" error={errors.supplierName?.message} {...register('supplierName')} />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <TextField label="Quotation reference" error={errors.quotationReference?.message} {...register('quotationReference')} />
          <TextField label="Quotation date" type="date" error={errors.quotationDate?.message} {...register('quotationDate')} />
          <TextField
            label="Quotation amount"
            inputMode="decimal"
            hint="Up to 3 decimal places. Not counted as a project cost."
            error={errors.quotationAmount?.message}
            {...register('quotationAmount')}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <TextField label="Order / PO reference" error={errors.poReference?.message} {...register('poReference')} />
          <TextField label="Order date" type="date" error={errors.orderDate?.message} {...register('orderDate')} />
          <TextField label="Expected delivery" type="date" error={errors.expectedDeliveryDate?.message} {...register('expectedDeliveryDate')} />
        </div>

        <TextAreaField label="Notes" rows={3} error={errors.notes?.message} {...register('notes')} />
      </form>
    </Modal>
  )
}

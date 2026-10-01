import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { z } from 'zod'
import { Money } from '../../components/records'
import { Alert, Button, Modal, SelectField, Spinner, TextAreaField, TextField } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { applyApiErrors } from '../../lib/formErrors'
import { todayIso } from '../../lib/format'
import { isMoney, isRate, MONEY_MESSAGE, previewVat } from '../../lib/money'
import type { Project, ProjectDefaults } from '../../lib/projectTypes'
import type { Client, Paged } from '../../lib/types'

// Mirrors the API's rules so most problems are caught before a request is sent.
// The API validates again and remains the authority.
const projectSchema = z.object({
  clientId: z.string().min(1, 'Select a client.'),
  description: z.string().trim().min(1, 'Job description is required.').max(1000, 'Job description must be at most 1000 characters.'),
  jobDate: z.string().min(1, 'Job date is required.'),
  lpoNumber: z.string().trim().max(100, 'LPO number must be at most 100 characters.'),
  lpoDate: z.string(),
  jobValue: z.string().trim().min(1, 'Job value is required.').refine(isMoney, MONEY_MESSAGE),
  vatRate: z.string().trim().min(1, 'VAT rate is required.').refine(isRate, 'Enter a percentage between 0 and 100 with at most 3 decimal places.'),
  budgetAmount: z
    .string()
    .trim()
    .refine((value) => value === '' || isMoney(value), MONEY_MESSAGE),
  notes: z.string().trim().max(2000, 'Notes must be at most 2000 characters.'),
})

type ProjectForm = z.infer<typeof projectSchema>
const FIELDS = ['clientId', 'description', 'jobDate', 'lpoNumber', 'lpoDate', 'jobValue', 'vatRate', 'budgetAmount', 'notes'] as const

/** Every active client, however many pages the API returns them in. */
async function fetchActiveClients(): Promise<Client[]> {
  const clients: Client[] = []

  for (let page = 1; ; page += 1) {
    const result = await api.get<Paged<Client>>(`/clients?status=active&pageSize=100&page=${page}`)
    clients.push(...result.items)

    if (result.items.length === 0 || clients.length >= result.total) {
      return clients
    }
  }
}

interface ProjectFormModalProps {
  /** The project to edit, or null to add a new one. */
  project: Project | null
  onClose: () => void
  onSaved: (project: Project) => void
}

export function ProjectFormModal({ project, onClose, onSaved }: ProjectFormModalProps) {
  const clients = useQuery({ queryKey: ['clients', 'active-options'], queryFn: fetchActiveClients })
  // Only a new project needs the default VAT rate and the job-number preview.
  const defaults = useQuery({
    queryKey: ['projects', 'defaults'],
    queryFn: () => api.get<ProjectDefaults>('/projects/defaults'),
    enabled: project === null,
    staleTime: 0,
  })
  const title = project ? `Edit Project ${project.jobNumber}` : 'New Project'
  const failed = clients.isError ? clients.error : defaults.isError ? defaults.error : null

  if (!clients.data || (project === null && !defaults.data)) {
    return (
      <Modal title={title} onClose={onClose} size="lg" footer={<Button onClick={onClose}>Close</Button>}>
        {failed ? <Alert>{errorMessage(failed)}</Alert> : <Spinner label="Loading form" />}
      </Modal>
    )
  }

  return (
    <ProjectFormBody
      title={title}
      project={project}
      clients={clients.data}
      defaults={defaults.data ?? null}
      onClose={onClose}
      onSaved={onSaved}
    />
  )
}

interface ProjectFormBodyProps extends ProjectFormModalProps {
  title: string
  clients: Client[]
  defaults: ProjectDefaults | null
}

function ProjectFormBody({ title, project, clients, defaults, onClose, onSaved }: ProjectFormBodyProps) {
  const queryClient = useQueryClient()
  const [failure, setFailure] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    setError,
    control,
    formState: { errors },
  } = useForm<ProjectForm>({
    resolver: zodResolver(projectSchema),
    defaultValues: {
      clientId: project?.clientId ?? '',
      description: project?.description ?? '',
      jobDate: project?.jobDate ?? todayIso(),
      lpoNumber: project?.lpoNumber ?? '',
      lpoDate: project?.lpoDate ?? '',
      jobValue: project?.jobValue ?? '',
      vatRate: project?.vatRate ?? defaults?.defaultVatRate ?? '',
      budgetAmount: project?.budgetAmount ?? '',
      notes: project?.notes ?? '',
    },
  })

  const save = useMutation({
    mutationFn: (values: ProjectForm) =>
      project ? api.patch<Project>(`/projects/${project.id}`, values) : api.post<Project>('/projects', values),
    onSuccess: async (saved) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['projects'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ])
      onSaved(saved)
    },
    onError: (error) => setFailure(applyApiErrors(error, FIELDS, setError)),
  })

  const onSubmit = handleSubmit((values) => {
    setFailure(null)
    save.mutate(values)
  })

  const [jobValue, vatRate] = useWatch({ control, name: ['jobValue', 'vatRate'] })
  const preview = previewVat(jobValue, vatRate)
  // A project keeps its client even if that client has since been deactivated.
  const currentClientMissing = project !== null && !clients.some((client) => client.id === project.clientId)

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
          <Button type="submit" form="project-form" loading={save.isPending}>
            {project ? 'Save changes' : 'Create project'}
          </Button>
        </>
      }
    >
      <form id="project-form" onSubmit={onSubmit} noValidate className="space-y-4">
        {failure && <Alert>{failure}</Alert>}

        <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          <span className="font-medium">Job number: </span>
          {project ? (
            project.jobNumber
          ) : (
            <>
              assigned automatically when the project is saved (next available: <strong>{defaults?.nextJobNumber}</strong>)
            </>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField label="Client" required error={errors.clientId?.message} {...register('clientId')}>
            <option value="">Select a client…</option>
            {currentClientMissing && project && <option value={project.clientId}>{project.clientName} (inactive)</option>}
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </SelectField>
          <TextField label="Job date" type="date" required error={errors.jobDate?.message} {...register('jobDate')} />
        </div>

        <TextAreaField label="Job description" rows={2} required error={errors.description?.message} {...register('description')} />

        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="LPO number" error={errors.lpoNumber?.message} {...register('lpoNumber')} />
          <TextField label="LPO date" type="date" error={errors.lpoDate?.message} {...register('lpoDate')} />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <TextField
            label="Job value"
            inputMode="decimal"
            required
            hint="Excluding VAT. Up to 3 decimal places."
            error={errors.jobValue?.message}
            {...register('jobValue')}
          />
          <TextField
            label="VAT rate (%)"
            inputMode="decimal"
            required
            hint="Kept on this project."
            error={errors.vatRate?.message}
            {...register('vatRate')}
          />
          <TextField
            label="Budget"
            inputMode="decimal"
            hint="Planned cost. Optional."
            error={errors.budgetAmount?.message}
            {...register('budgetAmount')}
          />
        </div>

        <dl aria-live="polite" className="grid gap-4 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="font-medium text-slate-600">VAT amount</dt>
            <dd className="mt-0.5 text-base font-semibold text-slate-900" data-testid="vat-preview">
              <Money value={preview?.vatAmount ?? null} />
            </dd>
          </div>
          <div>
            <dt className="font-medium text-slate-600">Grand job value</dt>
            <dd className="mt-0.5 text-base font-semibold text-slate-900" data-testid="grand-preview">
              <Money value={preview?.grandValue ?? null} />
            </dd>
          </div>
          <p className="text-xs text-slate-500 sm:col-span-2">
            Calculated from the job value and VAT rate, rounded to 3 decimal places. The saved figures are calculated by the server.
          </p>
        </dl>

        <TextAreaField label="Notes" rows={3} error={errors.notes?.message} {...register('notes')} />
      </form>
    </Modal>
  )
}

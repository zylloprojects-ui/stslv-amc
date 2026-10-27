import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { Alert, Button, Modal, SelectField, TextAreaField, TextField } from '../../components/ui'
import { api, ApiError, errorMessage } from '../../lib/api'
import { CLIENT_TYPE_LABELS, type Client, type ClientFeatures } from '../../lib/types'

// Mirrors the API's rules so most problems are caught before a request is sent.
// The API validates again and remains the authority.
const clientSchema = z.object({
  name: z.string().trim().min(1, 'Client name is required.').max(200, 'Client name must be at most 200 characters.'),
  contactPerson: z.string().trim().max(200, 'Contact person must be at most 200 characters.'),
  email: z
    .string()
    .trim()
    .max(254, 'Email must be at most 254 characters.')
    .refine((value) => value === '' || z.email().safeParse(value).success, 'Enter a valid email address.'),
  phone: z.string().trim().max(50, 'Phone must be at most 50 characters.'),
  address: z.string().trim().max(1000, 'Address must be at most 1000 characters.'),
  notes: z.string().trim().max(2000, 'Notes must be at most 2000 characters.'),
  clientType: z.enum(['', 'COMPANY', 'INDIVIDUAL'], { error: 'Select Company or Individual.' }),
  vatNumber: z.string().trim().max(50, 'VAT number must be at most 50 characters.'),
})

type ClientForm = z.infer<typeof clientSchema>
const FIELDS = ['name', 'contactPerson', 'email', 'phone', 'address', 'notes', 'clientType', 'vatNumber'] as const

interface ClientFormModalProps {
  /** The client to edit, or null to add a new one. */
  client: Client | null
  onClose: () => void
  onSaved: (client: Client) => void
}

export function ClientFormModal({ client, onClose, onSaved }: ClientFormModalProps) {
  const queryClient = useQueryClient()
  const [failure, setFailure] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<ClientForm>({
    resolver: zodResolver(clientSchema),
    defaultValues: {
      name: client?.name ?? '',
      contactPerson: client?.contactPerson ?? '',
      email: client?.email ?? '',
      phone: client?.phone ?? '',
      address: client?.address ?? '',
      notes: client?.notes ?? '',
      clientType: client?.clientType ?? '',
      vatNumber: client?.vatNumber ?? '',
    },
  })

  // Client type and VAT number need migration 0074; on a database without it they are not offered.
  const features = useQuery({ queryKey: ['clients', 'features'], queryFn: () => api.get<ClientFeatures>('/clients/features'), staleTime: 60_000 })
  const withDetails = features.data?.clientDetails === true

  const save = useMutation({
    mutationFn: (values: ClientForm) => {
      const { clientType, vatNumber, ...base } = values
      const body = withDetails ? { ...base, clientType, vatNumber } : base

      return client ? api.patch<Client>(`/clients/${client.id}`, body) : api.post<Client>('/clients', body)
    },
    onSuccess: async (saved) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['clients'] }),
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

      setFailure(shownOnField ? null : errorMessage(error))
    },
  })

  const onSubmit = handleSubmit((values) => {
    setFailure(null)
    save.mutate(values)
  })

  return (
    <Modal
      title={client ? 'Edit Client' : 'Add Client'}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="client-form" loading={save.isPending}>
            {client ? 'Save changes' : 'Add client'}
          </Button>
        </>
      }
    >
      <form id="client-form" onSubmit={onSubmit} noValidate className="space-y-4">
        {failure && <Alert>{failure}</Alert>}

        <TextField label="Client name" required error={errors.name?.message} {...register('name')} />

        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Contact person" error={errors.contactPerson?.message} {...register('contactPerson')} />
          <TextField label="Phone" type="tel" error={errors.phone?.message} {...register('phone')} />
        </div>

        {withDetails && (
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField label="Client type" error={errors.clientType?.message} {...register('clientType')}>
              <option value="">Not specified</option>
              <option value="COMPANY">{CLIENT_TYPE_LABELS.COMPANY}</option>
              <option value="INDIVIDUAL">{CLIENT_TYPE_LABELS.INDIVIDUAL}</option>
            </SelectField>
            <TextField label="VAT number" error={errors.vatNumber?.message} {...register('vatNumber')} />
          </div>
        )}
        <TextField label="Email" type="email" error={errors.email?.message} {...register('email')} />
        <TextAreaField label="Address" rows={2} error={errors.address?.message} {...register('address')} />
        <TextAreaField label="Notes" rows={3} error={errors.notes?.message} {...register('notes')} />
      </form>
    </Modal>
  )
}

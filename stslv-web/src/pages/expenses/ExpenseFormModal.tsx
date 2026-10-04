import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { z } from 'zod'
import { ProjectPickerField } from '../../components/records'
import { Alert, Button, Modal, SelectField, Spinner, TextAreaField, TextField } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { applyApiErrors } from '../../lib/formErrors'
import { todayIso } from '../../lib/format'
import { isMoney, isZeroAmount, MONEY_MESSAGE } from '../../lib/money'
import { projectLabel, useProjectOptions } from '../../lib/projectOptions'
import type { Expense, ExpenseCategory, ProjectOption } from '../../lib/projectTypes'
import type { FixedProject } from '../procurement/ProcurementFormModal'

// Mirrors the API's rules so most problems are caught before a request is sent.
// The API validates again and remains the authority.
const expenseSchema = z.object({
  projectId: z.string().min(1, 'Select a project.'),
  categoryId: z.string().min(1, 'Select a category.'),
  expenseDate: z.string().min(1, 'Expense date is required.'),
  description: z.string().trim().min(1, 'Description is required.').max(1000, 'Description must be at most 1000 characters.'),
  payeeName: z.string().trim().max(200, 'Supplier / payee must be at most 200 characters.'),
  amount: z
    .string()
    .trim()
    .min(1, 'Amount is required.')
    .refine(isMoney, MONEY_MESSAGE)
    .refine((value) => !isZeroAmount(value), 'Amount must be greater than zero.'),
  paymentReference: z.string().trim().max(100, 'Payment reference must be at most 100 characters.'),
  notes: z.string().trim().max(2000, 'Notes must be at most 2000 characters.'),
})

type ExpenseForm = z.infer<typeof expenseSchema>
const FIELDS = ['projectId', 'categoryId', 'expenseDate', 'description', 'payeeName', 'amount', 'paymentReference', 'notes'] as const

interface ExpenseFormModalProps {
  /** The expense to edit, or null to record a new one. */
  expense: Expense | null
  /** Set when the form is opened from a project: the new expense belongs to it. */
  fixedProject?: FixedProject | undefined
  onClose: () => void
  onSaved: (expense: Expense) => void
}

export function ExpenseFormModal({ expense, fixedProject, onClose, onSaved }: ExpenseFormModalProps) {
  // An existing expense can be moved to another job, so editing always offers the project list.
  const needsPicker = expense !== null || fixedProject === undefined
  const options = useProjectOptions()
  const categories = useQuery({ queryKey: ['expenses', 'categories'], queryFn: () => api.get<ExpenseCategory[]>('/expenses/categories') })
  const title = expense ? 'Edit Expense' : 'Record Expense'
  const failed = categories.isError ? categories.error : needsPicker && options.isError ? options.error : null

  if (!categories.data || (needsPicker && !options.data)) {
    return (
      <Modal title={title} onClose={onClose} size="lg" footer={<Button onClick={onClose}>Close</Button>}>
        {failed ? <Alert>{errorMessage(failed)}</Alert> : <Spinner size="sm" label="Loading form" />}
      </Modal>
    )
  }

  return (
    <ExpenseFormBody
      title={title}
      expense={expense}
      fixedProject={fixedProject}
      options={needsPicker ? (options.data ?? []) : null}
      categories={categories.data}
      onClose={onClose}
      onSaved={onSaved}
    />
  )
}

interface ExpenseFormBodyProps extends ExpenseFormModalProps {
  title: string
  /** Null when the project is already decided. */
  options: ProjectOption[] | null
  categories: ExpenseCategory[]
}

function ExpenseFormBody({ title, expense, fixedProject, options, categories, onClose, onSaved }: ExpenseFormBodyProps) {
  const queryClient = useQueryClient()
  const [failure, setFailure] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    setError,
    control,
    formState: { errors },
  } = useForm<ExpenseForm>({
    resolver: zodResolver(expenseSchema),
    defaultValues: {
      projectId: expense?.projectId ?? fixedProject?.id ?? '',
      categoryId: expense?.categoryId ?? '',
      expenseDate: expense?.expenseDate ?? todayIso(),
      description: expense?.description ?? '',
      payeeName: expense?.payeeName ?? '',
      amount: expense?.amount ?? '',
      paymentReference: expense?.paymentReference ?? '',
      notes: expense?.notes ?? '',
    },
  })

  const save = useMutation({
    mutationFn: (values: ExpenseForm) => (expense ? api.patch<Expense>(`/expenses/${expense.id}`, values) : api.post<Expense>('/expenses', values)),
    onSuccess: async (saved) => {
      // Project totals are derived from expenses, so they are read again too.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['expenses'] }),
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

  const selectedId = useWatch({ control, name: 'projectId' })
  // A category that is no longer in use stays selectable on the expense that already has it.
  const selectable = categories.filter((category) => category.isActive || category.id === expense?.categoryId)

  return (
    <Modal
      title={title}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="expense-form" loading={save.isPending}>
            {expense ? 'Save changes' : 'Record expense'}
          </Button>
        </>
      }
    >
      <form id="expense-form" onSubmit={onSubmit} noValidate className="space-y-4">
        {failure && <Alert>{failure}</Alert>}

        {options ? (
          <ProjectPickerField
            options={options}
            registration={register('projectId')}
            selectedId={selectedId}
            error={errors.projectId?.message}
          />
        ) : (
          fixedProject && (
            <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              <span className="font-medium">Project / job: </span>
              {projectLabel(fixedProject)}
            </div>
          )
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField label="Category" required error={errors.categoryId?.message} {...register('categoryId')}>
            <option value="">Select a category…</option>
            {selectable.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </SelectField>
          <TextField label="Expense date" type="date" required error={errors.expenseDate?.message} {...register('expenseDate')} />
        </div>

        <TextAreaField label="Description" rows={2} required error={errors.description?.message} {...register('description')} />

        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Supplier / payee" error={errors.payeeName?.message} {...register('payeeName')} />
          <TextField
            label="Amount"
            inputMode="decimal"
            required
            hint="Up to 3 decimal places. Recorded as entered."
            error={errors.amount?.message}
            {...register('amount')}
          />
        </div>

        <TextField
          label="Payment reference"
          hint="Transfer, cheque or bill reference."
          error={errors.paymentReference?.message}
          {...register('paymentReference')}
        />
        <TextAreaField label="Notes" rows={2} error={errors.notes?.message} {...register('notes')} />
      </form>
    </Modal>
  )
}

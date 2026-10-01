import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useId, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../../auth/context'
import { FILTER_INPUT, FILTER_LABEL, LoadError, Money, Pager } from '../../components/records'
import { Alert, Button, Card, EmptyState, PageHeader, Spinner } from '../../components/ui'
import { api } from '../../lib/api'
import { projectLabel, useProjectOptions } from '../../lib/projectOptions'
import type { ExpenseCategory, PagedExpenses } from '../../lib/projectTypes'
import { ExpenseDialogs, type ExpenseDialog } from './ExpenseDialogs'
import { ExpensesTable } from './ExpensesTable'

const PAGE_SIZE = 25

export function ExpensesPage() {
  const auth = useAuth()
  const searchId = useId()
  const projectFilterId = useId()
  const categoryId = useId()
  const fromId = useId()
  const toId = useId()
  const voidedId = useId()
  // The project filter lives in the address, so a project page can link straight to its expenses.
  const [searchParams, setSearchParams] = useSearchParams()
  const projectId = searchParams.get('projectId') ?? ''

  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [includeVoided, setIncludeVoided] = useState(false)
  const [page, setPage] = useState(1)
  const [dialog, setDialog] = useState<ExpenseDialog>({ kind: 'none' })
  const [notice, setNotice] = useState<string | null>(null)

  // Wait for a pause in typing before searching.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 300)

    return () => clearTimeout(timer)
  }, [searchInput])

  const options = useProjectOptions()
  const categories = useQuery({ queryKey: ['expenses', 'categories'], queryFn: () => api.get<ExpenseCategory[]>('/expenses/categories') })
  const expenses = useQuery({
    queryKey: ['expenses', 'list', { search, projectId, category, dateFrom, dateTo, includeVoided, page }],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
      if (search) params.set('search', search)
      if (projectId) params.set('projectId', projectId)
      if (category) params.set('categoryId', category)
      if (dateFrom) params.set('dateFrom', dateFrom)
      if (dateTo) params.set('dateTo', dateTo)
      if (includeVoided) params.set('includeVoided', 'true')

      return api.get<PagedExpenses>(`/expenses?${params.toString()}`)
    },
    placeholderData: keepPreviousData,
  })

  const canCreate = auth.can('EXPENSES', 'CREATE')
  const canEdit = auth.can('EXPENSES', 'EDIT')
  // Expenses are never deleted, so the DELETE permission governs voiding.
  const canVoid = auth.can('EXPENSES', 'DELETE')
  const data = expenses.data
  const filtered = search !== '' || projectId !== '' || category !== '' || dateFrom !== '' || dateTo !== '' || includeVoided

  return (
    <>
      <PageHeader
        title="Expenses"
        description="Costs recorded against projects. Every expense belongs to a job."
        actions={canCreate && <Button onClick={() => setDialog({ kind: 'create' })}>Record Expense</Button>}
      />

      {notice && (
        <div className="mb-4">
          <Alert tone="success">{notice}</Alert>
        </div>
      )}

      <Card>
        <div className="flex flex-wrap items-end gap-4 border-b border-slate-200 p-4">
          <div className="min-w-56 flex-1">
            <label htmlFor={searchId} className={FILTER_LABEL}>
              Search
            </label>
            <input
              id={searchId}
              type="search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Description, payee, reference or job number"
              className={FILTER_INPUT}
            />
          </div>
          <div className="min-w-56 max-w-sm flex-1">
            <label htmlFor={projectFilterId} className={FILTER_LABEL}>
              Project
            </label>
            <select
              id={projectFilterId}
              value={projectId}
              onChange={(event) => {
                setSearchParams(event.target.value ? { projectId: event.target.value } : {}, { replace: true })
                setPage(1)
              }}
              className={FILTER_INPUT}
            >
              <option value="">All projects</option>
              {options.data?.map((option) => (
                <option key={option.id} value={option.id}>
                  {projectLabel(option)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={categoryId} className={FILTER_LABEL}>
              Category
            </label>
            <select
              id={categoryId}
              value={category}
              onChange={(event) => {
                setCategory(event.target.value)
                setPage(1)
              }}
              className={FILTER_INPUT}
            >
              <option value="">All categories</option>
              {categories.data?.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={fromId} className={FILTER_LABEL}>
              From
            </label>
            <input
              id={fromId}
              type="date"
              value={dateFrom}
              onChange={(event) => {
                setDateFrom(event.target.value)
                setPage(1)
              }}
              className={FILTER_INPUT}
            />
          </div>
          <div>
            <label htmlFor={toId} className={FILTER_LABEL}>
              To
            </label>
            <input
              id={toId}
              type="date"
              value={dateTo}
              onChange={(event) => {
                setDateTo(event.target.value)
                setPage(1)
              }}
              className={FILTER_INPUT}
            />
          </div>
          <div className="flex items-center gap-2 pb-2">
            <input
              id={voidedId}
              type="checkbox"
              checked={includeVoided}
              onChange={(event) => {
                setIncludeVoided(event.target.checked)
                setPage(1)
              }}
              className="h-4 w-4 rounded border-slate-300"
            />
            <label htmlFor={voidedId} className="text-sm text-slate-700">
              Show voided
            </label>
          </div>
        </div>

        {expenses.isPending && <Spinner label="Loading expenses" />}
        {expenses.isError && <LoadError error={expenses.error} onRetry={() => void expenses.refetch()} />}

        {data && data.items.length === 0 && (
          <EmptyState
            title={filtered ? 'No expenses match your search' : 'No expenses yet'}
            description={filtered ? 'Try a different search or filter.' : 'Record each cost against the project / job it belongs to.'}
            action={!filtered && canCreate ? <Button onClick={() => setDialog({ kind: 'create' })}>Record Expense</Button> : undefined}
          />
        )}

        {data && data.items.length > 0 && (
          <>
            <ExpensesTable
              items={data.items}
              showProject
              linkProject={auth.can('PROJECTS', 'VIEW')}
              canEdit={canEdit}
              canVoid={canVoid}
              onDialog={setDialog}
            />
            <Pager page={data.page} pageSize={data.pageSize} shown={data.items.length} total={data.total} onPage={setPage}>
              <p className="font-medium text-slate-900">
                {filtered ? 'Total of matching expenses' : 'Total tracked expenses'}:{' '}
                <span data-testid="expenses-total">
                  <Money value={data.totalAmount} />
                </span>
              </p>
            </Pager>
          </>
        )}
      </Card>

      <p className="mt-3 text-xs text-slate-500">
        The total covers every expense that matches the filters, on all pages. Voided expenses are never counted.
      </p>

      <ExpenseDialogs dialog={dialog} setDialog={setDialog} canEdit={canEdit} onNotice={setNotice} />
    </>
  )
}

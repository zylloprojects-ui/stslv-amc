import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { useAuth } from '../../auth/context'
import { Alert, Badge, Button, ConfirmDialog, EmptyState, Modal, TableScroll, TextField } from '../../components/ui'
import { TABLE } from '../../components/table'
import { api, ApiError, errorMessage } from '../../lib/api'
import { omanHolidays } from '../../lib/omanHolidays'
import { OmanHolidaysModal } from './OmanHolidaysModal'

type Country = 'OMAN' | 'QATAR' | 'BAHRAIN' | 'KSA' | 'UAE' | 'KUWAIT'

interface Holiday {
  id: string
  date: string
  name: string
  isReligious: boolean
  countries: Country[]
  divisions: string | null
}

interface HolidaysResponse {
  holidays: Holiday[]
  countries: Country[]
}

const COUNTRY_LABELS: Record<Country, string> = { OMAN: 'Oman', QATAR: 'Qatar', BAHRAIN: 'Bahrain', KSA: 'KSA', UAE: 'UAE', KUWAIT: 'Kuwait' }
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const FORM_ID = 'holiday-form'

const weekdayOf = (date: string) => WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()] ?? ''
const longDate = (date: string) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`))

const schema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date.'),
  name: z.string().trim().min(1, 'Name is required.').max(100, 'Name must be at most 100 characters.'),
  isReligious: z.boolean(),
  countries: z.array(z.string()).min(1, 'Choose at least one country.'),
  divisions: z.string().trim().max(200, 'Divisions must be at most 200 characters.'),
})

type Values = z.infer<typeof schema>

type Dialog = { kind: 'none' } | { kind: 'oman' } | { kind: 'add'; date: string } | { kind: 'edit'; holiday: Holiday } | { kind: 'delete'; holiday: Holiday }

function CountryTags({ countries }: { countries: Country[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {countries.map((country) => (
        <span key={country} className="rounded-md bg-sky-50 px-2 py-0.5 text-[11px] font-semibold text-[#0b3b66] ring-1 ring-inset ring-sky-200">
          {COUNTRY_LABELS[country]}
        </span>
      ))}
    </span>
  )
}

function HolidayForm({ holiday, date, countries, onClose, onSaved }: { holiday: Holiday | null; date: string; countries: Country[]; onClose: () => void; onSaved: (message: string) => void }) {
  const queryClient = useQueryClient()
  const editing = holiday !== null
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      date: holiday?.date ?? date,
      name: holiday?.name ?? '',
      isReligious: holiday?.isReligious ?? false,
      countries: holiday?.countries ?? [],
      divisions: holiday?.divisions ?? '',
    },
  })
  const [failure, setFailure] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (values: Values) => {
      const body = { ...values, divisions: values.divisions || null }

      return editing ? api.put<Holiday>(`/holidays/${holiday.id}`, body) : api.post<Holiday>('/holidays', body)
    },
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ['holidays'] })
      onSaved(editing ? `${saved.name} was updated.` : `${saved.name} was added.`)
    },
    onError: (error) => {
      let onField = false

      if (error instanceof ApiError) {
        for (const detail of error.details) {
          if (detail.field === 'date' || detail.field === 'name' || detail.field === 'countries' || detail.field === 'divisions') {
            setError(detail.field, { message: detail.message })
            onField = true
          }
        }
      }

      setFailure(onField ? null : errorMessage(error))
    },
  })

  return (
    <Modal
      title={editing ? 'Edit holiday' : 'Add holiday'}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form={FORM_ID} loading={save.isPending}>
            {editing ? 'Save changes' : 'Add holiday'}
          </Button>
        </>
      }
    >
      <form
        id={FORM_ID}
        noValidate
        className="space-y-4"
        onSubmit={handleSubmit((values) => {
          setFailure(null)
          save.mutate(values)
        })}
      >
        {failure && <Alert>{failure}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Date" type="date" required error={errors.date?.message} {...register('date')} />
          <TextField label="Holiday name" required error={errors.name?.message} {...register('name')} />
        </div>

        <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-slate-200 bg-slate-50/60 p-3.5 text-sm font-medium text-slate-800 hover:border-sky-300">
          <input type="checkbox" className="h-4 w-4 rounded border-slate-300" {...register('isReligious')} />
          <span>
            Religious holiday
            <span className="block text-xs font-normal text-slate-500">Tick this for a holiday that follows a religious calendar, such as Eid.</span>
          </span>
        </label>

        <fieldset>
          <legend className="mb-1.5 block text-sm font-medium text-slate-700">
            Countries <span className="text-red-600" aria-hidden="true">*</span>
          </legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {countries.map((country) => (
              <label key={country} className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-800 hover:border-sky-300 has-[:checked]:border-[#1479BD] has-[:checked]:bg-sky-50">
                <input type="checkbox" value={country} className="h-4 w-4 rounded border-slate-300" {...register('countries')} />
                {COUNTRY_LABELS[country]}
              </label>
            ))}
          </div>
          {errors.countries?.message && (
            <p role="alert" className="mt-1 text-xs font-medium text-red-700">
              {errors.countries.message}
            </p>
          )}
        </fieldset>

        <TextField label="Divisions" hint="Which divisions this applies to. Leave empty for all of them." error={errors.divisions?.message} {...register('divisions')} />
      </form>
    </Modal>
  )
}

const iconButton = 'inline-flex h-8 w-9 items-center justify-center text-slate-500 transition-colors hover:bg-sky-50 hover:text-[#1479BD] focus-visible:relative focus-visible:z-10'

/** A row of the table: a holiday stored in the calendar, or an official Oman holiday that is shown but not saved yet. */
interface Row extends Holiday {
  official: boolean
}

/**
 * The holidays of one year, January to December, in one table. The official Oman holidays announced for the year are
 * shown too, so the list is complete from the start; an official holiday can be saved to the calendar, and from then
 * on it can be edited like any other.
 */
export function HolidaysPanel() {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const [now] = useState(() => new Date())
  const [year, setYear] = useState(() => now.getFullYear())
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' })
  const [notice, setNotice] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const canView = auth.can('SETTINGS', 'VIEW')
  const canAdd = auth.can('SETTINGS', 'CREATE')
  const canEdit = auth.can('SETTINGS', 'EDIT')
  const canDelete = auth.can('SETTINGS', 'DELETE')
  const query = useQuery({ queryKey: ['holidays'], queryFn: () => api.get<HolidaysResponse>('/holidays'), enabled: canView })

  const remove = useMutation({
    mutationFn: (holiday: Holiday) => api.delete(`/holidays/${holiday.id}`),
    onSuccess: async (_data, holiday) => {
      await queryClient.invalidateQueries({ queryKey: ['holidays'] })
      setNotice(`${holiday.name} was deleted.`)
      setDialog({ kind: 'none' })
    },
    onError: (error) => setDeleteError(errorMessage(error)),
  })

  if (!canView) {
    return <p className="text-sm text-slate-600">The holiday list is visible to people who may view Settings.</p>
  }
  if (query.isPending) {
    return (
      <p className="text-sm text-slate-500" role="status">
        Loading holidays…
      </p>
    )
  }
  if (query.isError) {
    return <Alert>{errorMessage(query.error)}</Alert>
  }

  const { holidays, countries } = query.data
  const prefix = `${year}-`
  const stored: Row[] = holidays.filter((holiday) => holiday.date.startsWith(prefix)).map((holiday) => ({ ...holiday, official: false }))
  const have = new Set(stored.map((holiday) => `${holiday.date}|${holiday.name.toLowerCase()}`))
  const official: Row[] = omanHolidays(year)
    .filter((holiday) => !have.has(`${holiday.date}|${holiday.name.toLowerCase()}`))
    .map((holiday) => ({ id: `official:${holiday.date}:${holiday.name}`, ...holiday, countries: ['OMAN'], divisions: null, official: true }))
  const rows = [...stored, ...official].sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name))
  const religious = rows.filter((row) => row.isReligious).length
  const announced = omanHolidays(year).length > 0
  const close = () => {
    setDialog({ kind: 'none' })
    setDeleteError(null)
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setYear(year - 1)} aria-label="Previous year" className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 shadow-sm hover:bg-sky-50 hover:text-[#1479BD]">
            <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="m12 4-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <h3 className="min-w-24 text-center text-xl font-bold tabular-nums text-[#0b3b66]" aria-live="polite">
            {year}
          </h3>
          <button type="button" onClick={() => setYear(year + 1)} aria-label="Next year" className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 shadow-sm hover:bg-sky-50 hover:text-[#1479BD]">
            <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="m8 4 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {year !== now.getFullYear() && (
            <Button variant="secondary" size="sm" onClick={() => setYear(now.getFullYear())}>
              This year
            </Button>
          )}
        </div>
        {canAdd && (
          <div className="flex flex-wrap gap-2">
            {official.length > 0 && (
              <Button variant="secondary" onClick={() => setDialog({ kind: 'oman' })}>
                Add Oman holidays
              </Button>
            )}
            <Button onClick={() => setDialog({ kind: 'add', date: `${year}-01-01` })}>
              <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
                <path d="M10 4v12M4 10h12" strokeLinecap="round" />
              </svg>
              Add holiday
            </Button>
          </div>
        )}
      </div>

      {notice && (
        <Alert tone="success" onDismiss={() => setNotice(null)}>
          {notice}
        </Alert>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-200">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-gradient-to-r from-sky-50 via-white to-white px-5 py-3.5">
          <h3 className="text-base font-semibold text-slate-900">Holidays in {year}</h3>
          <span className="text-sm text-slate-500">
            <span className="font-semibold tabular-nums text-slate-800">{rows.length}</span> {rows.length === 1 ? 'day' : 'days'}
            {religious > 0 && (
              <>
                {' · '}
                <span className="font-semibold tabular-nums text-amber-700">{religious}</span> religious
              </>
            )}
          </span>
        </div>

        {rows.length === 0 ? (
          <EmptyState title={`No holidays in ${year}`} description={announced ? undefined : `Oman has not announced its public holidays for ${year} yet.${canAdd ? ' Use Add holiday to enter any holiday by hand.' : ''}`} />
        ) : (
          <TableScroll label={`Holidays in ${year}`}>
            <table className={TABLE.table}>
              <caption className="sr-only">Holidays in {year}</caption>
              <thead>
                <tr>
                  <th scope="col" className={TABLE.snHead}>
                    #
                  </th>
                  <th scope="col" className={TABLE.th}>
                    Date
                  </th>
                  <th scope="col" className={TABLE.th}>
                    Day
                  </th>
                  <th scope="col" className={TABLE.th}>
                    Holiday
                  </th>
                  <th scope="col" className={TABLE.th}>
                    Religious
                  </th>
                  <th scope="col" className={TABLE.th}>
                    Countries
                  </th>
                  <th scope="col" className={TABLE.th}>
                    Divisions
                  </th>
                  <th scope="col" className={`${TABLE.th} text-right`}>
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.flatMap((holiday, index) => {
                  const month = holiday.date.slice(0, 7)
                  const head =
                    index === 0 || rows[index - 1]?.date.slice(0, 7) !== month ? (
                      <tr key={`month-${month}`} className="!animate-none bg-sky-50/80">
                        <th colSpan={8} scope="colgroup" className="px-4 py-1.5 text-left text-[11px] font-bold uppercase tracking-[0.16em] text-[#1479BD]">
                          {MONTHS[Number(month.slice(5, 7)) - 1]} {year}
                        </th>
                      </tr>
                    ) : null

                  return [
                    head,
                    <tr key={holiday.id} className={TABLE.row}>
                      <td className={TABLE.sn}>{index + 1}</td>
                      <td className={`${TABLE.td} whitespace-nowrap font-medium text-slate-900`}>{longDate(holiday.date)}</td>
                      <td className={`${TABLE.td} whitespace-nowrap`}>{weekdayOf(holiday.date)}</td>
                      <td className={`${TABLE.td} min-w-44 font-semibold text-slate-900`}>{holiday.name}</td>
                      <td className={TABLE.td}>{holiday.isReligious ? <Badge tone="amber">Religious</Badge> : <span className="text-slate-400">No</span>}</td>
                      <td className={`${TABLE.td} min-w-32`}>
                        <CountryTags countries={holiday.countries} />
                      </td>
                      <td className={TABLE.td}>{holiday.divisions ?? <span className="text-slate-500">All divisions</span>}</td>
                      <td className={`${TABLE.td} whitespace-nowrap text-right`}>
                        {holiday.official ? (
                          <span title="Official list. Use Add Oman holidays to save it to the calendar, then it can be edited." className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600 ring-1 ring-inset ring-slate-200">
                            <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                              <rect x="4.5" y="9" width="11" height="7.5" rx="1.5" />
                              <path d="M7 9V6.5a3 3 0 0 1 6 0V9" strokeLinecap="round" />
                            </svg>
                            Official
                          </span>
                        ) : (
                          <div className="inline-flex items-center divide-x divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
                            {canEdit && (
                              <button type="button" aria-label={`Edit ${holiday.name}`} title={`Edit ${holiday.name}`} onClick={() => setDialog({ kind: 'edit', holiday })} className={iconButton}>
                                <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                                  <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3ZM14 8l3 3" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                              </button>
                            )}
                            {canDelete && (
                              <button
                                type="button"
                                aria-label={`Delete ${holiday.name}`}
                                title={`Delete ${holiday.name}`}
                                onClick={() => {
                                  setDeleteError(null)
                                  setDialog({ kind: 'delete', holiday })
                                }}
                                className={`${iconButton} hover:!bg-red-50 hover:!text-red-700`}
                              >
                                <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                                  <path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.8 12.5h9.4L17.5 7M10 11v5M14 11v5" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                              </button>
                            )}
                            {!canEdit && !canDelete && <span className="px-3 py-1.5 text-xs text-slate-400">—</span>}
                          </div>
                        )}
                      </td>
                    </tr>,
                  ]
                })}
              </tbody>
            </table>
          </TableScroll>
        )}
      </div>

      {announced && (
        <p className="text-xs text-slate-500">
          The official Oman holidays for {year} are those announced by the Ministry of Labour. Eid dates follow the moon and are announced shortly before each Eid.
        </p>
      )}

      {dialog.kind === 'oman' && (
        <OmanHolidaysModal
          year={year}
          existing={holidays}
          onClose={close}
          onDone={(message) => {
            setNotice(message)
            close()
          }}
        />
      )}
      {dialog.kind === 'add' && (
        <HolidayForm
          holiday={null}
          date={dialog.date}
          countries={countries}
          onClose={close}
          onSaved={(message) => {
            setNotice(message)
            close()
          }}
        />
      )}
      {dialog.kind === 'edit' && (
        <HolidayForm
          holiday={dialog.holiday}
          date={dialog.holiday.date}
          countries={countries}
          onClose={close}
          onSaved={(message) => {
            setNotice(message)
            close()
          }}
        />
      )}
      {dialog.kind === 'delete' && (
        <ConfirmDialog
          title="Delete holiday"
          message={
            <>
              Delete <strong>{dialog.holiday.name}</strong> on {longDate(dialog.holiday.date)}? This cannot be undone.
            </>
          }
          confirmLabel="Delete holiday"
          danger
          loading={remove.isPending}
          error={deleteError}
          onConfirm={() => remove.mutate(dialog.holiday)}
          onCancel={close}
        />
      )}
    </div>
  )
}

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Alert, Badge, Button, Modal } from '../../components/ui'
import { api, ApiError } from '../../lib/api'
import { omanHolidays } from '../../lib/omanHolidays'

interface Existing {
  date: string
  name: string
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const day = (date: string) => WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()] ?? ''
const longDate = (date: string) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`))

/**
 * Adds the public holidays of Oman for one year to the calendar. It shows the list first, leaves out any that are
 * already there, and sends the rest one by one, so each is checked and logged like a holiday added by hand.
 */
export function OmanHolidaysModal({ year, existing, onClose, onDone }: { year: number; existing: Existing[]; onClose: () => void; onDone: (message: string) => void }) {
  const queryClient = useQueryClient()
  const [failure, setFailure] = useState<string | null>(null)
  const list = omanHolidays(year)
  const have = new Set(existing.map((holiday) => `${holiday.date}|${holiday.name.toLowerCase()}`))
  const fresh = list.filter((holiday) => !have.has(`${holiday.date}|${holiday.name.toLowerCase()}`))
  const announced = list.length > 0

  const add = useMutation({
    mutationFn: async () => {
      let added = 0

      for (const holiday of fresh) {
        try {
          await api.post('/holidays', { date: holiday.date, name: holiday.name, isReligious: holiday.isReligious, countries: ['OMAN'], divisions: null })
          added += 1
        } catch (error) {
          // A holiday that appeared in the meantime is simply skipped; anything else stops the import.
          if (!(error instanceof ApiError && error.status === 409)) {
            throw error
          }
        }
      }

      return added
    },
    onSuccess: async (added) => {
      await queryClient.invalidateQueries({ queryKey: ['holidays'] })
      onDone(`${added} Oman ${added === 1 ? 'holiday was' : 'holidays were'} added for ${year}.`)
    },
    onError: async (error) => {
      await queryClient.invalidateQueries({ queryKey: ['holidays'] })
      setFailure(error instanceof ApiError ? error.message : 'The holidays could not be added. Please try again.')
    },
  })

  return (
    <Modal
      title={`Add Oman holidays for ${year}`}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={add.isPending}>
            Cancel
          </Button>
          <Button onClick={() => add.mutate()} loading={add.isPending} disabled={fresh.length === 0}>
            {fresh.length === 0 ? (announced ? 'Nothing to add' : 'No list for this year') : `Add ${fresh.length} ${fresh.length === 1 ? 'holiday' : 'holidays'}`}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {failure && <Alert>{failure}</Alert>}
        <p className="text-sm text-slate-600">
          Add the public holidays of Oman for {year} to the calendar. They are added for Oman only, and any that are already there are left out.
        </p>
        {announced ? (
          <Alert tone="info">
            These are the dates announced by Oman's Ministry of Labour for {year}. Renaissance Day is no longer a public holiday. The Eid al-Adha dates are as reported by news sites: check them against the Ministry's notice.
          </Alert>
        ) : (
          <Alert tone="info">
            Oman has not announced its public holidays for {year} in this list yet. The Ministry of Labour announces them at the start of each year. You can add any holiday by hand with Add holiday.
          </Alert>
        )}
        {announced && <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200">
          {list.map((holiday) => {
            const there = !fresh.includes(holiday)

            return (
              <li key={`${holiday.date}-${holiday.name}`} className={`flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 ${there ? 'bg-slate-50 text-slate-400' : ''}`}>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">{holiday.name}</span>
                  <span className="block text-xs">
                    {longDate(holiday.date)} · {day(holiday.date)}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  {holiday.isReligious && <Badge tone="amber">Religious</Badge>}
                  {there && <Badge>Already added</Badge>}
                </span>
              </li>
            )
          })}
        </ul>}
      </div>
    </Modal>
  )
}

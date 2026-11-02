import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Alert, Button, Modal } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { cx } from '../../lib/format'
import { refreshOperationalData } from '../../lib/refreshOperationalData'
import type { ScheduleVisit } from './types'

const STATE: Record<NonNullable<ScheduleVisit['colorState']>, { label: string; tone: string }> = {
  MANUAL: { label: 'Manual', tone: '' },
  CANCELLED: { label: 'Cancelled', tone: 'bg-slate-200 text-slate-800 ring-slate-300' },
  INVOICE_PENDING: { label: 'Invoice Pending', tone: 'bg-amber-100 text-amber-900 ring-amber-200' },
  FIRST_SERVICE: { label: 'First Service', tone: 'bg-sky-100 text-[#0b3b66] ring-sky-200' },
  NORMAL: { label: 'Normal', tone: 'bg-emerald-100 text-emerald-800 ring-emerald-200' },
}
const MANUAL: Record<string, { label: string; tone: string }> = {
  RED: { label: 'Red', tone: 'bg-red-100 text-red-800 ring-red-200' },
  AMBER: { label: 'Amber', tone: 'bg-amber-100 text-amber-900 ring-amber-200' },
  GREEN: { label: 'Green', tone: 'bg-emerald-100 text-emerald-800 ring-emerald-200' },
  BLUE: { label: 'Blue', tone: 'bg-sky-100 text-[#0b3b66] ring-sky-200' },
  PURPLE: { label: 'Purple', tone: 'bg-violet-100 text-violet-800 ring-violet-200' },
  GREY: { label: 'Grey', tone: 'bg-slate-200 text-slate-800 ring-slate-300' },
}

/** The state that wins under the Color Priority, with a way to set or clear the manual colour. */
export function ServiceColor({ visit, canEdit }: { visit: ScheduleVisit; canEdit: boolean }) {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()
  const state = visit.colorState ?? 'NORMAL'
  const manual = state === 'MANUAL' ? MANUAL[visit.colorOverride ?? ''] : undefined
  const save = useMutation({
    mutationFn: (color: string | null) => api.patch(`/amc/visits/${visit.id}/color`, { color }),
    onSuccess: () => {
      setOpen(false)
      void refreshOperationalData(queryClient)
    },
  })
  const pill = (
    <span className={cx('inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset', manual?.tone ?? STATE[state].tone)}>
      {manual ? `Manual · ${manual.label}` : STATE[state].label}
    </span>
  )

  if (!canEdit || visit.status === 'HISTORICAL') return pill

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label={`Color of visit ${visit.sequenceNo} for ${visit.client.name}: ${manual ? `manual ${manual.label}` : STATE[state].label}. Change`} className="rounded-full focus-visible:outline-2 focus-visible:outline-[#1479BD]">
        {pill}
      </button>
      {open && (
        <Modal title="Service color" onClose={() => setOpen(false)}>
          <div className="space-y-4 text-left">
            {save.isError && <Alert>{errorMessage(save.error)}</Alert>}
            <p className="text-sm text-slate-600">A manual color wins over every other state. It changes the color only.</p>
            <div className="flex flex-wrap gap-2">
              {Object.entries(MANUAL).map(([value, item]) => (
                <button key={value} type="button" disabled={save.isPending} aria-pressed={visit.colorOverride === value} onClick={() => save.mutate(value)} className={cx('rounded-full px-3 py-1 text-sm font-semibold ring-1 ring-inset', item.tone)}>
                  {item.label}
                </button>
              ))}
            </div>
            <Button variant="secondary" disabled={!visit.colorOverride || save.isPending} onClick={() => save.mutate(null)}>
              Clear manual color
            </Button>
          </div>
        </Modal>
      )}
    </>
  )
}

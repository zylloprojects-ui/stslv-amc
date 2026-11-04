import { useMutation } from '@tanstack/react-query'
import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { Button } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { cx } from '../../lib/format'
import { openServiceReport } from './serviceReportFiles'
import { SERVICE_REPORT_ACCEPT, serviceReportFileProblem, type ServiceReport } from './serviceStatusTypes'

export interface ServiceReportCellHandle {
  /** Opens the file chooser (from the "Please upload service report." popup). */
  choose: () => void
  focus: () => void
}

interface ServiceReportCellProps {
  visitId: string
  report: ServiceReport | null
  /** Upload, replace and remove are offered: the user may save, the service is not completed, and the database can hold reports. */
  editable: boolean
  /** True when this service is completed (locked): its report, if any, can only be opened. */
  locked: boolean
  maxMb: number
  /** The row label, for accessible names. */
  label: string
  /** Drawn attention to after Completed was chosen without a report. */
  highlight: boolean
  onChanged: (report: ServiceReport | null) => void
}

/**
 * The SERVICE REPORT cell of one Service Status row: the uploaded document of exactly this service (its visit id),
 * with Upload Report, Replace and Remove before completion, and the file name to open afterwards.
 */
export const ServiceReportCell = forwardRef<ServiceReportCellHandle, ServiceReportCellProps>(function ServiceReportCell(
  { visitId, report, editable, locked, maxMb, label, highlight, onChanged },
  ref,
) {
  const input = useRef<HTMLInputElement>(null)
  const actions = useRef<HTMLSpanElement>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)

  useImperativeHandle(ref, () => ({
    choose: () => input.current?.click(),
    focus: () => actions.current?.querySelector('button')?.focus(),
  }))

  const upload = useMutation({
    mutationFn: (file: File) => api.upload<ServiceReport>(`/amc/service-status/${visitId}/report`, file),
    onSuccess: (saved) => {
      setChosen(null)
      onChanged(saved)
    },
    onError: (error) => {
      setChosen(null)
      setProblem(errorMessage(error))
    },
  })
  const remove = useMutation({
    mutationFn: () => api.delete(`/amc/service-status/${visitId}/report`),
    onSuccess: () => onChanged(null),
    onError: (error) => setProblem(errorMessage(error)),
  })
  const busy = upload.isPending || remove.isPending

  const onFile = (file: File | undefined) => {
    setProblem(null)
    if (!file) return
    const refused = serviceReportFileProblem(file, maxMb)

    if (refused) return setProblem(refused)
    setChosen(file.name)
    upload.mutate(file)
  }

  const open = async () => {
    if (!report) return
    setProblem(null)
    setOpening(true)
    try {
      await openServiceReport(visitId, report)
    } catch (error) {
      setProblem(errorMessage(error))
    } finally {
      setOpening(false)
    }
  }

  return (
    <div className="min-w-44 space-y-1">
      {editable && (
        <input
          ref={input}
          type="file"
          accept={SERVICE_REPORT_ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            onFile(event.target.files?.[0])
            // The same file can be chosen again after an error.
            event.target.value = ''
          }}
        />
      )}

      {report ? (
        <button
          type="button"
          onClick={() => void open()}
          disabled={opening}
          title={`Open ${report.originalName}`}
          aria-label={`Open the service report of ${label}: ${report.originalName}`}
          className="flex max-w-56 items-center gap-1.5 text-left text-sm font-medium text-[#1479BD] hover:underline disabled:opacity-60"
        >
          <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="M6 2.75h5.5L15.25 6.5v10.75H6a1.25 1.25 0 0 1-1.25-1.25V4A1.25 1.25 0 0 1 6 2.75Z" strokeLinejoin="round" />
            <path d="M11.25 2.75V6.75h4" strokeLinejoin="round" />
          </svg>
          <span className="truncate">{report.originalName}</span>
        </button>
      ) : chosen ? (
        <div className="max-w-56 truncate text-sm text-slate-700" title={chosen}>
          Uploading {chosen}…
        </div>
      ) : (
        !editable && (
          <span className="text-slate-400" title={locked ? 'Completed before service reports were required.' : undefined}>
            —
          </span>
        )
      )}

      {editable && (
        <span ref={actions} className="flex flex-wrap gap-1.5">
          <Button
            variant={report ? 'ghost' : 'secondary'}
            size="sm"
            loading={upload.isPending}
            disabled={busy}
            aria-label={`${report ? 'Replace' : 'Upload'} the service report of ${label}`}
            onClick={() => input.current?.click()}
            className={cx(highlight && !report && 'ring-2 ring-amber-500 ring-offset-1')}
          >
            {report ? 'Replace' : 'Upload Report'}
          </Button>
          {report && (
            <Button variant="ghost" size="sm" loading={remove.isPending} disabled={busy} aria-label={`Remove the service report of ${label}`} onClick={() => remove.mutate()}>
              Remove
            </Button>
          )}
        </span>
      )}

      {problem && (
        <div role="alert" className="max-w-56 whitespace-normal text-xs text-red-700">
          {problem}
        </div>
      )}
    </div>
  )
})

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Alert, Button, Modal, Spinner } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { formatDate } from './amcFormat'
import { DetailRow, OrDash } from './components'
import { downloadServiceReport, openServiceReport } from './serviceReportFiles'
import { MONTH_NAMES, SERVICE_STATUS_LABELS, serviceLabel, type ServiceStatusItem } from './serviceStatusTypes'

const sizeText = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)

/**
 * The read-only View of one service, loaded by its visit id (GET /amc/service-status/:id), so it always shows the
 * latest saved record. Nothing here changes the service: a locked status stays locked.
 */
export function ServiceDetailsDialog({ visitId, onClose }: { visitId: string; onClose: () => void }) {
  const service = useQuery({
    queryKey: ['amc', 'service-status', 'item', visitId],
    queryFn: () => api.get<ServiceStatusItem>(`/amc/service-status/${visitId}`),
    staleTime: 0,
  })
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const item = service.data
  const report = item?.serviceReport ?? null

  const run = async (action: () => Promise<void>) => {
    setProblem(null)
    setBusy(true)
    try {
      await action()
    } catch (error) {
      setProblem(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={item ? `Service · ${item.reference}` : 'Service'}
      onClose={onClose}
      size="lg"
      footer={
        <>
          {item && report && (
            <>
              <Button variant="secondary" disabled={busy} onClick={() => void run(() => openServiceReport(item.id, report))}>
                View Report
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => void run(() => downloadServiceReport(item.id, report))}>
                Download Report
              </Button>
            </>
          )}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {service.isPending && <Spinner label="Loading service" />}
      {service.isError && <Alert>{errorMessage(service.error)}</Alert>}
      {item && (
        <div className="space-y-4">
          {problem && <Alert>{problem}</Alert>}
          <dl>
            <DetailRow label="AMC Reference">{item.reference}</DetailRow>
            <DetailRow label="Client">{item.client.name}</DetailRow>
            <DetailRow label="System">
              {item.system.typeName && item.system.typeName !== item.system.description ? `${item.system.typeName} (${item.system.description})` : (item.system.typeName ?? item.system.description)}
            </DetailRow>
            <DetailRow label="Frequency">{item.frequency.label}</DetailRow>
            <DetailRow label="Service">{serviceLabel(item.service)}</DetailRow>
            <DetailRow label="Scheduled month">
              {MONTH_NAMES[Number(item.scheduledDate.slice(5, 7)) - 1]} {item.scheduledDate.slice(0, 4)}
            </DetailRow>
            <DetailRow label="Due date">{formatDate(item.scheduledDate)}</DetailRow>
            <DetailRow label="Service Status">
              <span className="inline-flex items-center gap-1.5">
                {SERVICE_STATUS_LABELS[item.serviceStatus]}
                {item.locked && <span className="text-xs font-medium text-slate-500">· locked</span>}
              </span>
            </DetailRow>
            <DetailRow label="Completion date">{item.completedDate ? formatDate(item.completedDate) : <OrDash value={null} />}</DetailRow>
            <DetailRow label="Sales Engineer">
              <OrDash value={item.salesEngineer?.name ?? null} />
            </DetailRow>
            <DetailRow label="Service Report No.">
              <OrDash value={item.reportNumber} />
            </DetailRow>
            <DetailRow label="Service Report">
              {report ? (
                <span className="[overflow-wrap:anywhere]">
                  {report.originalName}
                  <span className="text-slate-500">
                    {' '}
                    · {sizeText(report.sizeBytes)} · uploaded {formatDate(report.uploadedAt.slice(0, 10))} by {report.uploadedBy.fullName}
                  </span>
                </span>
              ) : (
                <span className="text-slate-500">{item.locked ? 'None (completed before service reports were required)' : 'Not uploaded yet'}</span>
              )}
            </DetailRow>
          </dl>
        </div>
      )}
    </Modal>
  )
}

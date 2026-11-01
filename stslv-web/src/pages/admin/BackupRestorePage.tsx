import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useAuth } from '../../auth/context'
import { TABLE } from '../../components/table'
import { Alert, Button, Card, EmptyState, PageHeader, Spinner } from '../../components/ui'
import { api, download, errorMessage, saveFile } from '../../lib/api'
import { cx, formatDateTime } from '../../lib/format'

interface BackupRecord {
  id: string
  state: 'RUNNING' | 'VERIFIED' | 'FAILED'
  startedAt: string
  finishedAt: string | null
  startedBy: string
  sizeBytes: number | null
  sha256: string | null
  tableEntries: number | null
  failure: string | null
}

interface BackupList {
  status: { available: boolean; unavailableReason: string | null; automaticSchedule: boolean; storageConfigured: boolean; storageDeclaredDurable: boolean; toolVersion: string | null; checks: { id: string; label: string; state: 'OK' | 'ATTENTION' | 'NOT_CHECKED'; detail: string }[] }
  items: BackupRecord[]
}

const STATE = {
  RUNNING: { label: 'Running', tone: 'bg-sky-100 text-[#0b3b66] ring-sky-200' },
  VERIFIED: { label: 'Verified', tone: 'bg-emerald-100 text-emerald-800 ring-emerald-200' },
  FAILED: { label: 'Failed', tone: 'bg-red-100 text-red-800 ring-red-200' },
}

const size = (bytes: number | null) => (bytes === null ? '—' : bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`)

/** Backup status, manual backups and recovery guidance. Nothing here can restore a database. */
export function BackupRestorePage() {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const [failure, setFailure] = useState<string | null>(null)
  const superAdmin = auth.user?.roles.some((role) => role.code === 'ADMIN') ?? false

  const backups = useQuery({
    queryKey: ['security', 'backups'],
    queryFn: () => api.get<BackupList>('/security/backups'),
    refetchInterval: (query) => (query.state.data?.items.some((item) => item.state === 'RUNNING') ? 3000 : false),
  })
  const start = useMutation({
    mutationFn: () => api.post('/security/backups', {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['security', 'backups'] }),
    onError: (error) => setFailure(errorMessage(error)),
  })
  const fetchFile = async (record: BackupRecord) => {
    setFailure(null)
    try {
      saveFile(await download(`/security/backups/${record.id}/download`), `${record.id}.dump`)
    } catch (error) {
      setFailure(errorMessage(error))
    }
  }
  const data = backups.data
  const busy = data?.items.some((item) => item.state === 'RUNNING') ?? false

  return (
    <>
      <PageHeader
        title="Backup & Restore"
        description="Database backups made by this application, and how to recover from one."
        actions={
          superAdmin && data?.status.available ? (
            <Button
              loading={start.isPending}
              disabled={busy}
              onClick={() => {
                setFailure(null)
                start.mutate()
              }}
            >
              {busy ? 'Backup running…' : 'Back up now'}
            </Button>
          ) : undefined
        }
      />

      {failure && (
        <div className="mb-4">
          <Alert onDismiss={() => setFailure(null)}>{failure}</Alert>
        </div>
      )}
      {backups.isPending && <Spinner label="Loading backups" />}
      {backups.isError && <Alert>{errorMessage(backups.error)}</Alert>}

      {data && (
        <div className="space-y-5">
          {!data.status.available && <Alert tone="info">Manual backups are not available here. {data.status.unavailableReason}</Alert>}

          <Card>
            <h2 className="border-b border-slate-200 px-5 py-3 text-base font-semibold text-slate-900">Configuration</h2>
            <ul className="divide-y divide-slate-100 border-b border-slate-200" aria-label="Readiness checks">
              {data.status.checks.map((check) => (
                <li key={check.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-2.5 text-sm">
                  <span className={cx('inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset', check.state === 'OK' ? 'bg-emerald-100 text-emerald-800 ring-emerald-200' : check.state === 'ATTENTION' ? 'bg-amber-100 text-amber-900 ring-amber-200' : 'bg-slate-200 text-slate-800 ring-slate-300')}>
                    {check.state === 'OK' ? 'OK' : check.state === 'ATTENTION' ? 'Attention' : 'Not checked'}
                  </span>
                  <span className="font-medium text-slate-900">{check.label}</span>
                  <span className="min-w-0 break-words text-slate-600">{check.detail}</span>
                </li>
              ))}
            </ul>
            <dl className="grid divide-y divide-slate-100 text-sm sm:grid-cols-2 sm:divide-y-0">
              {[
                ['Manual backups', data.status.available ? 'Available' : 'Not available'],
                ['Automatic backups', 'Off. No schedule runs from this application.'],
                ['Storage', data.status.storageConfigured ? 'Configured' : 'Not configured'],
                ['Declared durable storage', data.status.storageDeclaredDurable ? 'Yes' : 'No'],
                ['Backup tool', data.status.toolVersion ? `pg_dump ${data.status.toolVersion}` : 'Not checked or not found'],
                ['Who can run and download', 'Super Admin only'],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-4 px-5 py-2.5">
                  <dt className="text-slate-600">{label}</dt>
                  <dd className="text-right font-medium text-slate-900">{value}</dd>
                </div>
              ))}
            </dl>
          </Card>

          <Card>
            <h2 className="border-b border-slate-200 px-5 py-3 text-base font-semibold text-slate-900">Backup history</h2>
            {data.items.length === 0 ? (
              <EmptyState title="No backups recorded here" description="This list shows backups made from this page only. Backups made outside the application are not listed." />
            ) : (
              <div className={TABLE.wrapper}>
                <table className={TABLE.table}>
                  <caption className="sr-only">Backup history</caption>
                  <thead>
                    <tr>
                      {['Started', 'By', 'Status', 'Size', 'Tables', 'Checksum (SHA-256)', ''].map((heading) => (
                        <th key={heading} scope="col" className={TABLE.th}>
                          {heading || <span className="sr-only">Download</span>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.items.map((record) => (
                      <tr key={record.id} className={TABLE.row}>
                        <td className={cx(TABLE.td, 'whitespace-nowrap')}>{formatDateTime(record.startedAt)}</td>
                        <td className={TABLE.td}>{record.startedBy}</td>
                        <td className={TABLE.td}>
                          <span className={cx('inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset', STATE[record.state].tone)}>{STATE[record.state].label}</span>
                          {record.failure && <div className="mt-1 text-xs text-red-700">{record.failure}</div>}
                        </td>
                        <td className={cx(TABLE.td, 'whitespace-nowrap tabular-nums')}>{size(record.sizeBytes)}</td>
                        <td className={cx(TABLE.td, 'tabular-nums')}>{record.tableEntries ?? '—'}</td>
                        <td className={cx(TABLE.td, 'font-mono text-xs')} title={record.sha256 ?? undefined}>
                          {record.sha256 ? `${record.sha256.slice(0, 16)}…` : '—'}
                        </td>
                        <td className={cx(TABLE.td, 'text-right')}>
                          {superAdmin && record.state === 'VERIFIED' && (
                            <Button variant="secondary" size="sm" aria-label={`Download backup from ${formatDateTime(record.startedAt)}`} onClick={() => void fetchFile(record)}>
                              Download
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card>
            <h2 className="border-b border-slate-200 px-5 py-3 text-base font-semibold text-slate-900">Restore and recovery</h2>
            <div className="space-y-3 px-5 py-4 text-sm text-slate-700">
              <p>A restore replaces data, so it cannot be started from this application. It is a supervised procedure carried out by the system administrator:</p>
              <ol className="list-decimal space-y-1.5 pl-5">
                <li>Download the verified backup and compare its SHA-256 checksum with the one shown above.</li>
                <li>Restore it into a new, empty PostgreSQL database of the same major version, never over the live one: <code className="rounded bg-slate-100 px-1 py-0.5 text-xs text-slate-800">pg_restore --no-owner --dbname=&lt;new database&gt; &lt;file&gt;</code></li>
                <li>Compare record counts and totals with the source, then sign in to the restored copy and check the key pages.</li>
                <li>Take a fresh backup of the live database before any change to it.</li>
                <li>Only with written approval, switch the application to the restored database, or restore into production during a planned stop.</li>
              </ol>
              <p>A backup holds every record, including password hashes. Keep downloaded files in restricted storage and delete copies that are no longer needed.</p>
            </div>
          </Card>
        </div>
      )}
    </>
  )
}

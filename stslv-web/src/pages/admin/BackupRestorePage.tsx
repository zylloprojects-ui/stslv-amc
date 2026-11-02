import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { useAuth } from '../../auth/context'
import { TABLE } from '../../components/table'
import { Alert, Button, Card, EmptyState, PageHeader, Spinner } from '../../components/ui'
import { api, download, errorMessage, saveFile } from '../../lib/api'
import { cx, formatDateTime } from '../../lib/format'
import { IconTile, type IconName } from '../dashboard/icons'

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

function SectionHead({ icon, from, to, children }: { icon: IconName; from: string; to: string; children: ReactNode }) {
  return (
    <h2 className="flex items-center gap-3 border-b border-slate-200 bg-gradient-to-r from-sky-50 via-white to-white px-5 py-3 text-base font-bold text-[#0b3b66]">
      <IconTile icon={icon} from={from} to={to} className="h-8 w-8 rounded-lg" />
      {children}
    </h2>
  )
}

function Stat({ label, value, note, icon, from, to }: { label: string; value: string; note?: string; icon: IconName; from: string; to: string }) {
  return (
    <div className="relative flex min-w-0 items-center gap-3 overflow-hidden rounded-xl border border-slate-200 bg-white px-3.5 py-3 shadow-sm transition-shadow hover:shadow-md">
      <span className="absolute inset-y-0 left-0 w-1" style={{ backgroundImage: `linear-gradient(180deg, ${from}, ${to})` }} aria-hidden="true" />
      <IconTile icon={icon} from={from} to={to} className="ml-1 h-9 w-9 shrink-0 rounded-lg" />
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-bold uppercase leading-snug tracking-[0.12em] text-slate-500">{label}</p>
        <p className="break-words text-sm font-bold leading-snug text-[#0b3b66]">{value}</p>
        {note && <p className="text-[11px] leading-snug text-slate-500">{note}</p>}
      </div>
    </div>
  )
}

const CHECK_LOOK = {
  OK: { card: 'border-emerald-200 bg-emerald-50', dot: 'bg-emerald-500', icon: 'm4.5 10.5 3.5 3.5 7.5-8' },
  ATTENTION: { card: 'border-amber-300 bg-amber-50', dot: 'bg-amber-500', icon: 'M10 5v6M10 14.5v.5' },
  NOT_CHECKED: { card: 'border-slate-200 bg-slate-50', dot: 'bg-slate-400', icon: 'M6 10h8' },
}

const size = (bytes: number | null) => (bytes === null ? '—' : bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`)

/** Backup status, manual backups and recovery guidance. Nothing here can restore a database. */
export function BackupRestorePage() {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const [failure, setFailure] = useState<string | null>(null)
  const [downloaded, setDownloaded] = useState(false)
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
    setDownloaded(false)
    try {
      saveFile(await download(`/security/backups/${record.id}/download`), `${record.id}.dump`)
      setDownloaded(true)
    } catch (error) {
      setFailure(errorMessage(error))
    }
  }
  const data = backups.data
  const busy = data?.items.some((item) => item.state === 'RUNNING') ?? false
  const lastVerified = data?.items.find((item) => item.state === 'VERIFIED') ?? null

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
      {downloaded && (
        <div className="mb-4">
          <Alert tone="success" onDismiss={() => setDownloaded(false)}>
            Download check passed: the server matched the file to its recorded SHA-256 checksum before sending it.
          </Alert>
        </div>
      )}
      {backups.isPending && <Spinner label="Loading backups" />}
      {backups.isError && <Alert>{errorMessage(backups.error)}</Alert>}

      {data && (
        <div className="space-y-6">
          {!data.status.available && <Alert tone="info">Manual backups are not available here. {data.status.unavailableReason}</Alert>}

          <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Manual backups" value={data.status.available ? 'Available' : 'Not available'} icon="shield" from={data.status.available ? '#059669' : '#64748B'} to={data.status.available ? '#34D399' : '#94A3B8'} />
            <Stat label="Backup storage" value={data.status.storageConfigured ? 'Configured' : 'Not configured'} icon="project" from={data.status.storageConfigured ? '#1479BD' : '#EA580C'} to={data.status.storageConfigured ? '#4aa3df' : '#FBBF24'} />
            <Stat label="Last verified backup" value={lastVerified ? formatDateTime(lastVerified.startedAt) : 'None yet'} icon="calendar" from="#7C3AED" to="#A78BFA" />
            <Stat label="Backups listed" value={String(data.items.length)} note="Made from this page only" icon="chart" from="#0891B2" to="#22D3EE" />
          </dl>

          <Card className="rounded-2xl border-l-4 border-l-amber-500">
            <SectionHead icon="execution" from="#EA580C" to="#FBBF24">Not provided by this application</SectionHead>
            <div className="px-5 py-4 text-sm text-slate-700">
              <p>These are not provided, and await approval:</p>
              <ul className="mt-3 grid gap-3 md:grid-cols-3">
                {[
                  ['Automatic backups', 'no backup runs on a schedule.'],
                  ['Retention', 'no backup is removed or expired automatically, and no retention period applies.'],
                  ['Restore from this screen', 'no page or button restores a database.'],
                ].map(([title, text]) => (
                  <li key={title} className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3">
                    <p className="flex items-center gap-2 font-bold text-amber-900">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-500 text-xs text-white" aria-hidden="true">×</span>
                      {title}:
                    </p>
                    <p className="mt-1 text-xs leading-snug text-amber-900">{text}</p>
                  </li>
                ))}
              </ul>
            </div>
          </Card>

          <Card className="rounded-2xl">
            <SectionHead icon="settings" from="#64748B" to="#94A3B8">Configuration</SectionHead>
            <ul className="grid gap-3 p-4 md:grid-cols-2" aria-label="Readiness checks">
              {data.status.checks.map((check) => {
                const look = CHECK_LOOK[check.state]

                return (
                  <li key={check.id} className={cx('flex min-w-0 items-start gap-3 rounded-xl border px-3 py-2.5', look.card)}>
                    <span className={cx('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white', look.dot)} aria-hidden="true">
                      <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.6">
                        <path d={look.icon} strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-bold text-slate-900">{check.label}</p>
                        <span className={cx('inline-flex shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset', check.state === 'OK' ? 'bg-emerald-100 text-emerald-800 ring-emerald-200' : check.state === 'ATTENTION' ? 'bg-amber-100 text-amber-900 ring-amber-200' : 'bg-slate-200 text-slate-800 ring-slate-300')}>
                          {check.state === 'OK' ? 'OK' : check.state === 'ATTENTION' ? 'Attention' : 'Not checked'}
                        </span>
                      </div>
                      <p className="mt-0.5 break-words text-xs leading-snug text-slate-600">{check.detail}</p>
                    </div>
                  </li>
                )
              })}
            </ul>
            <dl className="grid gap-3 border-t border-slate-200 p-4 sm:grid-cols-2 xl:grid-cols-3">
              {[
                ['Manual backups', data.status.available ? 'Available' : 'Not available'],
                ['Automatic backups', 'Not provided. Awaiting approval.'],
                ['Storage', data.status.storageConfigured ? 'Configured' : 'Not configured'],
                ['Declared durable storage', data.status.storageDeclaredDurable ? 'Yes' : 'No'],
                ['Backup tool', data.status.toolVersion ? `pg_dump ${data.status.toolVersion}` : 'Not checked or not found'],
                ['Who can run and download', 'Super Admin only'],
              ].map(([label, value]) => (
                <div key={label} className="min-w-0 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 shadow-sm" style={{ boxShadow: 'inset 3px 0 0 #1479BD' }}>
                  <dt className="text-xs text-slate-500">{label}</dt>
                  <dd className="mt-0.5 text-sm font-bold text-[#0b3b66]">{value}</dd>
                </div>
              ))}
            </dl>
          </Card>

          <Card className="rounded-2xl">
            <SectionHead icon="invoice" from="#1479BD" to="#4aa3df">Backup history</SectionHead>
            {data.items.length === 0 ? (
              <EmptyState title="No backups recorded here" description="This list shows backups made from this page only. Backups made outside the application are not listed." />
            ) : (
              <>
              <p className="flex gap-2 border-b border-slate-200 bg-sky-50/60 px-5 py-3 text-sm text-slate-700">
                <span className="mt-px font-bold text-[#1479BD]" aria-hidden="true">i</span>
                <span>
                  <span className="font-semibold text-slate-900">Download check:</span> before every download the server recalculates the file's SHA-256 checksum and compares it with the one recorded when the backup was verified. A changed or missing file is refused.
                </span>
              </p>
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
                        <td className={cx(TABLE.td, 'whitespace-nowrap')} style={{ boxShadow: `inset 4px 0 0 ${record.state === 'VERIFIED' ? '#10b981' : record.state === 'FAILED' ? '#ef4444' : '#0ea5e9'}` }}>{formatDateTime(record.startedAt)}</td>
                        <td className={TABLE.td}>{record.startedBy}</td>
                        <td className={TABLE.td}>
                          <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset', STATE[record.state].tone)}>
                            <span className={cx('h-1.5 w-1.5 rounded-full', record.state === 'VERIFIED' ? 'bg-emerald-500' : record.state === 'FAILED' ? 'bg-red-500' : 'animate-pulse bg-sky-500')} aria-hidden="true" />
                            {STATE[record.state].label}
                          </span>
                          {record.failure && <div className="mt-1 text-xs text-red-700">{record.failure}</div>}
                        </td>
                        <td className={cx(TABLE.td, 'whitespace-nowrap tabular-nums')}>{size(record.sizeBytes)}</td>
                        <td className={cx(TABLE.td, 'tabular-nums')}>{record.tableEntries ?? '—'}</td>
                        <td className={cx(TABLE.td, TABLE.unbroken, 'font-mono text-xs')}>{record.sha256 ?? '—'}</td>
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
              </>
            )}
          </Card>

          <Card className="rounded-2xl">
            <SectionHead icon="shield" from="#7C3AED" to="#A78BFA">Restore and recovery</SectionHead>
            <div className="space-y-4 px-5 py-4 text-sm text-slate-700">
              <p>A restore replaces data, so it cannot be started from this application. It is a supervised procedure carried out by the system administrator:</p>
              <ol className="space-y-3">
                {[
                  <>Download the verified backup and compare its SHA-256 checksum with the one shown above.</>,
                  <>Restore it into a new, empty PostgreSQL database of the same major version, never over the live one: <code className="rounded bg-slate-100 px-1 py-0.5 text-xs text-slate-800">pg_restore --no-owner --dbname=&lt;new database&gt; &lt;file&gt;</code></>,
                  <>Compare record counts and totals with the source, then sign in to the restored copy and check the key pages.</>,
                  <>Take a fresh backup of the live database before any change to it.</>,
                  <>Only with written approval, switch the application to the restored database, or restore into production during a planned stop.</>,
                ].map((step, index) => (
                  <li key={index} className="flex gap-3 rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-3">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#0b3b66] to-[#1479BD] text-xs font-bold text-white shadow-sm" aria-hidden="true">
                      {index + 1}
                    </span>
                    <span className="min-w-0 flex-1 leading-snug">{step}</span>
                  </li>
                ))}
              </ol>
              <p className="rounded-xl border border-l-4 border-amber-200 border-l-amber-500 bg-amber-50 px-3.5 py-2.5 text-amber-900">A backup holds every record, including password hashes. Keep downloaded files in restricted storage and delete copies that are no longer needed.</p>
            </div>
          </Card>
        </div>
      )}
    </>
  )
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { api, ApiError, download, errorMessage, saveFile } from '../lib/api'
import { formatDateTime } from '../lib/format'
import { ActionButton, ActionGroup } from './IconActions'
import { LoadError } from './records'
import { TABLE } from './table'
import { Alert, Button, EmptyState, Modal, SelectField, Spinner, TextAreaField, TextField } from './ui'

// Documents attached to a record (contract documents, quotations, receipts).
// Files are only ever fetched through the API with the user's session; there
// are no public links. Documents are replaced by new versions, never deleted.

export type AttachmentEntity = 'amc_contracts' | 'procurement_requests' | 'project_expenses'

export interface Attachment {
  id: string
  documentId: string
  version: number
  isCurrent: boolean
  category: string
  title: string
  originalName: string
  mimeType: string
  sizeBytes: number
  sha256: string
  notes: string | null
  uploadedBy: { id: string; fullName: string }
  uploadedAt: string
  versionCount?: number
  integrity?: IntegrityState
}

/** The stored file checked against its recorded SHA-256 when the list was read. */
export type IntegrityState = 'VERIFIED' | 'FAILED' | 'MISSING' | 'UNAVAILABLE'

/** GET /attachments/versions: every version on the record, and the upload rules the page states. */
interface RecordVersions {
  items: Attachment[]
  limits: { maxMb: number; allowedTypes: string[] }
}

/** The current documents of a record, so other panels can show the same figure from the same request. */
export function attachmentsQuery(entityType: AttachmentEntity, entityId: string) {
  return {
    queryKey: ['attachments', entityType, entityId],
    queryFn: () => api.get<Attachment[]>(`/attachments?entityType=${entityType}&entityId=${entityId}`),
    retry: false,
  }
}

const INTEGRITY: Record<IntegrityState, { label: string; tone: string }> = {
  VERIFIED: { label: 'Verified', tone: 'bg-emerald-100 text-emerald-800 ring-emerald-200' },
  FAILED: { label: 'Failed', tone: 'bg-red-100 text-red-800 ring-red-200' },
  MISSING: { label: 'File missing', tone: 'bg-amber-100 text-amber-900 ring-amber-200' },
  UNAVAILABLE: { label: 'Not checked', tone: 'bg-slate-200 text-slate-800 ring-slate-300' },
}

function Integrity({ attachment }: { attachment: Attachment }) {
  const state = attachment.integrity ? INTEGRITY[attachment.integrity] : INTEGRITY.UNAVAILABLE

  return (
    <>
      <span className="block font-mono text-xs text-slate-700" title={`SHA-256: ${attachment.sha256}`}>
        <span className="sr-only">SHA-256 starting </span>
        {attachment.sha256.slice(0, 12)}…
      </span>
      <span className={`mt-0.5 inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${state.tone}`}>{state.label}</span>
    </>
  )
}

// PROVISIONAL: the document types are a starting point until the business confirms its document requirements.
const CATEGORY_LABELS: Record<string, string> = {
  SIGNED_CONTRACT: 'Signed contract',
  LPO: 'LPO',
  PURCHASE_ORDER: 'Purchase order',
  CLIENT_APPROVAL: 'Client approval',
  SERVICE_REPORT: 'Service report',
  QUOTATION: 'Quotation',
  DELIVERY_NOTE: 'Delivery note',
  RECEIPT: 'Receipt',
  BILL: 'Bill',
  OTHER: 'Other',
}

const CATEGORIES: Record<AttachmentEntity, string[]> = {
  amc_contracts: ['SIGNED_CONTRACT', 'LPO', 'PURCHASE_ORDER', 'CLIENT_APPROVAL', 'SERVICE_REPORT', 'OTHER'],
  procurement_requests: ['QUOTATION', 'PURCHASE_ORDER', 'DELIVERY_NOTE', 'OTHER'],
  project_expenses: ['RECEIPT', 'BILL', 'OTHER'],
}

const ACCEPT = '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg'
// AMC contracts may also hold Word documents (the contract document, migration 0103). The API checks the content.
const WORD_ACCEPT = '.doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const acceptFor = (entityType: AttachmentEntity) => (entityType === 'amc_contracts' ? `${ACCEPT},${WORD_ACCEPT}` : ACCEPT)

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** The message for a feature that this server or database cannot offer yet. */
function unavailableMessage(error: unknown): string | null {
  if (error instanceof ApiError && (error.code === 'FEATURE_UNAVAILABLE' || error.code === 'STORAGE_UNAVAILABLE')) {
    return error.code === 'FEATURE_UNAVAILABLE'
      ? 'Attachments need a database update that has not been applied to this database yet (migration 0071).'
      : error.message
  }

  return null
}

function fieldError(error: unknown): string | null {
  return error instanceof ApiError ? (error.details.find((detail) => detail.field === 'file')?.message ?? error.message) : error ? errorMessage(error) : null
}

async function fetchAndSave(attachment: Attachment) {
  saveFile(await download(`/attachments/${attachment.id}/download`), attachment.originalName)
}

export function AttachmentsPanel({ entityType, entityId, canUpload, label = 'Documents' }: { entityType: AttachmentEntity; entityId: string; canUpload: boolean; label?: string }) {
  const [dialog, setDialog] = useState<{ kind: 'none' } | { kind: 'upload' } | { kind: 'replace'; attachment: Attachment } | { kind: 'versions'; attachment: Attachment }>({ kind: 'none' })
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const query = useQuery(attachmentsQuery(entityType, entityId))
  const versions = useQuery({
    queryKey: ['attachments', entityType, entityId, 'versions'],
    queryFn: () => api.get<RecordVersions>(`/attachments/versions?entityType=${entityType}&entityId=${entityId}`),
    retry: false,
    enabled: query.isSuccess,
  })
  const limits = versions.data?.limits
  const rules = limits ? `Allowed types: ${limits.allowedTypes.join(', ')}. Size limit: ${limits.maxMb} MB per file.` : entityType === 'amc_contracts' ? 'PDF, PNG, JPEG or Word (.doc, .docx).' : 'PDF, PNG or JPEG.'
  const versionTotal = (query.data ?? []).reduce((sum, attachment) => sum + (attachment.versionCount ?? 1), 0)
  const latestUpload = (query.data ?? []).reduce<string | null>((latest, attachment) => (latest === null || attachment.uploadedAt > latest ? attachment.uploadedAt : latest), null)
  const unavailable = unavailableMessage(query.error)
  const open = async (attachment: Attachment) => {
    setDownloadError(null)
    try {
      await fetchAndSave(attachment)
    } catch (error) {
      setDownloadError(errorMessage(error))
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 px-6 py-3">
        <p className="text-sm text-slate-600">{rules} A replacement keeps the earlier versions.</p>
        {canUpload && !unavailable && query.isSuccess && (
          <Button size="sm" onClick={() => setDialog({ kind: 'upload' })}>
            Attach document
          </Button>
        )}
      </div>
      {unavailable && (
        <div className="px-6 pb-4">
          <Alert tone="info">{unavailable}</Alert>
        </div>
      )}
      {downloadError && (
        <div className="px-6 pb-3">
          <Alert onDismiss={() => setDownloadError(null)}>{downloadError}</Alert>
        </div>
      )}
      {query.data && (
        <dl aria-label={`${label} figures`} className="grid grid-cols-1 gap-3 px-6 pb-4 sm:grid-cols-3">
          {[
            { term: 'Current documents', value: String(query.data.length) },
            { term: 'Versions', value: String(versionTotal) },
            { term: 'Latest upload', value: latestUpload ? formatDateTime(latestUpload) : '—' },
          ].map((figure) => (
            <div key={figure.term} className="min-w-0 rounded-xl border border-slate-200 px-4 py-3">
              <dt className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">{figure.term}</dt>
              <dd className="mt-1 break-words text-lg font-bold tabular-nums text-[#0b3b66]">{figure.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {query.isPending && <Spinner size="sm" label="Loading documents" />}
      {query.isError && !unavailable && <LoadError error={query.error} onRetry={() => void query.refetch()} />}
      {query.data && query.data.length === 0 && <EmptyState title={`No ${label.toLowerCase()} attached yet`} />}
      {query.data && query.data.length > 0 && (
        <div className={TABLE.wrapper}>
          <table className={TABLE.table}>
            <caption className="sr-only">{label}</caption>
            <thead>
              <tr>
                <th scope="col" className={TABLE.th}>
                  Type and title
                </th>
                <th scope="col" className={TABLE.th}>
                  File
                </th>
                <th scope="col" className={TABLE.th}>
                  Version
                </th>
                <th scope="col" className={TABLE.th}>
                  Uploaded
                </th>
                <th scope="col" className={TABLE.th}>
                  Integrity
                </th>
                <th scope="col" className={`${TABLE.th} text-right`}>
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {query.data.map((attachment) => (
                <tr key={attachment.id}>
                  <td className={TABLE.td}>
                    <span className="block text-xs font-semibold uppercase tracking-wide text-slate-500">{CATEGORY_LABELS[attachment.category] ?? attachment.category}</span>
                    <span className="block font-medium text-slate-900">{attachment.title}</span>
                    {attachment.notes && <span className="block text-xs text-slate-500">{attachment.notes}</span>}
                  </td>
                  <td className={TABLE.td}>
                    <span className="block break-all">{attachment.originalName}</span>
                    <span className="block text-xs text-slate-500">{formatSize(attachment.sizeBytes)}</span>
                  </td>
                  <td className={`${TABLE.td} whitespace-nowrap`}>
                    {attachment.version}
                    {(attachment.versionCount ?? 1) > 1 && <span className="text-xs text-slate-500"> of {attachment.versionCount}</span>}
                  </td>
                  <td className={TABLE.td}>
                    <span className="block whitespace-nowrap">{formatDateTime(attachment.uploadedAt)}</span>
                    <span className="block text-xs text-slate-500">{attachment.uploadedBy.fullName}</span>
                  </td>
                  <td className={TABLE.td}>
                    <Integrity attachment={attachment} />
                  </td>
                  <td className={`${TABLE.td} whitespace-nowrap text-right`}>
                    <ActionGroup>
                      <ActionButton label={`Download ${attachment.title}`} icon="download" onClick={() => void open(attachment)} />
                      {(attachment.versionCount ?? 1) > 1 && <ActionButton label={`Versions of ${attachment.title}`} icon="versions" onClick={() => setDialog({ kind: 'versions', attachment })} />}
                      {canUpload && <ActionButton label={`Replace ${attachment.title}`} icon="replace" onClick={() => setDialog({ kind: 'replace', attachment })} />}
                    </ActionGroup>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {versions.data && versions.data.items.length > 0 && (
        <section aria-labelledby={`${entityType}-version-history`} className="border-t border-slate-200">
          <h3 id={`${entityType}-version-history`} className="px-6 pb-1 pt-4 text-sm font-semibold text-slate-900">
            Version History
          </h3>
          <div className={TABLE.wrapper}>
            <table className={TABLE.table}>
              <caption className="sr-only">Every version of the {label.toLowerCase()}, newest first</caption>
              <thead>
                <tr>
                  {['Title', 'Version', 'File', 'Uploaded By', 'Uploaded At', 'Integrity'].map((heading) => (
                    <th key={heading} scope="col" className={TABLE.th}>
                      {heading}
                    </th>
                  ))}
                  <th scope="col" className={`${TABLE.th} text-right`}>
                    Access
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {versions.data.items.map((version) => (
                  <tr key={version.id}>
                    <td className={TABLE.td}>{version.title}</td>
                    <td className={`${TABLE.td} whitespace-nowrap`}>
                      {version.version}
                      {version.isCurrent && <span className="ml-2 text-xs font-semibold text-emerald-700">Current</span>}
                    </td>
                    <td className={TABLE.td}>
                      <span className="block break-all">{version.originalName}</span>
                      <span className="block text-xs text-slate-500">{formatSize(version.sizeBytes)}</span>
                    </td>
                    <td className={TABLE.td}>{version.uploadedBy.fullName}</td>
                    <td className={`${TABLE.td} whitespace-nowrap`}>{formatDateTime(version.uploadedAt)}</td>
                    <td className={TABLE.td}>
                      <Integrity attachment={version} />
                    </td>
                    <td className={`${TABLE.td} whitespace-nowrap text-right`}>
                      <ActionGroup>
                        <ActionButton label={`Download version ${version.version} of ${version.title}`} icon="download" onClick={() => void open(version)} />
                      </ActionGroup>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {dialog.kind === 'upload' && <UploadModal entityType={entityType} entityId={entityId} rules={rules} onClose={() => setDialog({ kind: 'none' })} />}
      {dialog.kind === 'replace' && <UploadModal entityType={entityType} entityId={entityId} rules={rules} replacing={dialog.attachment} onClose={() => setDialog({ kind: 'none' })} />}
      {dialog.kind === 'versions' && <VersionsModal attachment={dialog.attachment} onOpen={open} onClose={() => setDialog({ kind: 'none' })} />}
    </div>
  )
}

function UploadModal({ entityType, entityId, replacing, rules, onClose }: { entityType: AttachmentEntity; entityId: string; replacing?: Attachment; rules: string; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [category, setCategory] = useState(CATEGORIES[entityType][0] ?? 'OTHER')
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [missing, setMissing] = useState<Record<string, string>>({})

  const save = useMutation({
    mutationFn: () => {
      const params = new URLSearchParams(replacing ? { ...(notes.trim() ? { notes } : {}) } : { entityType, entityId, category, title, ...(notes.trim() ? { notes } : {}) })
      const path = replacing ? `/attachments/${replacing.id}/versions` : '/attachments'

      return api.upload<Attachment>(`${path}?${params.toString()}`, file as File)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['attachments', entityType, entityId] })
      onClose()
    },
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const errors: Record<string, string> = {}
    if (!file) errors.file = 'Choose a file to upload.'
    if (!replacing && !title.trim()) errors.title = 'Title is required.'
    setMissing(errors)
    if (Object.keys(errors).length === 0) save.mutate()
  }

  const formId = 'attachment-upload-form'
  const fileMessage = missing.file ?? (save.isError ? fieldError(save.error) : null)

  return (
    <Modal
      title={replacing ? `Replace "${replacing.title}"` : 'Attach document'}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={save.isPending}>
            {replacing ? 'Upload new version' : 'Upload'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-4">
        {replacing ? (
          <p className="text-sm text-slate-600">
            The new file becomes version {replacing.version + 1}. Version {replacing.version} and earlier stay available.
          </p>
        ) : (
          <>
            <SelectField label="Document type" required value={category} onChange={(event) => setCategory(event.target.value)}>
              {CATEGORIES[entityType].map((value) => (
                <option key={value} value={value}>
                  {CATEGORY_LABELS[value]}
                </option>
              ))}
            </SelectField>
            <TextField label="Title" required value={title} onChange={(event) => setTitle(event.target.value)} error={missing.title} maxLength={200} />
          </>
        )}
        <div>
          <label htmlFor="attachment-file" className="mb-1 block text-sm font-medium text-slate-700">
            File <span className="text-red-600">*</span>
          </label>
          <input
            id="attachment-file"
            type="file"
            accept={acceptFor(entityType)}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            aria-invalid={fileMessage ? true : undefined}
            aria-describedby={fileMessage ? 'attachment-file-error' : undefined}
            className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-sky-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-[#1479BD]"
          />
          <p className="mt-1 text-xs text-slate-500">{rules}</p>
          {fileMessage && (
            <p id="attachment-file-error" role="alert" className="mt-1 text-xs font-medium text-red-700">
              {fileMessage}
            </p>
          )}
        </div>
        <TextAreaField label="Notes" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1000} rows={2} />
      </form>
    </Modal>
  )
}

function VersionsModal({ attachment, onOpen, onClose }: { attachment: Attachment; onOpen: (attachment: Attachment) => Promise<void>; onClose: () => void }) {
  const versions = useQuery({ queryKey: ['attachments', 'versions', attachment.documentId], queryFn: () => api.get<Attachment[]>(`/attachments/${attachment.id}/versions`) })

  return (
    <Modal title={`Versions of "${attachment.title}"`} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      {versions.isPending && <Spinner size="sm" label="Loading versions" />}
      {versions.isError && <Alert>{errorMessage(versions.error)}</Alert>}
      {versions.data && (
        <ol className="divide-y divide-slate-100" aria-label="Versions, newest first">
          {versions.data.map((version) => (
            <li key={version.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0 text-sm">
                <p className="font-medium text-slate-900">
                  Version {version.version}
                  {version.isCurrent && <span className="ml-2 text-xs font-semibold text-emerald-700">Current</span>}
                </p>
                <p className="break-all text-xs text-slate-500">
                  {version.originalName} · {formatSize(version.sizeBytes)} · {formatDateTime(version.uploadedAt)} · {version.uploadedBy.fullName}
                </p>
                {version.notes && <p className="text-xs text-slate-600">{version.notes}</p>}
              </div>
              <Button size="sm" variant="secondary" onClick={() => void onOpen(version)} aria-label={`Download version ${version.version}`}>
                Download
              </Button>
            </li>
          ))}
        </ol>
      )}
    </Modal>
  )
}

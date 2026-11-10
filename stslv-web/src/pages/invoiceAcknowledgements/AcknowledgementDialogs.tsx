import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Modal, Spinner } from '../../components/ui'
import { api, download, errorMessage, saveFile } from '../../lib/api'
import { formatBusinessDateTime } from '../../lib/businessDate'
import {
  ACKNOWLEDGEMENT_NOTE,
  DOCUMENT_ACCEPT,
  documentFileProblem,
  formatSize,
  subjectOf,
  type AcknowledgementDocument,
  type AcknowledgementItem,
  type DocumentVersion,
} from './invoiceAcknowledgementTypes'

const BASE = '/invoice-acknowledgements'

function DocumentLine({ document }: { document: AcknowledgementDocument }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
      <svg viewBox="0 0 20 20" className="mt-0.5 h-5 w-5 shrink-0 text-[#1479BD]" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <path d="M6 2.75h5.5L15.25 6.5v10.75H6a1.25 1.25 0 0 1-1.25-1.25V4A1.25 1.25 0 0 1 6 2.75Z" strokeLinejoin="round" />
        <path d="M11.25 2.75V6.75h4" strokeLinejoin="round" />
      </svg>
      <div className="min-w-0 text-sm">
        <div className="break-all font-semibold text-slate-900" data-testid="selected-document">
          {document.originalName}
        </div>
        <div className="text-xs text-slate-500">
          {formatSize(document.sizeBytes)} · version {document.version} · uploaded by {document.uploadedBy.fullName}, {formatBusinessDateTime(document.uploadedAt)} (Oman time)
        </div>
      </div>
    </div>
  )
}

interface AttachDialogProps {
  item: AcknowledgementItem
  maxMb: number
  onSaved: (item: AcknowledgementItem) => void
  onConfirmed: (item: AcknowledgementItem) => void
  onClose: () => void
}

/**
 * Attach Acknowledgement, then OK / Confirm. Choosing a file stores it at once in private storage (the status stays
 * Pending) and shows its name; OK / Confirm asks the server to mark the invoice Acknowledged. Only the server's answer
 * turns the status green: on any error the invoice stays Pending and the message is shown here.
 */
export function AttachAcknowledgementDialog({ item, maxMb, onSaved, onConfirmed, onClose }: AttachDialogProps) {
  const input = useRef<HTMLInputElement>(null)
  const [current, setCurrent] = useState<AcknowledgementItem>(item)
  const [problem, setProblem] = useState<string | null>(null)
  const [choosing, setChoosing] = useState<string | null>(null)

  const upload = useMutation({
    mutationFn: (file: File) => api.upload<AcknowledgementItem>(`${BASE}/${item.visitId}/document`, file),
    onSuccess: (saved) => {
      setChoosing(null)
      setCurrent(saved)
      onSaved(saved)
    },
    onError: (error) => {
      setChoosing(null)
      setProblem(errorMessage(error))
    },
  })
  const remove = useMutation({
    mutationFn: () => api.delete<AcknowledgementItem>(`${BASE}/${item.visitId}/document`),
    onSuccess: (saved) => {
      setCurrent(saved)
      onSaved(saved)
    },
    onError: (error) => setProblem(errorMessage(error)),
  })
  const confirm = useMutation({
    mutationFn: (attachmentId: string) => api.post<AcknowledgementItem>(`${BASE}/${item.visitId}/confirm`, { attachmentId }),
    onSuccess: (saved) => onConfirmed(saved),
    onError: (error) => setProblem(errorMessage(error)),
  })
  const busy = upload.isPending || remove.isPending || confirm.isPending

  const onFile = (file: File | undefined) => {
    setProblem(null)
    if (!file) return
    const refused = documentFileProblem(file, maxMb)

    if (refused) return setProblem(refused)
    setChoosing(file.name)
    upload.mutate(file)
  }

  const document = current.document

  return (
    <Modal
      title={`Attach Acknowledgement · ${subjectOf(item)}`}
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => document && confirm.mutate(document.attachmentId)}
            disabled={!document || upload.isPending || remove.isPending}
            loading={confirm.isPending}
            aria-label={`OK, confirm the acknowledgement of ${subjectOf(item)}`}
          >
            OK / Confirm
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-slate-500">Client</dt>
          <dd className="font-medium text-slate-900">{item.client.name}</dd>
          <dt className="text-slate-500">AMC Contract</dt>
          <dd className="font-mono font-semibold text-[#0b3b66]">{item.reference}</dd>
          <dt className="text-slate-500">Invoice No.</dt>
          <dd className="font-mono font-semibold text-slate-900">{item.invoiceNo}</dd>
        </dl>

        <input
          ref={input}
          type="file"
          accept={DOCUMENT_ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          data-testid="acknowledgement-file"
          onChange={(event) => {
            onFile(event.target.files?.[0])
            // The same file can be chosen again after an error.
            event.target.value = ''
          }}
        />

        {document ? (
          <div className="space-y-2">
            <p className="text-sm font-medium text-slate-700">Selected document</p>
            <DocumentLine document={document} />
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => input.current?.click()} disabled={busy} loading={upload.isPending}>
                Choose a different file
              </Button>
              <Button variant="ghost" size="sm" onClick={() => remove.mutate()} disabled={busy} loading={remove.isPending}>
                Remove
              </Button>
            </div>
            <Alert tone="info">The document is saved but the invoice is still Pending. Select OK / Confirm to mark it Acknowledged.</Alert>
          </div>
        ) : choosing ? (
          <div role="status" className="flex items-center gap-2 text-sm text-slate-700">
            <Spinner size="sm" label="Uploading" /> Uploading {choosing}…
          </div>
        ) : (
          <div className="rounded-lg border-2 border-dashed border-slate-300 px-4 py-6 text-center">
            <Button onClick={() => input.current?.click()} disabled={busy}>
              Choose document
            </Button>
            <p className="mt-2 text-xs text-slate-500">PDF, PNG or JPEG, at most {maxMb} MB. Stored privately; only users allowed to view this page can open it.</p>
          </div>
        )}

        {problem && <Alert>{problem}</Alert>}
        <p className="text-xs text-slate-500">{ACKNOWLEDGEMENT_NOTE}</p>
      </div>
    </Modal>
  )
}

interface ReplaceDialogProps {
  item: AcknowledgementItem
  maxMb: number
  onReplaced: (item: AcknowledgementItem) => void
  onClose: () => void
}

/** Replace Document of an Acknowledged invoice (Edit permission): a new version with a reason. The earlier version is kept. */
export function ReplaceDocumentDialog({ item, maxMb, onReplaced, onClose }: ReplaceDialogProps) {
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [reason, setReason] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const replace = useMutation({
    mutationFn: () => api.upload<AcknowledgementItem>(`${BASE}/${item.visitId}/replace`, file as File, { 'X-Replace-Reason': encodeURIComponent(reason.trim()) }),
    onSuccess: onReplaced,
    onError: (error) => setProblem(errorMessage(error)),
  })
  const reasonOk = reason.trim().length >= 3

  return (
    <Modal
      title={`Replace Document · ${subjectOf(item)}`}
      onClose={replace.isPending ? () => undefined : onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={replace.isPending}>
            Cancel
          </Button>
          <Button onClick={() => replace.mutate()} disabled={!file || !reasonOk} loading={replace.isPending}>
            Replace Document
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          The invoice stays Acknowledged with its original date and user. The current document is kept as an earlier version, and the replacement and its reason are recorded in the Audit Log.
        </p>
        {item.document && <DocumentLine document={item.document} />}
        <input
          ref={input}
          type="file"
          accept={DOCUMENT_ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          data-testid="replacement-file"
          onChange={(event) => {
            setProblem(null)
            const chosen = event.target.files?.[0]
            event.target.value = ''
            if (!chosen) return
            const refused = documentFileProblem(chosen, maxMb)
            if (refused) {
              setFile(null)
              return setProblem(refused)
            }
            setFile(chosen)
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => input.current?.click()} disabled={replace.isPending}>
            Choose replacement
          </Button>
          <span className="break-all text-sm text-slate-700">{file ? `${file.name} (${formatSize(file.size)})` : 'No file chosen'}</span>
        </div>
        <div>
          <label htmlFor="replace-reason" className="block text-sm font-medium text-slate-700">
            Reason for replacing <span className="text-red-600">*</span>
          </label>
          <textarea
            id="replace-reason"
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm"
            aria-describedby="replace-reason-hint"
          />
          <p id="replace-reason-hint" className="mt-1 text-xs text-slate-500">
            At least 3 characters. Kept with the change.
          </p>
        </div>
        {problem && <Alert>{problem}</Alert>}
      </div>
    </Modal>
  )
}

const isBrowserViewable = (mimeType: string) => mimeType === 'application/pdf' || mimeType === 'image/png' || mimeType === 'image/jpeg'

/**
 * The read-only document viewer. The file is fetched through the API with the signed-in user's token (the API checks
 * View) and shown from a blob: address that exists only in this tab; Download is inside the viewer. No storage path
 * or public link reaches the browser. The document history (versions) is listed under it.
 */
export function AcknowledgementViewer({ item, onClose }: { item: AcknowledgementItem; onClose: () => void }) {
  const document = item.document as AcknowledgementDocument
  const subject = subjectOf(item)
  const file = useQuery({
    queryKey: ['invoice-acknowledgements', 'document', item.visitId, document.attachmentId],
    queryFn: () => download(`${BASE}/${item.visitId}/document`),
    gcTime: 0,
    staleTime: 0,
    retry: false,
  })
  const history = useQuery({
    queryKey: ['invoice-acknowledgements', 'history', item.visitId, document.attachmentId],
    queryFn: () => api.get<DocumentVersion[]>(`${BASE}/${item.visitId}/history`),
  })
  const [saveError, setSaveError] = useState<string | null>(null)
  const viewable = isBrowserViewable(document.mimeType)
  const url = useMemo(() => (file.data && viewable ? URL.createObjectURL(new Blob([file.data.blob], { type: document.mimeType })) : null), [file.data, viewable, document.mimeType])

  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url)
    },
    [url],
  )

  const save = () => {
    setSaveError(null)
    if (!file.data) return
    try {
      saveFile({ blob: file.data.blob, filename: document.originalName }, document.originalName)
    } catch (error) {
      setSaveError(errorMessage(error))
    }
  }

  return (
    <Modal
      title={`Acknowledgement · ${subject}`}
      size="xl"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button onClick={save} disabled={!file.data} aria-label={`Download the acknowledgement document of ${subject}`}>
            Download
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <DocumentLine document={document} />
        {item.status === 'PENDING' && <Alert tone="info">This document is attached but not confirmed yet. The invoice is still Pending.</Alert>}
        {file.isPending && <Spinner label="Loading the document" />}
        {file.isError && <Alert>The document could not be opened. {errorMessage(file.error)}</Alert>}
        {saveError && <Alert>{saveError}</Alert>}
        {file.data && url && document.mimeType === 'application/pdf' && (
          <iframe title={`Acknowledgement document of ${subject}`} src={url} className="h-[60vh] w-full rounded-lg border border-slate-200 bg-slate-50" />
        )}
        {file.data && url && document.mimeType !== 'application/pdf' && (
          <img src={url} alt={`Acknowledgement document of ${subject}`} className="mx-auto max-h-[60vh] rounded-lg border border-slate-200" />
        )}
        {history.data && history.data.length > 1 && (
          <section aria-label="Document history">
            <h3 className="text-sm font-semibold text-slate-700">Document history</h3>
            <ul className="mt-1 divide-y divide-slate-100 text-xs text-slate-600">
              {history.data.map((version) => (
                <li key={version.attachmentId} className="flex flex-wrap justify-between gap-2 py-1.5">
                  <span className="break-all">
                    Invoice {version.invoiceNumber} · v{version.version} · {version.originalName}
                    {version.isCurrent && <span className="ml-1 font-semibold text-emerald-700">(current)</span>}
                  </span>
                  <span>
                    {version.uploadedBy.fullName}, {formatBusinessDateTime(version.uploadedAt)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Modal>
  )
}

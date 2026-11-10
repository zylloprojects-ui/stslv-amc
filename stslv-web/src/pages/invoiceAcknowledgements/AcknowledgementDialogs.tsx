import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { TABLE } from '../../components/table'
import { Alert, Button, Modal, Spinner } from '../../components/ui'
import { api, download, errorMessage, saveFile } from '../../lib/api'
import { formatBusinessDateTime } from '../../lib/businessDate'
import { formatDate } from '../../lib/format'
import { formatMoney } from '../../lib/money'
import {
  ACKNOWLEDGEMENT_NOTE,
  BASIS_LABELS,
  DOCUMENT_ACCEPT,
  documentFileProblem,
  formatSize,
  RECONCILIATION_LABELS,
  serviceLabel,
  STATUS_LABELS,
  subjectOf,
  type AcknowledgementDocument,
  type AcknowledgementItem,
  type DocumentVersion,
  type LinkedService,
  type ReconciliationView,
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

function InvoiceSummary({ item }: { item: AcknowledgementItem }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      <dt className="text-slate-500">Invoice No.</dt>
      <dd className="font-mono font-semibold text-slate-900">{item.invoiceNo}</dd>
      <dt className="text-slate-500">Client</dt>
      <dd className="font-medium text-slate-900">{item.client.name}</dd>
      <dt className="text-slate-500">AMC Contract</dt>
      <dd className="font-mono font-semibold text-[#0b3b66]">{item.contracts.map((contract) => contract.reference).join(', ')}</dd>
      <dt className="text-slate-500">Services</dt>
      <dd className="text-slate-900">
        {item.serviceCount} {item.serviceCount === 1 ? 'service' : 'services'} on this invoice: one acknowledgement covers them all
      </dd>
    </dl>
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
    mutationFn: (file: File) => api.upload<AcknowledgementItem>(`${BASE}/${item.invoiceId}/document`, file),
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
    mutationFn: () => api.delete<AcknowledgementItem>(`${BASE}/${item.invoiceId}/document`),
    onSuccess: (saved) => {
      setCurrent(saved)
      onSaved(saved)
    },
    onError: (error) => setProblem(errorMessage(error)),
  })
  const confirm = useMutation({
    mutationFn: (attachmentId: string) => api.post<AcknowledgementItem>(`${BASE}/${item.invoiceId}/confirm`, { attachmentId }),
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
        <InvoiceSummary item={item} />

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
    mutationFn: () => api.upload<AcknowledgementItem>(`${BASE}/${item.invoiceId}/replace`, file as File, { 'X-Replace-Reason': encodeURIComponent(reason.trim()) }),
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
        <ReasonField id="replace-reason" label="Reason for replacing" value={reason} onChange={setReason} />
        {problem && <Alert>{problem}</Alert>}
      </div>
    </Modal>
  )
}

function ReasonField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        {label} <span className="text-red-600">*</span>
      </label>
      <textarea
        id={id}
        rows={3}
        maxLength={500}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm"
        aria-describedby={`${id}-hint`}
      />
      <p id={`${id}-hint`} className="mt-1 text-xs text-slate-500">
        At least 3 characters. Kept in the Audit Log.
      </p>
    </div>
  )
}

const isBrowserViewable = (mimeType: string) => mimeType === 'application/pdf' || mimeType === 'image/png' || mimeType === 'image/jpeg'

/**
 * The read-only document viewer. The file is fetched through the API with the signed-in user's token (the API checks
 * View) and shown from a blob: address that exists only in this tab; Download is inside the viewer. No storage path
 * or public link reaches the browser. The document history lists every version, each downloadable, of this invoice only.
 */
export function AcknowledgementViewer({ item, onClose }: { item: AcknowledgementItem; onClose: () => void }) {
  const document = item.document as AcknowledgementDocument
  const subject = subjectOf(item)
  const file = useQuery({
    queryKey: ['invoice-acknowledgements', 'document', item.invoiceId, document.attachmentId],
    queryFn: () => download(`${BASE}/${item.invoiceId}/document`),
    gcTime: 0,
    staleTime: 0,
    retry: false,
  })
  const history = useQuery({
    queryKey: ['invoice-acknowledgements', 'history', item.invoiceId, document.attachmentId],
    queryFn: () => api.get<DocumentVersion[]>(`${BASE}/${item.invoiceId}/history`),
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
  const saveVersion = async (version: DocumentVersion) => {
    setSaveError(null)
    try {
      saveFile(await download(`${BASE}/${item.invoiceId}/documents/${version.attachmentId}`), version.originalName)
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
                <li key={version.attachmentId} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                  <span className="break-all">
                    v{version.version} · {version.originalName} · {STATUS_LABELS[version.acknowledgementStatus]}
                    {version.isCurrent && version.ofCurrentAcknowledgement && <span className="ml-1 font-semibold text-emerald-700">(current)</span>}
                    {!version.ofCurrentAcknowledgement && <span className="ml-1 text-slate-500">(earlier acknowledgement)</span>}
                  </span>
                  <span className="flex items-center gap-2">
                    {version.uploadedBy.fullName}, {formatBusinessDateTime(version.uploadedAt)}
                    <button type="button" className="font-medium text-[#1479BD] hover:underline" onClick={() => void saveVersion(version)} aria-label={`Download version ${version.version}: ${version.originalName}`}>
                      Download
                    </button>
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

/** Linked Services: the services one invoice covers (read only). Values only for users who may view Accounts. */
export function LinkedServicesDialog({ item, canViewContract, onClose }: { item: AcknowledgementItem; canViewContract: boolean; onClose: () => void }) {
  const services = useQuery({ queryKey: ['invoice-acknowledgements', 'services', item.invoiceId], queryFn: () => api.get<LinkedService[]>(`${BASE}/${item.invoiceId}/services`) })

  return (
    <Modal
      title={`Linked Services · ${subjectOf(item)}`}
      size="lg"
      onClose={onClose}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <p className="mb-3 text-sm text-slate-600">
        {item.basis === 'ZOHO' ? 'Identified by its Invoice Tracking record.' : 'Identified by the Invoice No. entered on Accounts.'} One acknowledgement covers every service listed.
      </p>
      {services.isPending && <Spinner label="Loading linked services" />}
      {services.isError && <Alert>{errorMessage(services.error)}</Alert>}
      {services.data && (
        <div className={TABLE.wrapper}>
          <table className={TABLE.table}>
            <caption className="sr-only">Linked services</caption>
            <thead>
              <tr>
                <th scope="col" className={TABLE.th}>AMC Contract</th>
                <th scope="col" className={TABLE.th}>Service</th>
                <th scope="col" className={TABLE.th}>Completed</th>
                <th scope="col" className={TABLE.th}>Service Report No.</th>
                {item.amountsVisible && <th scope="col" className={`${TABLE.th} text-right`}>Value (Ex VAT, OMR)</th>}
                <th scope="col" className={TABLE.th}>Linked by</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {services.data.map((service) => (
                <tr key={service.visitId} data-visit={service.visitId}>
                  <td className={`${TABLE.td} whitespace-nowrap font-mono text-sm font-semibold text-[#0b3b66]`}>
                    {canViewContract ? <Link to={`/amc/contracts/${service.contract.id}`} className="hover:underline">{service.contract.reference}</Link> : service.contract.reference}
                  </td>
                  <td className={`${TABLE.td} whitespace-nowrap`}>{serviceLabel(service.service)}</td>
                  <td className={`${TABLE.td} whitespace-nowrap`}>{formatDate(service.completedDate)}</td>
                  <td className={`${TABLE.td} whitespace-nowrap font-mono`}>{service.serviceReportNo ?? '—'}</td>
                  {item.amountsVisible && <td className={`${TABLE.td} whitespace-nowrap text-right tabular-nums`}>{service.serviceValue ? formatMoney(service.serviceValue) : '—'}</td>}
                  <td className={`${TABLE.td} text-xs text-slate-600`}>{BASIS_LABELS[service.basis]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}

/**
 * Reconcile (Edit permission): what the system will not decide on its own. Equal Invoice Nos. of one client: link them
 * as ONE invoice, or confirm they are separate. Conflicting acknowledgements: choose the current one. Every choice
 * needs a reason and goes to the Audit Log; nothing is deleted.
 */
export function ReconcileDialog({ item, onDone, onClose }: { item: AcknowledgementItem; onDone: (message: string) => void; onClose: () => void }) {
  const view = useQuery({ queryKey: ['invoice-acknowledgements', 'reconciliation', item.invoiceId], queryFn: () => api.get<ReconciliationView>(`${BASE}/${item.invoiceId}/reconciliation`) })
  const [reason, setReason] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body: Record<string, string>; message: string }) => api.post<AcknowledgementItem>(`${BASE}/${item.invoiceId}/${path}`, { ...body, reason: reason.trim() }),
    onSuccess: (_saved, variables) => onDone(variables.message),
    onError: (error) => setProblem(errorMessage(error)),
  })
  const reasonOk = reason.trim().length >= 3

  return (
    <Modal
      title={`Reconcile · ${subjectOf(item)}`}
      size="lg"
      onClose={act.isPending ? () => undefined : onClose}
      footer={
        <Button variant="secondary" onClick={onClose} disabled={act.isPending}>
          Cancel
        </Button>
      }
    >
      <div className="space-y-4">
        <InvoiceSummary item={item} />
        <ul className="list-disc space-y-1 pl-5 text-sm text-amber-800">
          {item.reconciliation.map((reasonCode) => (
            <li key={reasonCode}>{RECONCILIATION_LABELS[reasonCode]}</li>
          ))}
        </ul>
        <ReasonField id="reconcile-reason" label="Reason" value={reason} onChange={setReason} />
        {view.isPending && <Spinner label="Loading" />}
        {view.isError && <Alert>{errorMessage(view.error)}</Alert>}

        {view.data && view.data.sameNumber.length > 0 && (
          <section aria-label="Invoices with the same number" className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-800">Invoices of this client with the same Invoice No.</h3>
            <ul className="space-y-2">
              {view.data.sameNumber.map((other) => (
                <li key={other.invoiceId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
                  <span>
                    {other.contracts.join(', ')} · {other.serviceCount} {other.serviceCount === 1 ? 'service' : 'services'} · {STATUS_LABELS[other.status]}
                    {other.hasDocument && ' · document attached'} · {other.basis === 'ZOHO' ? 'Invoice Tracking record' : 'Invoice No. only'}
                  </span>
                  <Button
                    size="sm"
                    disabled={!reasonOk || act.isPending}
                    onClick={() => act.mutate({ path: 'link', body: { otherInvoiceId: other.invoiceId }, message: `Invoice ${item.invoiceNo}: the services were linked as one invoice.` })}
                  >
                    Link as one invoice
                  </Button>
                </li>
              ))}
            </ul>
            <Button variant="secondary" disabled={!reasonOk || act.isPending} onClick={() => act.mutate({ path: 'separate', body: {}, message: `Invoices numbered ${item.invoiceNo} were confirmed as separate invoices.` })}>
              They are separate invoices
            </Button>
          </section>
        )}

        {view.data && item.reconciliation.includes('ZOHO_CANCELLED') && (
          <section aria-label="Cancelled Invoice Tracking record" className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-800">Cancelled Invoice Tracking record</h3>
            <p className="text-sm text-slate-600">
              The invoice and its acknowledgement are kept. If the invoice was re-entered in Invoice Tracking, re-associate it with the new record: only a record of this client and number that covers every linked service can be used.
            </p>
            {view.data.replacements.length === 0 ? (
              <Alert tone="info">No active Invoice Tracking record with this number exists yet. Nothing is changed.</Alert>
            ) : (
              <ul className="space-y-2">
                {view.data.replacements.map((record) => (
                  <li key={record.zohoInvoiceId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
                    <span>
                      Record {record.invoiceNumber} · {formatDate(record.invoiceDate)}
                      {record.problem && <span className="block text-xs text-amber-800">{record.problem}</span>}
                    </span>
                    {record.verified && (
                      <Button
                        size="sm"
                        disabled={!reasonOk || act.isPending}
                        onClick={() => act.mutate({ path: 'reassociate', body: { zohoInvoiceId: record.zohoInvoiceId }, message: `Invoice ${item.invoiceNo} now refers to its re-entered Invoice Tracking record. Its acknowledgement is unchanged.` })}
                      >
                        Re-associate
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {view.data && view.data.acknowledgements.length > 0 && (
          <section aria-label="Conflicting acknowledgements" className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-800">Acknowledgements of this invoice — choose the current one</h3>
            <ul className="space-y-2">
              {view.data.acknowledgements.map((ack) => (
                <li key={ack.acknowledgementId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
                  <span>
                    {ack.documentName ?? 'No document'} · {STATUS_LABELS[ack.status]}
                    {ack.acknowledgedAt && ` ${formatBusinessDateTime(ack.acknowledgedAt)} by ${ack.acknowledgedBy ?? '—'}`}
                    {ack.legacyVisitId && ' · recorded per service by the earlier release'}
                  </span>
                  <Button
                    size="sm"
                    disabled={!reasonOk || act.isPending}
                    onClick={() => act.mutate({ path: 'choose', body: { acknowledgementId: ack.acknowledgementId }, message: `Invoice ${item.invoiceNo}: the current acknowledgement was chosen. The others are kept as history.` })}
                  >
                    Make current
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {problem && <Alert>{problem}</Alert>}
      </div>
    </Modal>
  )
}

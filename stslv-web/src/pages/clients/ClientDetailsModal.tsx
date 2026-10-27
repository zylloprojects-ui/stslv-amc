import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Alert, Button, Modal, Spinner } from '../../components/ui'
import { ClientStatusBadge } from './ClientStatusBadge'
import { api, errorMessage } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { Link } from 'react-router-dom'
import { CLIENT_TYPE_LABELS, type Client } from '../../lib/types'
import { avatarColors, initialsOf } from './clientAvatarHelpers'

const ICONS = {
  person: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4.5 20c0-3.6 3.4-5.5 7.5-5.5s7.5 1.9 7.5 5.5" strokeLinecap="round" />
    </>
  ),
  phone: <path d="M6.5 4h3l1.5 4-2 1.2a11 11 0 0 0 5.8 5.8L16 13l4 1.5v3a2 2 0 0 1-2.2 2A15.5 15.5 0 0 1 4.5 6.2 2 2 0 0 1 6.5 4Z" strokeLinejoin="round" />,
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="m4 7 8 6 8-6" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s6.5-5.6 6.5-11a6.5 6.5 0 1 0-13 0C5.5 15.4 12 21 12 21Z" strokeLinejoin="round" />
      <circle cx="12" cy="10" r="2.3" />
    </>
  ),
  note: (
    <>
      <path d="M6 3.5h9l3.5 3.5V20a.5.5 0 0 1-.5.5H6a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5Z" strokeLinejoin="round" />
      <path d="M9 11h6M9 14.5h6M9 7.5h3" strokeLinecap="round" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" strokeLinecap="round" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
}

function Icon({ name, className = 'h-5 w-5' }: { name: keyof typeof ICONS; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      {ICONS[name]}
    </svg>
  )
}

const NOT_PROVIDED = <span className="font-normal italic text-slate-500">Not provided</span>
const LINK = 'text-[#1479BD] underline-offset-2 hover:underline'

/** One detail as a compact card: a small icon, the label, and the value. A missing value is shown quietly, so what is known stands out. */
function Field({ icon, label, empty = false, children }: { icon: keyof typeof ICONS; label: string; empty?: boolean; children: ReactNode }) {
  return (
    <div className={`flex items-center gap-2.5 rounded-xl border px-3 py-2 ${empty ? 'border-dashed border-slate-300 bg-slate-50/60' : 'border-slate-300 bg-white'}`}>
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${empty ? 'bg-slate-100 text-slate-400' : 'bg-sky-100 text-[#1479BD]'}`} aria-hidden="true">
        <Icon name={icon} className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <dt className="text-[11px] font-bold uppercase tracking-wider text-slate-600">{label}</dt>
        <dd className="whitespace-pre-wrap break-words text-sm font-semibold text-slate-900">{children}</dd>
      </div>
    </div>
  )
}

interface ClientDetailsModalProps {
  clientId: string
  canEdit: boolean
  onEdit: (client: Client) => void
  onClose: () => void
}

export function ClientDetailsModal({ clientId, canEdit, onEdit, onClose }: ClientDetailsModalProps) {
  // Always read the record again, so the details shown are the stored values.
  const query = useQuery({ queryKey: ['clients', 'detail', clientId], queryFn: () => api.get<Client>(`/clients/${clientId}`) })
  const client = query.data
  const [from, to] = avatarColors()

  return (
    <Modal
      title="Client details"
      onClose={onClose}
      footer={
        <>
          {client && (
            <Link to={`/clients/${client.id}`} className="mr-auto rounded-md px-3 py-2 text-sm font-medium text-blue-700 hover:bg-sky-50 hover:underline">
              Open client page
            </Link>
          )}
          {canEdit && client && (
            <Button variant="secondary" onClick={() => onEdit(client)}>
              Edit
            </Button>
          )}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {query.isPending && <Spinner size="sm" label="Loading client" />}
      {query.isError && <Alert>{errorMessage(query.error)}</Alert>}
      {client && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-300 bg-gradient-to-r from-sky-50 to-white p-3.5">
            <span
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-base font-bold tracking-wide text-white shadow-sm"
              style={{ backgroundImage: `linear-gradient(135deg, ${from}, ${to})` }}
              aria-hidden="true"
            >
              {initialsOf(client.name)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-[#1479BD]">{client.code}</p>
              <p className="break-words text-lg font-bold leading-tight text-[#0b3b66]">{client.name}</p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <ClientStatusBadge active={client.isActive} />
                <span className="text-xs text-slate-600">Client since {formatDateTime(client.createdAt).split(',')[0]}</span>
              </div>
            </div>
            {(client.phone || client.email) && (
              <div className="flex flex-wrap gap-2">
                {client.phone && (
                  <a
                    href={`tel:${client.phone.replace(/[^+\d]/g, '')}`}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-b from-[#1a7fc4] to-[#0f62a3] px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:from-[#1673b3] hover:to-[#0c5590]"
                  >
                    <Icon name="phone" className="h-4 w-4" />
                    Call
                  </a>
                )}
                {client.email && (
                  <a
                    href={`mailto:${client.email}`}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-[#0b3b66] hover:bg-sky-50"
                  >
                    <Icon name="mail" className="h-4 w-4 text-[#1479BD]" />
                    Send email
                  </a>
                )}
              </div>
            )}
          </div>

          {!client.contactPerson && !client.phone && !client.email && !client.address && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed border-sky-300 bg-sky-50/60 px-3.5 py-2.5">
              <p className="text-sm text-slate-700">
                <span className="font-bold text-[#0b3b66]">No contact details yet.</span> Add a contact person, phone or email.
              </p>
              {canEdit && (
                <Button size="sm" onClick={() => onEdit(client)}>
                  Add contact details
                </Button>
              )}
            </div>
          )}

          {(client.contactPerson || client.phone || client.email || client.address) && (
            <dl className="grid gap-2.5 sm:grid-cols-2">
              <Field icon="person" label="Contact person" empty={!client.contactPerson}>
                {client.contactPerson ?? NOT_PROVIDED}
              </Field>
              <Field icon="phone" label="Phone" empty={!client.phone}>
                {client.phone ? (
                  <a href={`tel:${client.phone.replace(/[^+\d]/g, '')}`} className={LINK}>
                    {client.phone}
                  </a>
                ) : (
                  NOT_PROVIDED
                )}
              </Field>
              <Field icon="mail" label="Email" empty={!client.email}>
                {client.email ? (
                  <a href={`mailto:${client.email}`} className={LINK}>
                    {client.email}
                  </a>
                ) : (
                  NOT_PROVIDED
                )}
              </Field>
              <Field icon="pin" label="Address" empty={!client.address}>
                {client.address ?? NOT_PROVIDED}
              </Field>
              {(client.clientType || client.vatNumber) && (
                <Field icon="note" label="Type and VAT">
                  {[client.clientType ? CLIENT_TYPE_LABELS[client.clientType] : null, client.vatNumber ? `VAT ${client.vatNumber}` : null].filter(Boolean).join(' · ')}
                </Field>
              )}
            </dl>
          )}

          <div className={`rounded-xl border px-3.5 py-2.5 ${client.notes ? 'border-amber-300 bg-amber-50/60' : 'border-dashed border-slate-300 bg-slate-50/60'}`}>
            <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-600">
              <Icon name="note" className={`h-3.5 w-3.5 ${client.notes ? 'text-amber-600' : 'text-slate-400'}`} />
              Remarks
            </p>
            <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-slate-900">{client.notes ?? NOT_PROVIDED}</p>
          </div>

          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-xs text-slate-500">
            <span className="flex items-center gap-1.5">
              <Icon name="calendar" className="h-3.5 w-3.5" />
              Created <span className="font-semibold text-slate-700">{formatDateTime(client.createdAt)}</span>
            </span>
            <span className="flex items-center gap-1.5">
              <Icon name="clock" className="h-3.5 w-3.5" />
              Updated <span className="font-semibold text-slate-700">{formatDateTime(client.updatedAt)}</span>
            </span>
          </p>
        </div>
      )}
    </Modal>
  )
}

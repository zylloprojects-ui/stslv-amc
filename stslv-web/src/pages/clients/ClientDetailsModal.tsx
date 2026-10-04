import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Alert, Button, Modal, Spinner, StatusBadge } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import type { Client } from '../../lib/types'
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

/** One detail as a card: an icon tile, the label, and the value. A missing value is shown quietly, so what is known stands out. */
function Field({ icon, label, empty = false, children }: { icon: keyof typeof ICONS; label: string; empty?: boolean; children: ReactNode }) {
  return (
    <div
      className={`flex items-start gap-3 rounded-2xl border p-4 transition-colors ${
        empty ? 'border-dashed border-slate-200 bg-slate-50/60' : 'border-slate-200 bg-white shadow-sm hover:border-sky-300'
      }`}
    >
      <span
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${empty ? 'bg-slate-100 text-slate-400' : 'bg-sky-100 text-[#1479BD]'}`}
        aria-hidden="true"
      >
        <Icon name={icon} className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</dt>
        <dd className="mt-0.5 whitespace-pre-wrap break-words text-[15px] font-semibold text-slate-900">{children}</dd>
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
      size="lg"
      footer={
        <>
          {client && (
            <p className="mr-auto hidden flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 sm:flex">
              <span className="flex items-center gap-1.5">
                <Icon name="calendar" className="h-4 w-4" />
                Created <span className="font-medium text-slate-700">{formatDateTime(client.createdAt)}</span>
              </span>
              <span className="flex items-center gap-1.5">
                <Icon name="clock" className="h-4 w-4" />
                Updated <span className="font-medium text-slate-700">{formatDateTime(client.updatedAt)}</span>
              </span>
            </p>
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
        <div className="space-y-5">
          <div className="relative overflow-hidden rounded-2xl border border-sky-100 bg-white shadow-sm">
            <span className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-[#4aa3df] via-[#1479BD] to-[#4aa3df]" aria-hidden="true" />
            <div className="flex flex-wrap items-center gap-4 p-5 sm:gap-5">
              <span
                className="flex h-[4.5rem] w-[4.5rem] shrink-0 items-center justify-center rounded-2xl text-2xl font-bold tracking-wide text-white shadow-lg shadow-sky-900/20 ring-4 ring-sky-100"
                style={{ backgroundImage: `linear-gradient(135deg, ${from}, ${to})` }}
                aria-hidden="true"
              >
                {initialsOf(client.name)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#1479BD]">Client</p>
                <p className="break-words text-2xl font-bold leading-tight tracking-tight text-[#0b3b66]">{client.name}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2.5">
                  <StatusBadge active={client.isActive} />
                  <span className="text-xs text-slate-500">Client since {formatDateTime(client.createdAt).split(',')[0]}</span>
                </div>
              </div>
              {(client.phone || client.email) && (
                <div className="flex flex-wrap gap-2">
                  {client.phone && (
                    <a
                      href={`tel:${client.phone.replace(/[^+\d]/g, '')}`}
                      className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-b from-[#1a7fc4] to-[#0f62a3] px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-blue-900/25 transition-all hover:from-[#1673b3] hover:to-[#0c5590] active:translate-y-px"
                    >
                      <Icon name="phone" className="h-4 w-4" />
                      Call
                    </a>
                  )}
                  {client.email && (
                    <a
                      href={`mailto:${client.email}`}
                      className="inline-flex items-center gap-2 rounded-xl border border-sky-200 bg-sky-50 px-4 py-2 text-sm font-semibold text-[#0b3b66] transition-colors hover:bg-sky-100"
                    >
                      <Icon name="mail" className="h-4 w-4 text-[#1479BD]" />
                      Send email
                    </a>
                  )}
                </div>
              )}
            </div>
          </div>

          {!client.contactPerson && !client.phone && !client.email && !client.address && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-dashed border-sky-300 bg-sky-50/60 p-4">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white text-[#1479BD] shadow-sm ring-1 ring-sky-100" aria-hidden="true">
                  <Icon name="person" className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-sm font-semibold text-[#0b3b66]">No contact details yet</p>
                  <p className="text-xs text-slate-600">Add a contact person, phone or email so the team can reach this client.</p>
                </div>
              </div>
              {canEdit && (
                <Button size="sm" onClick={() => onEdit(client)}>
                  Add contact details
                </Button>
              )}
            </div>
          )}

          {(client.contactPerson || client.phone || client.email || client.address) && (
            <dl className="grid gap-3 sm:grid-cols-2">
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
            </dl>
          )}

          <div className={`rounded-2xl border p-4 ${client.notes ? 'border-amber-200 bg-amber-50/50' : 'border-dashed border-slate-200 bg-slate-50/60'}`}>
            <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              <Icon name="note" className={`h-4 w-4 ${client.notes ? 'text-amber-600' : 'text-slate-400'}`} />
              Notes
            </p>
            <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-slate-900">{client.notes ?? NOT_PROVIDED}</p>
          </div>
        </div>
      )}
    </Modal>
  )
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { PRIVILEGED_ROLES_LABEL } from '../../auth/roleNames'
import { DetailRow, LoadError } from '../../components/records'
import { Alert, Button, Card, PageHeader, SelectField, Spinner, TextAreaField } from '../../components/ui'
import { api, ApiError, errorMessage } from '../../lib/api'
import { cx, formatDateTime } from '../../lib/format'
import { IconTile, type IconName } from '../dashboard/icons'
import { SuggestionStatusBadge } from './SuggestionStatusBadge'
import {
  CATEGORY_LABELS,
  DONE_STATUSES,
  noteRequirement,
  reviewListPath,
  STATUS_ACTIONS,
  STATUS_LABELS,
  SUGGESTIONS_QUERY_KEY,
  type ReviewOptions,
  userOptionLabel,
  type SuggestionDetail,
  type SuggestionEvent,
  type SuggestionStatus,
} from './suggestionTypes'

// The page banner's link style (as BannerButton).
const BANNER_LINK = 'bn-chip inline-flex items-center justify-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold transition-all hover:-translate-y-px'

// The usual route of a suggestion. A reopened one starts the route again.
const STEPS: SuggestionStatus[] = ['SUBMITTED', 'UNDER_REVIEW', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']

function Progress({ status }: { status: SuggestionStatus }) {
  const at = status === 'REOPENED' ? 0 : STEPS.indexOf(status)

  return (
    <ol className="flex items-start" aria-label="Progress">
      {STEPS.map((step, index) => {
        const done = index < at || (index === at && (status === 'RESOLVED' || status === 'CLOSED'))
        const current = index === at && !done

        return (
          <li key={step} className="relative flex min-w-0 flex-1 flex-col items-center text-center">
            {index > 0 && <span className={cx('absolute right-1/2 top-3.5 h-0.5 w-full -translate-y-1/2', index <= at ? 'bg-[#1479BD]' : 'bg-slate-200')} aria-hidden="true" />}
            <span
              className={cx(
                'relative z-10 flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ring-4 ring-white',
                done ? 'bg-emerald-500 text-white' : current ? (status === 'REOPENED' ? 'bg-rose-500 text-white' : 'bg-[#1479BD] text-white') : 'bg-slate-200 text-slate-500',
              )}
              aria-current={current ? 'step' : undefined}
            >
              {done ? (
                <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
                  <path d="m4.5 10.5 3.5 3.5 7.5-8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                index + 1
              )}
            </span>
            <span className={cx('mt-1.5 text-[11px] font-semibold leading-tight', current || done ? 'text-slate-900' : 'text-slate-400')}>{STATUS_LABELS[step]}</span>
          </li>
        )
      })}
    </ol>
  )
}

function CardTitle({ icon, from, to, children }: { icon: IconName; from: string; to: string; children: ReactNode }) {
  return (
    <h2 className="flex items-center gap-3 border-b border-slate-200 bg-gradient-to-r from-sky-50 via-white to-white px-5 py-3 text-sm font-bold text-[#0b3b66]">
      <IconTile icon={icon} from={from} to={to} className="h-8 w-8 rounded-lg" />
      {children}
    </h2>
  )
}

/** One suggestion: its details, resolution and history; comments; and, for reviewers, the review controls. */
export function SuggestionDetailPage() {
  const { id = '' } = useParams()
  const queryClient = useQueryClient()
  const key = [...SUGGESTIONS_QUERY_KEY, 'detail', id]
  const suggestion = useQuery({ queryKey: key, queryFn: () => api.get<SuggestionDetail>(`/suggestions/${id}`) })
  // The last status change made here, confirmed in a banner; tied to the suggestion so it never shows on another one.
  const [changed, setChanged] = useState<{ id: string; status: SuggestionStatus } | null>(null)

  /** Shows the updated suggestion at once and refreshes the lists and alerts behind it. */
  const saved = (next: SuggestionDetail) => {
    queryClient.setQueryData(key, next)
    void queryClient.invalidateQueries({ queryKey: [...SUGGESTIONS_QUERY_KEY, 'mine'] })
    void queryClient.invalidateQueries({ queryKey: [...SUGGESTIONS_QUERY_KEY, 'review'] })
    void queryClient.invalidateQueries({ queryKey: ['notifications'] })
  }
  const statusSaved = (next: SuggestionDetail) => {
    saved(next)
    setChanged({ id: next.id, status: next.status })
  }
  /** A 409 means someone else changed it meanwhile: reload so the page shows the current state. */
  const refreshOnConflict = (error: unknown) => {
    if (error instanceof ApiError && error.status === 409) void suggestion.refetch()
  }

  if (suggestion.isPending) return <Spinner label="Loading suggestion" />
  if (suggestion.isError) {
    const missing = suggestion.error instanceof ApiError && suggestion.error.status === 404

    return (
      <>
        <PageHeader title="Suggestion" />
        <Card>
          {missing ? (
            <div className="p-5">
              <Alert tone="info">
                This suggestion does not exist, or it was submitted by someone else.{' '}
                <Link to="/suggestions" className="font-medium underline">
                  Back to My Suggestions
                </Link>
              </Alert>
            </div>
          ) : (
            <LoadError error={suggestion.error} onRetry={() => void suggestion.refetch()} />
          )}
        </Card>
      </>
    )
  }

  const data = suggestion.data
  const reviewer = data.access.reviewer
  const notice = changed?.id === data.id ? changed.status : null

  return (
    <>
      <PageHeader
        title={`${data.reference} · ${data.subject}`}
        description={`${CATEGORY_LABELS[data.category]} submitted by ${data.submittedBy.fullName} on ${formatDateTime(data.createdAt)}`}
        actions={
          <>
            {data.access.isSubmitter && (
              <Link to="/suggestions" className={BANNER_LINK}>
                My Suggestions
              </Link>
            )}
            {reviewer && (
              <Link to={reviewListPath(data.status)} className={BANNER_LINK}>
                Suggestions Review
              </Link>
            )}
          </>
        }
      />

      {notice && (
        <div className="mb-5">
          <Alert tone="success" onDismiss={() => setChanged(null)}>
            {data.reference} is now <strong>{STATUS_LABELS[notice]}</strong>.
            {reviewer && DONE_STATUSES.includes(notice) && (
              <>
                {' '}
                It no longer shows under Open in Suggestions Review; it stays listed under All with its history.{' '}
                <Link to={reviewListPath(notice)} className="font-medium underline">
                  View in All suggestions
                </Link>
              </>
            )}
          </Alert>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="min-w-0 space-y-5 lg:col-span-2">
          <Card className="rounded-2xl">
            <div className="h-1 bg-gradient-to-r from-[#0b3b66] via-[#1479BD] to-[#00A6C8]" aria-hidden="true" />
            <div className="space-y-5 p-5">
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-3">
                <SuggestionStatusBadge status={data.status} />
                <span className="text-xs text-slate-500">
                  Since {formatDateTime(data.statusChangedAt)} · by {data.statusChangedBy.fullName}
                </span>
              </div>
              <Progress status={data.status} />
              <dl>
                <DetailRow label="Reference">{data.reference}</DetailRow>
                <DetailRow label="Type">{CATEGORY_LABELS[data.category]}</DetailRow>
                <DetailRow label="Submitted by">{data.submittedBy.fullName}</DetailRow>
                <DetailRow label="Submitted on">{formatDateTime(data.createdAt)}</DetailRow>
                {data.pagePath && <DetailRow label="Page">{data.pagePath}</DetailRow>}
                <DetailRow label="Assigned to">{data.assignedTo ? data.assignedTo.fullName : <span className="text-slate-400">Not assigned</span>}</DetailRow>
              </dl>
              <div className="rounded-xl border-l-4 border-[#1479BD] bg-sky-50/60 px-4 py-3">
                <h2 className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-[#1479BD]">Description</h2>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-800">{data.description}</p>
              </div>
            </div>
          </Card>

          {data.resolutionNotes && (
            <Card className="rounded-2xl">
              <div className="border-l-4 border-green-500 bg-emerald-50/60 p-5">
                <h2 className="flex items-center gap-2 text-sm font-bold text-emerald-800">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500 text-white" aria-hidden="true">
                    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="3">
                      <path d="m4.5 10.5 3.5 3.5 7.5-8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                  Resolution
                </h2>
                <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-slate-700">{data.resolutionNotes}</p>
                {data.resolvedAt && data.resolvedBy && (
                  <p className="mt-2 text-xs text-slate-500">
                    Resolved by {data.resolvedBy.fullName} on {formatDateTime(data.resolvedAt)}
                    {data.closedAt && data.closedBy && ` · Closed by ${data.closedBy.fullName} on ${formatDateTime(data.closedAt)}`}
                  </p>
                )}
              </div>
            </Card>
          )}

          <Card className="rounded-2xl">
            <CardTitle icon="pulse" from="#7C3AED" to="#A78BFA">Responses and history</CardTitle>
            <ol className="bg-gradient-to-b from-slate-50/60 to-white px-5 py-4" aria-label="Responses and history, oldest first">
              {data.events.map((event) => (
                <HistoryEntry key={event.id} event={event} />
              ))}
            </ol>
            {data.access.canComment ? (
              <CommentForm suggestion={data} onSaved={saved} onError={refreshOnConflict} />
            ) : (
              <p className="border-t border-slate-200 px-5 py-4 text-sm text-slate-600">This suggestion is closed. Submit a new suggestion if the matter needs more attention.</p>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-5">
          {data.access.transitions.length > 0 && <StatusPanel suggestion={data} onSaved={statusSaved} onError={refreshOnConflict} />}
          {data.access.canAssign && <AssignPanel suggestion={data} onSaved={saved} />}
        </div>
      </div>
    </>
  )
}

function eventText(event: SuggestionEvent): ReactNode {
  switch (event.kind) {
    case 'SUBMITTED':
      return 'Submitted the suggestion'
    case 'STATUS_CHANGED':
      return (
        <>
          Changed the status from <strong>{STATUS_LABELS[event.fromStatus!]}</strong> to <strong>{STATUS_LABELS[event.toStatus!]}</strong>
        </>
      )
    case 'ASSIGNED':
      return event.assignedTo ? (
        <>
          Assigned it to <strong>{event.assignedTo.fullName}</strong>
        </>
      ) : (
        'Removed the assignment'
      )
    case 'COMMENT':
      return event.internal ? 'Added an internal note' : event.bySubmitter ? 'Added a comment' : 'Responded'
  }
}

function HistoryEntry({ event }: { event: SuggestionEvent }) {
  const response = event.kind === 'COMMENT' && !event.bySubmitter && !event.internal
  const dot = event.internal ? 'bg-amber-500' : response ? 'bg-[#1479BD]' : event.kind === 'STATUS_CHANGED' ? 'bg-violet-500' : event.kind === 'ASSIGNED' ? 'bg-emerald-500' : 'bg-slate-400'
  const name = event.actor.fullName
  const letters = name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('')

  return (
    <li className="group relative flex gap-3 pb-4 last:pb-0">
      <span className="absolute bottom-0 left-4 top-9 w-px -translate-x-1/2 bg-slate-300 group-last:hidden" aria-hidden="true" />
      <span className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#0b3b66] to-[#1479BD] text-[11px] font-bold text-white shadow-sm ring-2 ring-white" aria-hidden="true">
        {letters || '?'}
        <span className={cx('absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-white', dot)} />
      </span>
      <div className={cx('min-w-0 flex-1 rounded-xl border px-3.5 py-2.5 shadow-sm', event.internal ? 'border-amber-200 bg-amber-50' : response ? 'border-sky-200 bg-sky-50/70' : 'border-slate-200 bg-white')}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="text-sm text-slate-800">
            <span className="font-semibold text-slate-900">{event.actor.fullName}</span> · {eventText(event)}
            {event.internal && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800">Internal — not shown to the submitter</span>}
          </p>
          <time dateTime={event.createdAt} className="text-xs text-slate-500">
            {formatDateTime(event.createdAt)}
          </time>
        </div>
        {event.body && <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-slate-700">{event.body}</p>}
      </div>
    </li>
  )
}

interface PanelProps {
  suggestion: SuggestionDetail
  onSaved: (next: SuggestionDetail) => void
  onError?: (error: unknown) => void
}

function CommentForm({ suggestion, onSaved, onError }: PanelProps) {
  const [body, setBody] = useState('')
  const [internal, setInternal] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reviewer = suggestion.access.reviewer
  const send = useMutation({
    mutationFn: () => api.post<SuggestionDetail>(`/suggestions/${suggestion.id}/comments`, { body: body.trim(), internal }),
    onSuccess: (next) => {
      setBody('')
      setInternal(false)
      onSaved(next)
    },
    onError: (failure) => {
      setError(errorMessage(failure))
      onError?.(failure)
    },
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    if (body.trim() === '') {
      setError('Write a comment first.')
      return
    }
    setError(null)
    send.mutate()
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-3 border-t border-slate-200 px-5 py-4">
      <TextAreaField
        label={reviewer ? 'Add a response or note' : 'Add a comment'}
        rows={3}
        maxLength={4000}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        hint={reviewer ? 'A response is shown to the submitter unless you mark it internal.' : 'Add more detail or answer a question from the reviewer.'}
      />
      {reviewer && (
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={internal} onChange={(event) => setInternal(event.target.checked)} className="h-4 w-4 rounded border-slate-300" />
          Internal note (reviewers only)
        </label>
      )}
      {error && <Alert>{error}</Alert>}
      <div className="flex justify-end">
        <Button type="submit" loading={send.isPending}>
          {reviewer && !internal ? 'Send Response' : reviewer ? 'Add Note' : 'Add Comment'}
        </Button>
      </div>
    </form>
  )
}

/** Status changes the signed-in user may make: every allowed step for a reviewer, Reopen for the submitter. */
function StatusPanel({ suggestion, onSaved, onError }: PanelProps) {
  const [target, setTarget] = useState<SuggestionStatus | null>(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const reviewer = suggestion.access.reviewer
  const required = target ? noteRequirement(suggestion.status, target) : null

  const change = useMutation({
    mutationFn: (to: SuggestionStatus) =>
      reviewer
        ? api.patch<SuggestionDetail>(`/suggestions/${suggestion.id}/status`, { status: to, fromStatus: suggestion.status, note: note.trim() })
        : api.post<SuggestionDetail>(`/suggestions/${suggestion.id}/reopen`, { fromStatus: suggestion.status, reason: note.trim() }),
    onSuccess: (next) => {
      setTarget(null)
      setNote('')
      onSaved(next)
    },
    onError: (failure) => {
      setError(errorMessage(failure))
      onError?.(failure)
    },
  })

  function choose(to: SuggestionStatus) {
    setTarget(to)
    setNote('')
    setError(null)
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!target) return
    if (required && note.trim() === '') {
      setError(required === 'resolution' ? 'Describe how the suggestion was resolved.' : 'Give a reason for this change.')
      return
    }
    setError(null)
    change.mutate(target)
  }

  return (
    <Card className="rounded-2xl">
      <CardTitle icon="shield" from="#1479BD" to="#4aa3df">{reviewer ? 'Review' : 'Not resolved for you?'}</CardTitle>
      <div className="space-y-3 p-5">
        {!reviewer && <p className="text-sm text-slate-600">If the resolution does not solve the problem, reopen the suggestion and say why.</p>}
        <div className="flex flex-wrap gap-2">
          {suggestion.access.transitions.map((to) => (
            <Button key={to} size="sm" variant={target === to ? 'primary' : 'secondary'} onClick={() => choose(to)} aria-pressed={target === to}>
              {STATUS_ACTIONS[to]}
            </Button>
          ))}
        </div>
        {target && (
          <form onSubmit={submit} noValidate className="space-y-3">
            <TextAreaField
              label={required === 'resolution' ? 'Resolution notes' : required === 'reason' ? 'Reason' : 'Note (optional)'}
              required={required !== null}
              rows={3}
              maxLength={4000}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              hint={required === 'resolution' ? 'Shown to the submitter.' : 'Shown to the submitter in the history.'}
            />
            {error && <Alert>{error}</Alert>}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setTarget(null)}>
                Cancel
              </Button>
              <Button type="submit" loading={change.isPending}>
                {STATUS_ACTIONS[target]}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Card>
  )
}

function AssignPanel({ suggestion, onSaved }: PanelProps) {
  const options = useQuery({ queryKey: [...SUGGESTIONS_QUERY_KEY, 'review', 'options'], queryFn: () => api.get<ReviewOptions>('/suggestions/review/options') })
  const assign = useMutation({
    mutationFn: (assignedTo: string | null) => api.patch<SuggestionDetail>(`/suggestions/${suggestion.id}/assignment`, { assignedTo }),
    onSuccess: onSaved,
  })

  return (
    <Card className="rounded-2xl">
      <CardTitle icon="users" from="#059669" to="#34D399">Responsible person</CardTitle>
      <div className="space-y-3 p-5">
        <SelectField
          label="Assigned to"
          value={suggestion.assignedTo?.id ?? ''}
          disabled={options.isPending || assign.isPending}
          onChange={(event) => assign.mutate(event.target.value === '' ? null : event.target.value)}
          hint={`Only active ${PRIVILEGED_ROLES_LABEL} users review suggestions.`}
        >
          <option value="">Not assigned</option>
          {(options.data?.reviewers ?? []).map((user, _, users) => (
            <option key={user.id} value={user.id}>
              {userOptionLabel(user, users)}
            </option>
          ))}
          {/* A former reviewer stays shown until the assignment is changed. */}
          {suggestion.assignedTo && !(options.data?.reviewers ?? []).some((user) => user.id === suggestion.assignedTo?.id) && (
            <option value={suggestion.assignedTo.id}>{suggestion.assignedTo.fullName}</option>
          )}
        </SelectField>
        {assign.isError && <Alert>{errorMessage(assign.error)}</Alert>}
      </div>
    </Card>
  )
}

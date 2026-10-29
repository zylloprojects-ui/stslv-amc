import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { DetailRow, LoadError } from '../../components/records'
import { Alert, Button, Card, PageHeader, SelectField, Spinner, TextAreaField } from '../../components/ui'
import { api, ApiError, errorMessage } from '../../lib/api'
import { cx, formatDateTime } from '../../lib/format'
import { SuggestionStatusBadge } from './SuggestionStatusBadge'
import {
  CATEGORY_LABELS,
  noteRequirement,
  STATUS_ACTIONS,
  STATUS_LABELS,
  SUGGESTIONS_QUERY_KEY,
  type ReviewOptions,
  type SuggestionDetail,
  type SuggestionEvent,
  type SuggestionStatus,
} from './suggestionTypes'

// The page banner's link style (as BannerButton).
const BANNER_LINK = 'bn-chip inline-flex items-center justify-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold transition-all hover:-translate-y-px'

/** One suggestion: its details, resolution and history; comments; and, for reviewers, the review controls. */
export function SuggestionDetailPage() {
  const { id = '' } = useParams()
  const queryClient = useQueryClient()
  const key = [...SUGGESTIONS_QUERY_KEY, 'detail', id]
  const suggestion = useQuery({ queryKey: key, queryFn: () => api.get<SuggestionDetail>(`/suggestions/${id}`) })

  /** Shows the updated suggestion at once and refreshes the lists and alerts behind it. */
  const saved = (next: SuggestionDetail) => {
    queryClient.setQueryData(key, next)
    void queryClient.invalidateQueries({ queryKey: [...SUGGESTIONS_QUERY_KEY, 'mine'] })
    void queryClient.invalidateQueries({ queryKey: [...SUGGESTIONS_QUERY_KEY, 'review'] })
    void queryClient.invalidateQueries({ queryKey: ['notifications'] })
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
              <Link to="/admin/suggestions" className={BANNER_LINK}>
                Suggestions Review
              </Link>
            )}
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="min-w-0 space-y-5 lg:col-span-2">
          <Card>
            <div className="space-y-4 p-5">
              <div className="flex flex-wrap items-center gap-3">
                <SuggestionStatusBadge status={data.status} />
                <span className="text-xs text-slate-500">
                  Since {formatDateTime(data.statusChangedAt)} · by {data.statusChangedBy.fullName}
                </span>
              </div>
              <dl>
                <DetailRow label="Reference">{data.reference}</DetailRow>
                <DetailRow label="Type">{CATEGORY_LABELS[data.category]}</DetailRow>
                <DetailRow label="Submitted by">{data.submittedBy.fullName}</DetailRow>
                <DetailRow label="Submitted on">{formatDateTime(data.createdAt)}</DetailRow>
                {data.pagePath && <DetailRow label="Page">{data.pagePath}</DetailRow>}
                <DetailRow label="Assigned to">{data.assignedTo ? data.assignedTo.fullName : <span className="text-slate-400">Not assigned</span>}</DetailRow>
              </dl>
              <div>
                <h2 className="mb-1.5 text-sm font-semibold text-slate-900">Description</h2>
                <p className="whitespace-pre-wrap break-words text-sm text-slate-700">{data.description}</p>
              </div>
            </div>
          </Card>

          {data.resolutionNotes && (
            <Card>
              <div className="border-l-4 border-green-500 p-5">
                <h2 className="text-sm font-semibold text-slate-900">Resolution</h2>
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

          <Card>
            <div className="border-b border-slate-200 px-5 py-3">
              <h2 className="text-sm font-semibold text-slate-900">Responses and history</h2>
            </div>
            <ol className="divide-y divide-slate-100" aria-label="Responses and history, oldest first">
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
          {data.access.transitions.length > 0 && <StatusPanel suggestion={data} onSaved={saved} onError={refreshOnConflict} />}
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

  return (
    <li className={cx('px-5 py-3', event.internal && 'bg-amber-50/60', response && 'bg-sky-50/50')}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm text-slate-800">
          <span className="font-semibold text-slate-900">{event.actor.fullName}</span> · {eventText(event)}
          {event.internal && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800">Internal — not shown to the submitter</span>}
        </p>
        <time dateTime={event.createdAt} className="text-xs text-slate-500">
          {formatDateTime(event.createdAt)}
        </time>
      </div>
      {event.body && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700">{event.body}</p>}
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
    <Card>
      <div className="space-y-3 p-5">
        <h2 className="text-sm font-semibold text-slate-900">{reviewer ? 'Review' : 'Not resolved for you?'}</h2>
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
    <Card>
      <div className="space-y-3 p-5">
        <h2 className="text-sm font-semibold text-slate-900">Responsible person</h2>
        <SelectField
          label="Assigned to"
          value={suggestion.assignedTo?.id ?? ''}
          disabled={options.isPending || assign.isPending}
          onChange={(event) => assign.mutate(event.target.value === '' ? null : event.target.value)}
          hint="Only active Admin users review suggestions."
        >
          <option value="">Not assigned</option>
          {(options.data?.reviewers ?? []).map((user) => (
            <option key={user.id} value={user.id}>
              {user.fullName}
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

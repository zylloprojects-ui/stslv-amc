import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Alert, Modal } from '../components/ui'
import { api, ApiError, errorMessage } from '../lib/api'
import { cx } from '../lib/format'
import { SUGGESTIONS_QUERY_KEY, type SuggestionCategory, type SuggestionDetail } from '../pages/suggestions/suggestionTypes'

const PRIMARY_BUTTON =
  'inline-flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-[#0f5f98] to-[#0b7a96] px-5 py-2 text-sm font-semibold text-white shadow-md shadow-sky-700/25 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0'
const SECONDARY_BUTTON =
  'inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-5 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50'
const FIELD =
  'block w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-[#1479BD] focus:outline-none focus:ring-4 focus:ring-sky-200/60'
const FIELD_LABEL = 'text-xs font-semibold uppercase tracking-wider text-slate-500'

// The same limits as the API (suggestions.schemas.ts).
const SUBJECT_MIN = 3
const SUBJECT_MAX = 150
const MIN_LENGTH = 10
const MAX_LENGTH = 4000

const TYPES: { value: SuggestionCategory; label: string; description: string; color: string; icon: ReactNode }[] = [
  {
    value: 'IMPROVEMENT',
    label: 'Improvement',
    description: 'Make something work better',
    color: '#1B8AD3',
    icon: <path d="M5 15l4-4 3 3 7-7M14 7h5v5" strokeLinecap="round" strokeLinejoin="round" />,
  },
  {
    value: 'BUG',
    label: 'Bug',
    description: 'Something is not working',
    color: '#D1428C',
    icon: (
      <>
        <rect x="8" y="8" width="8" height="11" rx="4" />
        <path d="M9 8a3 3 0 0 1 6 0M4 12h4M16 12h4M5 18l3-2M19 18l-3-2M5 6l3 2M19 6l-3 2" strokeLinecap="round" />
      </>
    ),
  },
  {
    value: 'FEATURE',
    label: 'Feature',
    description: 'Suggest something new',
    color: '#5BAF48',
    icon: <path d="M12 4v16M4 12h16" strokeLinecap="round" />,
  },
]

function BulbIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** One id per opened form: a repeated submit of the same form is recognised by the API and not stored twice. */
function newRequestId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16))
}

/**
 * The suggestion form. Sends the suggestion to the API with the page it was
 * opened on; on success shows the reference and a link to follow it up.
 */
export function SuggestionFormModal({ onClose }: { onClose: () => void }) {
  const location = useLocation()
  const queryClient = useQueryClient()
  const [requestId] = useState(newRequestId)
  const [category, setCategory] = useState<SuggestionCategory>('IMPROVEMENT')
  const [subject, setSubject] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () =>
      api.post<SuggestionDetail>('/suggestions', {
        category,
        subject: subject.trim(),
        description: description.trim(),
        pagePath: location.pathname,
        requestId,
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: SUGGESTIONS_QUERY_KEY }),
    onError: (failure) => {
      const details = failure instanceof ApiError ? failure.details.map((detail) => detail.message) : []

      setError(details.length > 0 ? details.join(' ') : errorMessage(failure))
    },
  })
  const done = save.data

  function submit(event: FormEvent) {
    event.preventDefault()

    if (subject.trim().length < SUBJECT_MIN) {
      setError(`Please give a short subject (at least ${SUBJECT_MIN} characters).`)
      return
    }
    if (description.trim().length < MIN_LENGTH) {
      setError(`Please add a little more detail (at least ${MIN_LENGTH} characters).`)
      return
    }

    setError(null)
    save.mutate()
  }

  return (
    <Modal
      title="Suggestions & Improvements"
      onClose={onClose}
      footer={
        done ? (
          <button type="button" onClick={onClose} className={PRIMARY_BUTTON}>
            Done
          </button>
        ) : (
          <>
            <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
              Cancel
            </button>
            <button type="submit" form="feedback-form" className={PRIMARY_BUTTON} disabled={save.isPending}>
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="m21 3-9.5 9.5M21 3l-6.5 18-3-8.5L3 9.5 21 3Z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {save.isPending ? 'Sending…' : 'Submit Feedback'}
            </button>
          </>
        )
      }
    >
      {done ? (
        <div className="space-y-2 py-6 text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-[#5BAF48] to-[#00A6C8] text-white shadow-lg shadow-emerald-500/30">
            <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
              <path d="m5 12.5 4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <p className="text-base font-semibold text-slate-900">Thank you for your feedback</p>
          <p className="text-sm text-slate-600">
            Your suggestion was submitted as <span className="font-semibold text-slate-900">{done.reference}</span>. You will see the review status and any responses under My Suggestions.
          </p>
          <p className="flex flex-wrap justify-center gap-x-4 gap-y-1 pt-1 text-sm">
            <Link to={`/suggestions/${done.id}`} onClick={onClose} className="font-semibold text-[#0f62a3] hover:underline">
              View {done.reference}
            </Link>
            <Link to="/suggestions" onClick={onClose} className="font-semibold text-[#0f62a3] hover:underline">
              My Suggestions
            </Link>
          </p>
        </div>
      ) : (
        <form id="feedback-form" onSubmit={submit} noValidate className="space-y-4">
          <p className="text-sm text-slate-600">Report a problem, suggest a feature, or propose an improvement for STSLEV AMC.</p>

          <fieldset>
            <legend className={cx('mb-2', FIELD_LABEL)}>Type</legend>
            <div className="grid grid-cols-3 gap-2.5">
              {TYPES.map((option) => {
                const selected = category === option.value

                return (
                  <label
                    key={option.value}
                    className={cx(
                      'relative flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-center transition-all duration-200 has-[:focus-visible]:ring-4 has-[:focus-visible]:ring-sky-200',
                      selected ? 'shadow-md' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50',
                    )}
                    style={selected ? { borderColor: option.color, backgroundColor: option.color + '12' } : undefined}
                  >
                    <input type="radio" name="feedback-type" value={option.value} checked={selected} onChange={() => setCategory(option.value)} className="sr-only" />
                    <span
                      className="flex h-9 w-9 items-center justify-center rounded-lg text-white transition-transform duration-200"
                      style={{ backgroundColor: option.color, transform: selected ? 'scale(1.08)' : undefined }}
                      aria-hidden="true"
                    >
                      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
                        {option.icon}
                      </svg>
                    </span>
                    <span className="text-sm font-semibold text-slate-900">{option.label}</span>
                    <span className="hidden text-[11px] leading-tight text-slate-500 sm:block">{option.description}</span>
                    {selected && (
                      <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full text-white" style={{ backgroundColor: option.color }} aria-hidden="true">
                        <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2.2">
                          <path d="m2.5 6.3 2.2 2.2 4.8-5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </span>
                    )}
                  </label>
                )
              })}
            </div>
          </fieldset>

          <div>
            <label htmlFor="feedback-subject" className={cx('mb-1.5 block', FIELD_LABEL)}>
              Subject
            </label>
            <input
              id="feedback-subject"
              type="text"
              maxLength={SUBJECT_MAX}
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              placeholder="A short title, e.g. Export button is slow"
              className={FIELD}
            />
          </div>

          <div>
            <div className="mb-1.5 flex items-baseline justify-between">
              <label htmlFor="feedback-description" className={FIELD_LABEL}>
                Description
              </label>
              <span className="text-xs text-slate-400">
                {description.length}/{MAX_LENGTH}
              </span>
            </div>
            <textarea
              id="feedback-description"
              rows={5}
              maxLength={MAX_LENGTH}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              aria-invalid={error ? true : undefined}
              placeholder="Describe the issue, improvement or feature you would like to see…"
              className={cx(FIELD, 'resize-y')}
            />
            <p className="mt-1.5 text-xs text-slate-500">
              Page: <span className="font-medium text-slate-700">{location.pathname}</span>
            </p>
          </div>

          {error && <Alert>{error}</Alert>}
        </form>
      )}
    </Modal>
  )
}

/** Header button that opens the suggestions popup. */
export function FeedbackButton() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Suggestions and improvements"
        title="Suggestions & improvements"
        className="group relative shrink-0 rounded-full p-2 text-slate-600 transition-colors hover:bg-amber-50 hover:text-[#FF8212]"
      >
        <BulbIcon className="h-5 w-5 transition-transform duration-200 group-hover:scale-110" />
        <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-[#FF8212] ring-2 ring-white" aria-hidden="true" />
      </button>

      {/* Mounted only while open, so every opening starts a fresh form with a fresh request id. */}
      {open && <SuggestionFormModal onClose={() => setOpen(false)} />}
    </>
  )
}

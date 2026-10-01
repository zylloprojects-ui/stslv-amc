import { useState, type FormEvent, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { Alert, Modal } from '../components/ui'
import { cx } from '../lib/format'

const PRIMARY_BUTTON =
  'inline-flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-[#0f5f98] to-[#0b7a96] px-5 py-2 text-sm font-semibold text-white shadow-md shadow-sky-700/25 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg active:translate-y-0'
const SECONDARY_BUTTON =
  'inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-5 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50'

const MAX_LENGTH = 1000
const MIN_LENGTH = 10

const TYPES: { value: string; description: string; color: string; icon: ReactNode }[] = [
  {
    value: 'Improvement',
    description: 'Make something work better',
    color: '#1B8AD3',
    icon: <path d="M5 15l4-4 3 3 7-7M14 7h5v5" strokeLinecap="round" strokeLinejoin="round" />,
  },
  {
    value: 'Bug',
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
    value: 'Feature',
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


/**
 * Header button that opens the suggestions popup. This is the interface only:
 * nothing is stored or sent yet, because the API has no feedback endpoint.
 */
export function FeedbackButton() {
  const location = useLocation()
  const [open, setOpen] = useState(false)
  const [type, setType] = useState(TYPES[0]?.value ?? 'Improvement')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  function close() {
    setOpen(false)
    setDone(false)
    setError(null)
    setDescription('')
    setType(TYPES[0]?.value ?? 'Improvement')
  }

  function submit(event: FormEvent) {
    event.preventDefault()

    if (description.trim().length < MIN_LENGTH) {
      setError(`Please add a little more detail (at least ${MIN_LENGTH} characters).`)
      return
    }

    setError(null)
    setDone(true)
  }

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

      {open && (
        <Modal
          title="Suggestions & Improvements"
          onClose={close}
          footer={
            done ? (
              <button type="button" onClick={close} className={PRIMARY_BUTTON}>
                Done
              </button>
            ) : (
              <>
                <button type="button" onClick={close} className={SECONDARY_BUTTON}>
                  Cancel
                </button>
                <button type="submit" form="feedback-form" className={PRIMARY_BUTTON}>
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="m21 3-9.5 9.5M21 3l-6.5 18-3-8.5L3 9.5 21 3Z" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Submit Feedback
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
              <p className="text-sm text-slate-600">Your {type.toLowerCase()} note on “{location.pathname}” has been recorded in this preview.</p>
              <p className="text-xs text-slate-500">Suggestions are not stored or sent yet.</p>
            </div>
          ) : (
            <form id="feedback-form" onSubmit={submit} noValidate className="space-y-4">
              <p className="text-sm text-slate-600">Report a problem, suggest a feature, or propose an improvement for STSLEV ERP.</p>

              <fieldset>
                <legend className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Type</legend>
                <div className="grid grid-cols-3 gap-2.5">
                  {TYPES.map((option) => {
                    const selected = type === option.value

                    return (
                      <label
                        key={option.value}
                        className={cx(
                          'relative flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-center transition-all duration-200 has-[:focus-visible]:ring-4 has-[:focus-visible]:ring-sky-200',
                          selected ? 'shadow-md' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50',
                        )}
                        style={selected ? { borderColor: option.color, backgroundColor: option.color + '12' } : undefined}
                      >
                        <input type="radio" name="feedback-type" value={option.value} checked={selected} onChange={() => setType(option.value)} className="sr-only" />
                        <span
                          className="flex h-9 w-9 items-center justify-center rounded-lg text-white transition-transform duration-200"
                          style={{ backgroundColor: option.color, transform: selected ? 'scale(1.08)' : undefined }}
                          aria-hidden="true"
                        >
                          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
                            {option.icon}
                          </svg>
                        </span>
                        <span className="text-sm font-semibold text-slate-900">{option.value}</span>
                        <span className="text-[11px] leading-tight text-slate-500">{option.description}</span>
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
                <div className="mb-1.5 flex items-baseline justify-between">
                  <label htmlFor="feedback-description" className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Description
                  </label>
                  <span className="text-xs text-slate-400">
                    {description.length}/{MAX_LENGTH}
                  </span>
                </div>
                <textarea
                  id="feedback-description"
                  rows={4}
                  maxLength={MAX_LENGTH}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  aria-invalid={error ? true : undefined}
                  placeholder="Describe the issue, improvement or feature you would like to see…"
                  className="block w-full resize-none rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-[#1479BD] focus:outline-none focus:ring-4 focus:ring-sky-200/60"
                />
                <p className="mt-1.5 text-xs text-slate-500">
                  Page: <span className="font-medium text-slate-700">{location.pathname}</span>
                </p>
              </div>

              {error && <Alert>{error}</Alert>}
            </form>
          )}
        </Modal>
      )}
    </>
  )
}

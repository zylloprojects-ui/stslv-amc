import { useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useLocation } from 'react-router-dom'
import { useDialogBehavior } from '../components/hooks'
import { HelpArticle } from './HelpArticle'
import { HELP_GROUPS, pageLink, searchTopics, topicForPath, type HelpTopic } from './helpModel'
import { useHelpTopics } from './useHelpTopics'

export const GENERAL_TOPIC_ID = 'getting-started'

/** The visible topics grouped in sidebar order, for a topic list. */
export function groupTopics(topics: readonly HelpTopic[]) {
  return HELP_GROUPS.map((group) => ({ group, topics: topics.filter((topic) => topic.group === group) })).filter((entry) => entry.topics.length > 0)
}

function TopicList({ topics, onOpen, currentId }: { topics: readonly HelpTopic[]; onOpen: (id: string) => void; currentId?: string }) {
  return (
    <div className="space-y-4">
      {groupTopics(topics).map(({ group, topics: inGroup }) => (
        <section key={group}>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">{group}</h3>
          <ul className="space-y-0.5">
            {inGroup.map((topic) => (
              <li key={topic.id}>
                <button
                  type="button"
                  onClick={() => onOpen(topic.id)}
                  aria-current={topic.id === currentId ? 'true' : undefined}
                  className="w-full rounded-lg px-2.5 py-1.5 text-left text-sm text-slate-700 hover:bg-sky-50 aria-[current=true]:bg-sky-100 aria-[current=true]:font-semibold aria-[current=true]:text-[#0b5d8f]"
                >
                  {topic.title}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/**
 * Help for the page being shown, as a panel over the right side (the whole screen on a phone).
 * Only topics for pages the user may open are offered.
 */
export function HelpPanel({ onClose }: { onClose: () => void }) {
  const { pathname } = useLocation()
  const topics = useHelpTopics()
  const visibleIds = useMemo(() => new Set(topics.map((topic) => topic.id)), [topics])
  const pageTopic = topicForPath(topics, pathname)
  const [selectedId, setSelectedId] = useState<string>(pageTopic?.id ?? GENERAL_TOPIC_ID)
  const [query, setQuery] = useState('')
  const [browsing, setBrowsing] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const contentRef = useRef<HTMLDivElement>(null)

  useDialogBehavior(panelRef, onClose, 'input[type="search"]')

  const selected = topics.find((topic) => topic.id === selectedId) ?? topics.find((topic) => topic.id === GENERAL_TOPIC_ID) ?? null
  const results = query.trim() ? searchTopics(topics, query) : null

  function open(id: string) {
    setSelectedId(id)
    setQuery('')
    setBrowsing(false)
    contentRef.current?.scrollTo?.({ top: 0 })
  }

  const target = selected ? pageLink(selected) : null
  const onTargetPage = target !== null && (pathname === target || pathname.startsWith(target + '/'))

  return createPortal(
    <div className="fixed inset-0 z-[100] flex justify-end">
      <div className="login-fade fixed inset-0 bg-slate-900/25 backdrop-blur-[2px]" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative flex h-full w-full flex-col bg-white shadow-2xl outline-none sm:max-w-md lg:max-w-lg"
      >
        <div className="app-modal-header relative shrink-0 px-4 pb-3 pt-4 sm:px-5">
          <div className="flex items-center gap-3">
            <span className="app-modal-logo flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="h-5 w-5 text-[#0f5f98]" fill="none" stroke="currentColor" strokeWidth="1.9">
                <circle cx="12" cy="12" r="9" />
                <path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6M12 17h.01" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="app-modal-title text-lg font-bold leading-tight">
                Help
              </h2>
              <p className="app-modal-sub truncate text-xs font-medium">{pageTopic ? `This page: ${pageTopic.title}` : 'STSLEV AMC user guide'}</p>
            </div>
            <button type="button" onClick={onClose} aria-label="Close help" className="app-modal-x group shrink-0 rounded-full p-2 transition-all">
              <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <label className="mt-3 block">
            <span className="sr-only">Search help</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search help (e.g. Regenerate, Paid, renewal)"
              className="block w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-[#1479BD] focus:outline-none focus:ring-4 focus:ring-sky-200/60"
            />
          </label>
          <span className="app-modal-edge absolute inset-x-0 bottom-0 h-[3px]" aria-hidden="true" />
        </div>

        <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          {results ? (
            <div aria-live="polite">
              <p className="mb-2 text-xs text-slate-500">
                {results.length === 0 ? 'No help topic matches your search.' : `${results.length} topic${results.length === 1 ? '' : 's'} found`}
              </p>
              <TopicList topics={results} onOpen={open} />
            </div>
          ) : browsing || !selected ? (
            <TopicList topics={topics} onOpen={open} currentId={selected?.id} />
          ) : (
            <HelpArticle topic={selected} visibleIds={visibleIds} onOpenTopic={open} compact />
          )}
        </div>

        <div className="app-modal-footer flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-sm sm:px-5">
          {!results && (
            <button type="button" onClick={() => setBrowsing((value) => !value)} className="font-semibold text-[#0f62a3] hover:underline">
              {browsing ? 'Back to topic' : 'All topics'}
            </button>
          )}
          {selected && !browsing && !results && target && !onTargetPage && (
            <Link to={target} onClick={onClose} className="font-semibold text-[#0f62a3] hover:underline">
              Go to {selected.title}
            </Link>
          )}
          <Link to={selected ? `/help/${selected.id}` : '/help'} onClick={onClose} className="ml-auto font-semibold text-[#0f62a3] hover:underline">
            Open full user guide
          </Link>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** The Help button in the header. */
export function HelpButton() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Help for this page"
        aria-haspopup="dialog"
        title="Help"
        className="shrink-0 rounded-full p-2 text-slate-600 transition-colors hover:bg-sky-50"
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6M12 17h.01" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && <HelpPanel onClose={() => setOpen(false)} />}
    </>
  )
}

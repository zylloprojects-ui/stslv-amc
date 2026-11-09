import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Card, PageHeader } from '../../components/ui'
import { HelpArticle } from '../../help/HelpArticle'
import { pageLink, searchTopics } from '../../help/helpModel'
import { GENERAL_TOPIC_ID, groupTopics } from '../../help/HelpPanel'
import { useHelpTopics } from '../../help/useHelpTopics'

/**
 * The user guide inside the application: every topic the user may read, with a topic list
 * (a drop-down on narrow screens) and search. /help/<topic id> opens one topic.
 */
export function HelpPage() {
  const { topicId } = useParams()
  const navigate = useNavigate()
  const topics = useHelpTopics()
  const visibleIds = useMemo(() => new Set(topics.map((topic) => topic.id)), [topics])
  const [query, setQuery] = useState('')
  const id = topicId ?? GENERAL_TOPIC_ID
  const topic = topics.find((candidate) => candidate.id === id) ?? null
  const shown = query.trim() ? searchTopics(topics, query) : topics
  const target = topic ? pageLink(topic) : null

  return (
    <>
      <PageHeader title="Help & User Guide" description="How each page works, what its statuses mean, and the everyday workflows" />

      <div className="grid gap-5 lg:grid-cols-[18rem_1fr]">
        <nav aria-label="Help topics" className="space-y-3">
          <label className="block">
            <span className="sr-only">Search help</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search help"
              className="block w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-[#1479BD] focus:outline-none focus:ring-4 focus:ring-sky-200/60"
            />
          </label>

          {/* Narrow screens: one drop-down instead of the long list. */}
          <label className="block lg:hidden">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-500">Topic</span>
            <select
              value={topic?.id ?? ''}
              onChange={(event) => navigate(`/help/${event.target.value}`)}
              className="block w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
            >
              {!topic && <option value="">Choose a topic</option>}
              {groupTopics(shown).map(({ group, topics: inGroup }) => (
                <optgroup key={group} label={group}>
                  {inGroup.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.title}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          <Card className="hidden p-3 lg:block">
            {shown.length === 0 ? (
              <p className="px-1 py-2 text-sm text-slate-500">No help topic matches your search.</p>
            ) : (
              <div className="space-y-4">
                {groupTopics(shown).map(({ group, topics: inGroup }) => (
                  <section key={group}>
                    <h2 className="mb-1 px-1 text-xs font-semibold uppercase tracking-wider text-slate-500">{group}</h2>
                    <ul className="space-y-0.5">
                      {inGroup.map((entry) => (
                        <li key={entry.id}>
                          <Link
                            to={`/help/${entry.id}`}
                            aria-current={entry.id === topic?.id ? 'page' : undefined}
                            className="block rounded-lg px-2.5 py-1.5 text-sm text-slate-700 hover:bg-sky-50 aria-[current=page]:bg-sky-100 aria-[current=page]:font-semibold aria-[current=page]:text-[#0b5d8f]"
                          >
                            {entry.title}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </Card>
        </nav>

        <Card className="min-w-0 p-5 sm:p-7">
          {topic ? (
            <>
              <HelpArticle topic={topic} visibleIds={visibleIds} />
              {target && (
                <p className="mt-6 border-t border-slate-100 pt-4 text-sm">
                  <Link to={target} className="font-semibold text-[#0f62a3] hover:underline">
                    Go to {topic.title}
                  </Link>
                </p>
              )}
            </>
          ) : (
            <div className="py-8 text-center">
              <h2 className="text-lg font-semibold text-slate-900">Help topic not available</h2>
              <p className="mt-2 text-sm text-slate-600">This topic does not exist, or it covers a page your role cannot open.</p>
              <Link to="/help" className="mt-4 inline-block text-sm font-semibold text-[#0f62a3] hover:underline">
                Back to Help
              </Link>
            </div>
          )}
        </Card>
      </div>
    </>
  )
}

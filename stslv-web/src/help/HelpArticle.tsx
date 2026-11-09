import { Link } from 'react-router-dom'
import { cx } from '../lib/format'
import type { HelpTopic } from './helpModel'
import { HELP_TOPICS } from './helpTopics'

const HEADING = 'text-sm font-bold uppercase tracking-wide text-[#0b3b66]'

/** One help topic: summary, then its sections. Links to related topics the reader may open. */
export function HelpArticle({
  topic,
  visibleIds,
  onOpenTopic,
  compact = false,
}: {
  topic: HelpTopic
  /** Ids of the topics the reader may open; related topics outside it are not offered. */
  visibleIds: ReadonlySet<string>
  /** In the drawer, related topics open in place; on the Help page they are links. */
  onOpenTopic?: (id: string) => void
  compact?: boolean
}) {
  const related = (topic.related ?? []).filter((id) => visibleIds.has(id))

  return (
    <article aria-labelledby={`help-${topic.id}-title`} className="space-y-5 text-sm leading-relaxed text-slate-700">
      <header>
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{topic.group}</p>
        <h2 id={`help-${topic.id}-title`} className={cx('font-bold tracking-tight text-slate-900', compact ? 'text-lg' : 'text-2xl')}>
          {topic.title}
        </h2>
        <p className="mt-1.5 text-slate-600">{topic.summary}</p>
      </header>

      {topic.sections.map((section) => (
        <section key={section.heading} className="space-y-2">
          <h3 className={HEADING}>{section.heading}</h3>
          {section.text?.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
          {section.steps && (
            <ol className="list-decimal space-y-1 pl-5 marker:font-semibold marker:text-slate-500">
              {section.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          )}
          {section.bullets && (
            <ul className="list-disc space-y-1 pl-5 marker:text-slate-400">
              {section.bullets.map((bullet) => (
                <li key={bullet}>{bullet}</li>
              ))}
            </ul>
          )}
          {section.terms && (
            <dl className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200">
              {section.terms.map((term) => (
                <div key={term.term} className="grid gap-0.5 px-3 py-2 sm:grid-cols-[minmax(8rem,30%)_1fr] sm:gap-3">
                  <dt className="font-semibold text-slate-900">{term.term}</dt>
                  <dd>{term.meaning}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      ))}

      {related.length > 0 && (
        <section className="space-y-2">
          <h3 className={HEADING}>Related topics</h3>
          <ul className="flex flex-wrap gap-2">
            {related.map((id) => (
              <li key={id}>
                {onOpenTopic ? (
                  <button
                    type="button"
                    onClick={() => onOpenTopic(id)}
                    className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-semibold text-[#0b5d8f] hover:bg-sky-100"
                  >
                    {titleOf(id)}
                  </button>
                ) : (
                  <Link to={`/help/${id}`} className="inline-block rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-semibold text-[#0b5d8f] hover:bg-sky-100">
                    {titleOf(id)}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  )
}

function titleOf(id: string): string {
  return HELP_TOPICS.find((topic) => topic.id === id)?.title ?? id
}

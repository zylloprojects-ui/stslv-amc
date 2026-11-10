import { NAVIGATION, navItemVisible } from '../layout/navigation'
import type { Module } from '../lib/types'

/** One block of a help article. */
export interface HelpSection {
  heading: string
  /** Plain paragraphs. */
  text?: string[]
  /** A numbered procedure. */
  steps?: string[]
  /** A bulleted list. */
  bullets?: string[]
  /** Label / meaning pairs, for fields, columns, statuses and colours. */
  terms?: { term: string; meaning: string }[]
}

/** Who may read a topic. Help never shows a topic for a page the user cannot open. */
export type HelpAccess =
  /** Every signed-in user. */
  | { kind: 'everyone' }
  /** Exactly the users the sidebar offers this page to (the same rule, so the two never differ). */
  | { kind: 'nav'; path: string }
  /** Users holding View on the module (pages outside the sidebar, such as Contract 360). */
  | { kind: 'module'; module: Module }
  /** Users holding View on at least one of the modules (a hub page such as the Master Data Center). */
  | { kind: 'anyModule'; modules: Module[] }
  /** Super Admin and Admin only. */
  | { kind: 'admin' }

/** Help groups follow the sidebar order approved by the client (2026-11-10). 'AMC' holds the top-level AMC pages. */
export type HelpGroup =
  | 'Getting started'
  | 'AMC'
  | 'AMC Execution'
  | 'Accounts'
  | 'AMC Sales'
  | 'Master Data Center'
  | 'Reports'
  | 'Administration'

export const HELP_GROUPS: HelpGroup[] = ['Getting started', 'AMC', 'AMC Execution', 'Accounts', 'AMC Sales', 'Master Data Center', 'Reports', 'Administration']

export interface HelpTopic {
  /** Stable id, used in the address /help/<id>. */
  id: string
  title: string
  group: HelpGroup
  access: HelpAccess
  /**
   * The application pages this topic explains, as route patterns (":id" matches one segment).
   * The first is offered as "Go to page". Help opened on one of them starts on this topic.
   */
  pages: string[]
  /** One or two sentences: what the page is for. */
  summary: string
  sections: HelpSection[]
  /** Other topic ids worth reading next. */
  related?: string[]
  /** The heading of the matching chapter in docs/user-guide/USER_GUIDE.md (checked by a test). */
  guideChapter: string
}

export interface HelpViewer {
  can: (module: Module, action: 'VIEW') => boolean
  canRead: (module: Module) => boolean
  isAdmin: boolean
}

const NAV_ITEMS = NAVIGATION.flatMap((section) => section.items)

/** Whether the signed-in user may read the topic. A convenience only: the pages and the API enforce access. */
export function helpTopicVisible(topic: HelpTopic, viewer: HelpViewer): boolean {
  const access = topic.access

  switch (access.kind) {
    case 'everyone':
      return true
    case 'admin':
      return viewer.isAdmin
    case 'module':
      return viewer.can(access.module, 'VIEW')
    case 'anyModule':
      return access.modules.some((module) => viewer.can(module, 'VIEW'))
    case 'nav': {
      const item = NAV_ITEMS.find((candidate) => candidate.path === access.path)
      // A topic tied to a page that is no longer in the navigation is never shown (a test keeps them in step).
      return item ? navItemVisible(item, viewer.can, viewer.isAdmin, viewer.canRead) : false
    }
  }
}

function segments(path: string): string[] {
  return path.split('/').filter(Boolean)
}

/**
 * How well a route pattern matches the address, or -1. An exact match scores higher than a
 * match of a parent page, and a literal segment higher than a ":param" segment.
 */
export function matchScore(pattern: string, pathname: string): number {
  const want = segments(pattern)
  const have = segments(pathname)

  if (want.length > have.length) {
    return -1
  }

  let score = 0

  for (let index = 0; index < want.length; index += 1) {
    if (want[index].startsWith(':')) {
      score += 1
    } else if (want[index] === have[index]) {
      score += 2
    } else {
      return -1
    }
  }

  // A parent page still matches its sub-pages, but less well than an exact pattern.
  return want.length === have.length ? score * 10 + 5 : score * 10
}

/** The topic for the page being shown, among the topics given (usually the visible ones). */
export function topicForPath(topics: readonly HelpTopic[], pathname: string): HelpTopic | null {
  let best: HelpTopic | null = null
  let bestScore = 0

  for (const topic of topics) {
    for (const page of topic.pages) {
      const score = matchScore(page, pathname)

      if (score > bestScore) {
        best = topic
        bestScore = score
      }
    }
  }

  return best
}

/** All the words of a topic, lower-cased, for the help search. */
function topicText(topic: HelpTopic): string {
  return [
    topic.title,
    topic.summary,
    ...topic.sections.flatMap((section) => [
      section.heading,
      ...(section.text ?? []),
      ...(section.steps ?? []),
      ...(section.bullets ?? []),
      ...(section.terms ?? []).flatMap((term) => [term.term, term.meaning]),
    ]),
  ]
    .join(' ')
    .toLowerCase()
}

/** Topics containing every word of the query; title matches first. */
export function searchTopics(topics: readonly HelpTopic[], query: string): HelpTopic[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)

  if (words.length === 0) {
    return [...topics]
  }

  const matches = topics.filter((topic) => {
    const text = topicText(topic)
    return words.every((word) => text.includes(word))
  })
  const inTitle = (topic: HelpTopic) => words.every((word) => topic.title.toLowerCase().includes(word))

  return [...matches.filter(inTitle), ...matches.filter((topic) => !inTitle(topic))]
}

/** The address of a topic's own page, for a concrete route pattern; null for a pattern with parameters. */
export function pageLink(topic: HelpTopic): string | null {
  const first = topic.pages[0]
  return first && !first.includes(':') ? first : null
}
